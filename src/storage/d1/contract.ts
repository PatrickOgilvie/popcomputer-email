/** Metadata returned by a Cloudflare D1 statement execution. */
export interface D1ExecutionMeta {
  readonly changes: number
  readonly rows_read?: number
  readonly rows_written?: number
  readonly duration?: number
}

/** Scalar value representable in one D1 result column. */
export type D1Value = null | string | number | boolean | ArrayBuffer

/** Runtime-neutral D1 result row used as the default generic projection. */
export interface D1Row {
  readonly [column: string]: D1Value
}

/** Result returned by a Cloudflare D1 statement execution. */
export interface D1ExecutionResult<Row = D1Row> {
  readonly success?: boolean
  readonly results: ReadonlyArray<Row>
  readonly meta: D1ExecutionMeta
}

/**
 * Structural subset of a Cloudflare D1 prepared statement used by the email
 * adapters. Keeping this structural avoids ambient Worker types for consumers.
 */
export interface D1PreparedStatement {
  readonly bind: (...values: Array<unknown>) => D1PreparedStatement
  readonly first: <Row = D1Row>() => Promise<Row | null>
  readonly all: <Row = D1Row>() => Promise<D1ExecutionResult<Row>>
  readonly run: <Row = D1Row>() => Promise<D1ExecutionResult<Row>>
}

/** Structural subset of a Cloudflare D1 database used by the email package. */
export interface D1Database {
  readonly prepare: (query: string) => D1PreparedStatement
  readonly batch: <Row = D1Row>(
    statements: Array<D1PreparedStatement>,
  ) => Promise<Array<D1ExecutionResult<Row>>>
}
