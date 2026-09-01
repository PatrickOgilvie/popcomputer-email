import type {
  D1Database,
  D1ExecutionResult,
  D1PreparedStatement,
  D1Row,
} from "./contract.js"

/**
 * Structural result shape implemented by Cloudflare's ambient D1 binding.
 * This keeps `@cloudflare/workers-types` out of the package runtime surface.
 */
export interface CloudflareD1Result<Row = D1Row> {
  readonly success: true
  readonly results: Array<Row>
  readonly meta: {
    readonly changes: number
    readonly size_after: number
    readonly last_row_id: number
    readonly changed_db: boolean
    readonly rows_read: number
    readonly rows_written: number
    readonly duration: number
  }
}

/** Structural prepared statement including Cloudflare's `raw` member. */
export interface CloudflareD1PreparedStatement {
  readonly bind: (...values: Array<unknown>) => CloudflareD1PreparedStatement
  readonly first: <Row = unknown>() => Promise<Row | null>
  readonly all: <Row = Record<string, never>>() => Promise<
    CloudflareD1Result<Row>
  >
  readonly run: <Row = Record<string, never>>() => Promise<
    CloudflareD1Result<Row>
  >
  readonly raw: {
    <Row = ReadonlyArray<unknown>>(
      options: { readonly columnNames: true },
    ): Promise<[Array<string>, ...Array<Row>]>
    <Row = ReadonlyArray<unknown>>(
      options?: { readonly columnNames?: false },
    ): Promise<Array<Row>>
  }
}

/** Structural database shape accepted directly from a Workers environment. */
export interface CloudflareD1Database {
  readonly prepare: (query: string) => CloudflareD1PreparedStatement
  readonly batch: <Row = unknown>(
    statements: Array<CloudflareD1PreparedStatement>,
  ) => Promise<Array<CloudflareD1Result<Row>>>
}

const projectResult = <Row>(
  result: CloudflareD1Result<Row>,
): D1ExecutionResult<Row> => ({
  success: result.success,
  results: result.results,
  meta: {
    changes: result.meta.changes,
    rows_read: result.meta.rows_read,
    rows_written: result.meta.rows_written,
    duration: result.meta.duration,
  },
})

/**
 * Adapt a real Cloudflare D1 binding to the runtime-neutral package contract.
 * Consumers can pass `env.MY_DATABASE` directly without a type assertion.
 */
export const fromCloudflareD1 = (
  database: CloudflareD1Database,
): D1Database => {
  const nativeStatements = new WeakMap<
    D1PreparedStatement,
    CloudflareD1PreparedStatement
  >()

  const wrap = (
    native: CloudflareD1PreparedStatement,
  ): D1PreparedStatement => {
    const wrapped: D1PreparedStatement = {
      bind: (...values) => wrap(native.bind(...values)),
      first: <Row = D1Row>() => native.first<Row>(),
      all: async <Row = D1Row>() => projectResult(await native.all<Row>()),
      run: async <Row = D1Row>() => projectResult(await native.run<Row>()),
    }
    nativeStatements.set(wrapped, native)
    return wrapped
  }

  return {
    prepare: (query) => wrap(database.prepare(query)),
    batch: async <Row = D1Row>(statements: Array<D1PreparedStatement>) => {
      const nativeBatch: Array<CloudflareD1PreparedStatement> = []
      for (const statement of statements) {
        const native = nativeStatements.get(statement)
        if (native === undefined) {
          throw new Error("D1 batch contains a statement from another binding")
        }
        nativeBatch.push(native)
      }
      const results = await database.batch<Row>(nativeBatch)
      return results.map(projectResult)
    },
  }
}
