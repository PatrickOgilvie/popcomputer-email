import { DateTime, Effect, Option, Schema } from "effect"
import {
  PlatformDomainRegistry,
  PlatformDomainUnavailable,
  type PlatformDomain,
} from "../../adapters/platform-domain-registry.js"
import {
  RouteAddressConflict,
  RouteAdminStore,
  RouteAdminStoreFailure,
  RouteStoreTransitionConflict,
  type ReserveRouteInput,
  type ReserveRouteResult,
  type RotateRouteInput,
  type StoredRoute,
  type TransitionRouteInput,
} from "../../adapters/route-admin-store.js"
import {
  RouteStore,
  RouteStoreFailure,
  type RouteStoreOperation,
} from "../../adapters/route-store.js"
import { EmailDomainSchema } from "../../core/address.js"
import {
  IdempotencyKeySchema,
  RequestFingerprintSchema,
  RouteIdSchema,
} from "../../core/identifiers.js"
import {
  isActive,
  isDisabled,
  isSender,
  RouteSchema,
  type Route,
} from "../../core/route.js"
import type { Environment, Scope } from "../../core/scope.js"
import type {
  D1Database,
  D1ExecutionResult,
  D1PreparedStatement,
} from "./contract.js"

const DomainsTable = "popcomputer_email_domains"
const RoutesTable = "popcomputer_email_routes"

const RouteProjection = `
  id,
  namespace,
  environment,
  domain_id,
  address,
  local_part,
  local_part_normalized,
  mailbox_handle,
  inbound_kind,
  workflow_id,
  outbound_kind,
  sender_role,
  metadata_json,
  status,
  creation_idempotency_key,
  creation_fingerprint,
  rotation_idempotency_key,
  rotation_fingerprint,
  rotation_replacement_id,
  actor_kind,
  actor_id,
  revision,
  created_at,
  updated_at,
  disabled_at`

const EpochMillisSchema = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
)

const DomainRowSchema = Schema.Struct({
  id: Schema.String,
  domain: Schema.String,
  environment: Schema.String,
})

const RouteRowSchema = Schema.Struct({
  id: Schema.String,
  namespace: Schema.String,
  environment: Schema.String,
  domain_id: Schema.String,
  address: Schema.String,
  local_part: Schema.String,
  local_part_normalized: Schema.String,
  mailbox_handle: Schema.String,
  inbound_kind: Schema.String,
  workflow_id: Schema.NullOr(Schema.String),
  outbound_kind: Schema.String,
  sender_role: Schema.NullOr(Schema.String),
  metadata_json: Schema.NullOr(Schema.String),
  status: Schema.String,
  creation_idempotency_key: Schema.NullOr(Schema.String),
  creation_fingerprint: Schema.NullOr(Schema.String),
  rotation_idempotency_key: Schema.NullOr(Schema.String),
  rotation_fingerprint: Schema.NullOr(Schema.String),
  rotation_replacement_id: Schema.NullOr(Schema.String),
  actor_kind: Schema.String,
  actor_id: Schema.String,
  revision: Schema.Number,
  created_at: EpochMillisSchema,
  updated_at: EpochMillisSchema,
  disabled_at: Schema.NullOr(EpochMillisSchema),
})

const ChangesSchema = Schema.Struct({
  meta: Schema.Struct({
    changes: Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  }),
})

type RouteRow = typeof RouteRowSchema.Type

const routeStoreFailure = (
  operation: RouteStoreOperation,
): RouteStoreFailure => new RouteStoreFailure({
  operation,
  reason: "unavailable",
})

const adminFailure = (
  operation: RouteAdminStoreFailure["operation"],
): RouteAdminStoreFailure => new RouteAdminStoreFailure({
  operation,
  reason: "unavailable",
})

const readFirst = <E>(
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  onError: () => E,
): Effect.Effect<unknown | null, E> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).first<unknown>(),
    catch: onError,
  })

const readAll = <E>(
  database: D1Database,
  query: string,
  values: ReadonlyArray<unknown>,
  onError: () => E,
): Effect.Effect<ReadonlyArray<unknown>, E> =>
  Effect.tryPromise({
    try: () => database.prepare(query).bind(...values).all<unknown>(),
    catch: onError,
  }).pipe(Effect.map((result) => result.results))

const run = <E>(
  statement: D1PreparedStatement,
  onError: () => E,
): Effect.Effect<D1ExecutionResult<unknown>, E> =>
  Effect.tryPromise({
    try: () => statement.run<unknown>(),
    catch: onError,
  })

const batch = <E>(
  database: D1Database,
  statements: Array<D1PreparedStatement>,
  onError: () => E,
): Effect.Effect<Array<D1ExecutionResult<unknown>>, E> =>
  Effect.tryPromise({
    try: () => database.batch(statements),
    catch: onError,
  })

const changes = <E>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 execution metadata is decoded immediately at this persistence boundary.
  result: unknown,
  onError: () => E,
): Effect.Effect<number, E> =>
  Schema.decodeUnknownEffect(ChangesSchema)(result).pipe(
    Effect.map((decoded) => decoded.meta.changes),
    Effect.mapError(onError),
  )

const actorTag = (
  kind: string,
): "User" | "Credential" | "System" | undefined => {
  switch (kind) {
    case "user":
      return "User"
    case "credential":
      return "Credential"
    case "system":
      return "System"
    default:
      return undefined
  }
}

const actorKind = (
  actor: ReserveRouteInput["actor"],
): "user" | "credential" | "system" => {
  switch (actor._tag) {
    case "User":
      return "user"
    case "Credential":
      return "credential"
    case "System":
      return "system"
  }
}

const decodeRouteRow = <E>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- D1 rows are untrusted and decoded immediately with the complete persisted projection.
  input: unknown,
  onError: () => E,
): Effect.Effect<RouteRow, E> =>
  Schema.decodeUnknownEffect(RouteRowSchema)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(onError))

const decodeRoute = <E>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The untrusted D1 row is decoded before any domain route is constructed.
  input: unknown,
  onError: () => E,
): Effect.Effect<Route, E> =>
  Effect.gen(function*() {
    const row = yield* decodeRouteRow(input, onError)
    const actor = actorTag(row.actor_kind)
    const hasNoRotationWinner = row.rotation_idempotency_key === null &&
      row.rotation_fingerprint === null &&
      row.rotation_replacement_id === null
    const hasCompleteRotationWinner = row.rotation_idempotency_key !== null &&
      row.rotation_fingerprint !== null &&
      row.rotation_replacement_id !== null &&
      row.status === "disabled"
    const lifecycle = row.status === "active" && row.disabled_at === null
      ? { _tag: "Active" as const }
      : row.status === "paused" && row.disabled_at === null
      ? {
          _tag: "Paused" as const,
          pausedAt: DateTime.makeUnsafe(row.updated_at),
        }
      : row.status === "disabled" && row.disabled_at !== null
      ? {
          _tag: "Disabled" as const,
          disabledAt: DateTime.makeUnsafe(row.disabled_at),
        }
      : undefined
    if (
      actor === undefined ||
      lifecycle === undefined ||
      row.local_part !== row.mailbox_handle ||
      row.local_part_normalized !== row.mailbox_handle ||
      (row.creation_idempotency_key === null) !==
        (row.creation_fingerprint === null) ||
      (!hasNoRotationWinner && !hasCompleteRotationWinner)
    ) {
      return yield* Effect.fail(onError())
    }

    const shared = {
      id: row.id,
      scope: {
        namespace: row.namespace,
        environment: row.environment,
      },
      address: row.address,
      mailboxHandle: row.mailbox_handle,
      lifecycle,
      revision: row.revision,
      actor: { _tag: actor, id: row.actor_id },
      createdAt: DateTime.makeUnsafe(row.created_at),
      updatedAt: DateTime.makeUnsafe(row.updated_at),
    }
    const inbound = row.inbound_kind === "store" && row.workflow_id === null
      ? { _tag: "Store" as const }
      : row.inbound_kind === "trigger" && row.workflow_id !== null
      ? {
          _tag: "Trigger" as const,
          workflowId: row.workflow_id,
        }
      : undefined
    const outbound = row.outbound_kind === "disabled" &&
        row.sender_role === null
      ? { _tag: "Disabled" as const }
      : row.outbound_kind === "sender" &&
          (row.sender_role === "default" || row.sender_role === "alternate")
      ? { _tag: "Sender" as const, role: row.sender_role }
      : undefined
    if (inbound === undefined || outbound === undefined) {
      return yield* Effect.fail(onError())
    }
    const candidate = { ...shared, inbound, outbound }
    return yield* Schema.decodeUnknownEffect(RouteSchema)(candidate, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(onError))
  })

const decodeStoredRoute = <E>(
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The full stored row and fingerprint are decoded together at the adapter boundary.
  input: unknown,
  onError: () => E,
): Effect.Effect<StoredRoute, E> =>
  Effect.gen(function*() {
    const row = yield* decodeRouteRow(input, onError)
    if (row.creation_fingerprint === null) {
      return yield* Effect.fail(onError())
    }
    const route = yield* decodeRoute(row, onError)
    const creationFingerprint = yield* Schema.decodeUnknownEffect(
      RequestFingerprintSchema,
    )(row.creation_fingerprint).pipe(Effect.mapError(onError))
    return { route, creationFingerprint }
  })

const decodeDomain = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The registry projection is parsed before it becomes a platform domain.
  input: unknown,
  environment: Environment,
): Effect.Effect<PlatformDomain, PlatformDomainUnavailable> =>
  Schema.decodeUnknownEffect(DomainRowSchema)(input, {
    onExcessProperty: "error",
  }).pipe(
    Effect.flatMap((row) =>
      row.environment === environment
        ? Schema.decodeUnknownEffect(EmailDomainSchema)(row.domain).pipe(
            Effect.map((domain) => ({ id: row.id, domain, environment })),
            Effect.mapError(() => new PlatformDomainUnavailable({
              environment,
              reason: "unavailable",
            })),
          )
        : Effect.fail(new PlatformDomainUnavailable({
            environment,
            reason: "unavailable",
          })),
    ),
    Effect.mapError(() => new PlatformDomainUnavailable({
      environment,
      reason: "unavailable",
    })),
  )

const routeById = <E>(
  database: D1Database,
  scope: Scope,
  routeId: string,
  onError: () => E,
): Effect.Effect<Option.Option<Route>, E> =>
  Effect.gen(function*() {
    const row = yield* readFirst(
      database,
      `SELECT ${RouteProjection}
       FROM ${RoutesTable}
       WHERE namespace = ?1 AND environment = ?2 AND id = ?3
       LIMIT 1`,
      [scope.namespace, scope.environment, routeId],
      onError,
    )
    return row === null
      ? Option.none()
      : Option.some(yield* decodeRoute(row, onError))
  })

const storedByIdempotency = (
  database: D1Database,
  scope: Scope,
  key: string,
  operation: RouteAdminStoreFailure["operation"],
): Effect.Effect<Option.Option<StoredRoute>, RouteAdminStoreFailure> =>
  Effect.gen(function*() {
    const onError = () => adminFailure(operation)
    const row = yield* readFirst(
      database,
      `SELECT ${RouteProjection}
       FROM ${RoutesTable}
       WHERE namespace = ?1
         AND environment = ?2
         AND creation_idempotency_key = ?3
       LIMIT 1`,
      [scope.namespace, scope.environment, key],
      onError,
    )
    return row === null
      ? Option.none()
      : Option.some(yield* decodeStoredRoute(row, onError))
  })

const routeInsert = (
  database: D1Database,
  input: ReserveRouteInput,
  guard?: {
    readonly previousId: string
    readonly previousRevision: number
  },
): D1PreparedStatement => {
  const workflowId = input.inbound._tag === "Trigger"
    ? input.inbound.workflowId
    : null
  const inboundKind = input.inbound._tag === "Trigger" ? "trigger" : "store"
  const outboundKind = input.outbound._tag === "Sender" ? "sender" : "disabled"
  const senderRole = input.outbound._tag === "Sender"
    ? input.outbound.role
    : null
  const createdAt = DateTime.toEpochMillis(input.createdAt)
  const guardSql = guard === undefined
    ? ""
    : `WHERE EXISTS (
         SELECT 1 FROM ${RoutesTable}
         WHERE id = ?19
           AND namespace = ?20
           AND environment = ?21
           AND status = 'disabled'
           AND revision = ?22
           AND rotation_idempotency_key = ?13
           AND rotation_fingerprint = ?14
           AND rotation_replacement_id = ?1
       )`
  const values: Array<unknown> = [
    input.id,
    input.scope.namespace,
    input.scope.environment,
    input.domainId,
    input.address,
    input.mailboxHandle,
    input.mailboxHandle,
    input.mailboxHandle,
    inboundKind,
    workflowId,
    outboundKind,
    senderRole,
    input.idempotencyKey,
    input.creationFingerprint,
    actorKind(input.actor),
    input.actor.id,
    createdAt,
    createdAt,
  ]
  if (guard !== undefined) {
    values.push(
      guard.previousId,
      input.scope.namespace,
      input.scope.environment,
      guard.previousRevision,
    )
  }
  return database.prepare(
    `INSERT INTO ${RoutesTable} (
       id, namespace, environment, domain_id, address, local_part,
       local_part_normalized, mailbox_handle, inbound_kind, workflow_id,
       outbound_kind, sender_role, metadata_json, status,
       creation_idempotency_key, creation_fingerprint, actor_kind, actor_id,
       revision, created_at, updated_at, disabled_at
     )
     SELECT
       ?1, ?2, ?3, ?4, ?5, ?6,
       ?7, ?8, ?9, ?10,
       ?11, ?12, NULL, 'active',
       ?13, ?14, ?15, ?16,
       1, ?17, ?18, NULL
     ${guardSql}`,
  ).bind(...values)
}

const addressExists = (
  database: D1Database,
  address: string,
  operation: RouteAdminStoreFailure["operation"],
): Effect.Effect<boolean, RouteAdminStoreFailure> =>
  readFirst(
    database,
    `SELECT id FROM ${RoutesTable} WHERE address = ?1 LIMIT 1`,
    [address],
    () => adminFailure(operation),
  ).pipe(Effect.map((row) => row !== null))

const reserve = (
  database: D1Database,
  input: ReserveRouteInput,
): Effect.Effect<
  ReserveRouteResult,
  RouteAddressConflict | RouteAdminStoreFailure
> =>
  Effect.gen(function*() {
    const existing = yield* storedByIdempotency(
      database,
      input.scope,
      input.idempotencyKey,
      "reserve",
    )
    if (Option.isSome(existing)) {
      return { _tag: "Existing", record: existing.value }
    }

    const attempted = yield* Effect.result(
      run(routeInsert(database, input), () => adminFailure("reserve")),
    )
    const replay = yield* storedByIdempotency(
      database,
      input.scope,
      input.idempotencyKey,
      "reserve",
    )
    if (Option.isSome(replay)) {
      return replay.value.route.id === input.id && attempted._tag === "Success"
        ? { _tag: "Created", record: replay.value }
        : { _tag: "Existing", record: replay.value }
    }
    if (yield* addressExists(database, input.address, "reserve")) {
      return yield* new RouteAddressConflict({
        reason: "already_reserved",
      })
    }
    return yield* Effect.fail(adminFailure("reserve"))
  })

const transition = (
  database: D1Database,
  input: TransitionRouteInput,
): Effect.Effect<
  Route,
  RouteAdminStoreFailure | RouteStoreTransitionConflict
> =>
  Effect.gen(function*() {
    const route = input.route
    if (
      route.scope.namespace !== input.scope.namespace ||
      route.scope.environment !== input.scope.environment ||
      route.revision !== input.expectedRevision + 1
    ) {
      return yield* new RouteStoreTransitionConflict({
        routeId: route.id,
        reason: "concurrent_update",
      })
    }
    const status = route.lifecycle._tag.toLowerCase()
    const disabledAt = route.lifecycle._tag === "Disabled"
      ? DateTime.toEpochMillis(route.lifecycle.disabledAt)
      : null
    const result = yield* run(
      database.prepare(
        `UPDATE ${RoutesTable}
         SET status = ?1,
             revision = ?2,
             updated_at = ?3,
             disabled_at = ?4
         WHERE namespace = ?5
           AND environment = ?6
           AND id = ?7
           AND revision = ?8
           AND status != 'disabled'`,
      ).bind(
        status,
        route.revision,
        DateTime.toEpochMillis(route.updatedAt),
        disabledAt,
        input.scope.namespace,
        input.scope.environment,
        route.id,
        input.expectedRevision,
      ),
      () => adminFailure("transition"),
    )
    if ((yield* changes(result, () => adminFailure("transition"))) !== 1) {
      return yield* new RouteStoreTransitionConflict({
        routeId: route.id,
        reason: "concurrent_update",
      })
    }
    const loaded = yield* routeById(
      database,
      input.scope,
      route.id,
      () => adminFailure("transition"),
    )
    return Option.isSome(loaded)
      ? loaded.value
      : yield* Effect.fail(adminFailure("transition"))
  })

const RotationWinnerRowSchema = Schema.Struct({
  rotation_idempotency_key: IdempotencyKeySchema,
  rotation_fingerprint: RequestFingerprintSchema,
  rotation_replacement_id: RouteIdSchema,
})

const rotationWinner = (
  database: D1Database,
  input: RotateRouteInput,
): Effect.Effect<typeof RotationWinnerRowSchema.Type, RouteAdminStoreFailure> =>
  Effect.gen(function*() {
    const row = yield* readFirst(
      database,
      `SELECT rotation_idempotency_key, rotation_fingerprint,
              rotation_replacement_id
       FROM ${RoutesTable}
       WHERE namespace = ?1 AND environment = ?2 AND id = ?3
       LIMIT 1`,
      [input.scope.namespace, input.scope.environment, input.previous.id],
      () => adminFailure("rotate"),
    )
    return yield* Schema.decodeUnknownEffect(RotationWinnerRowSchema)(row, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => adminFailure("rotate")))
  })

const loadRotated = (
  database: D1Database,
  input: RotateRouteInput,
): Effect.Effect<
  { readonly previous: import("../../core/route.js").DisabledRoute
    readonly replacement: import("../../core/route.js").ActiveRoute },
  RouteAdminStoreFailure | RouteStoreTransitionConflict
> =>
  Effect.gen(function*() {
    const previous = yield* routeById(
      database,
      input.scope,
      input.previous.id,
      () => adminFailure("rotate"),
    )
    const replacement = yield* storedByIdempotency(
      database,
      input.scope,
      input.replacement.idempotencyKey,
      "rotate",
    )
    const winner = yield* rotationWinner(database, input)
    if (
      Option.isNone(previous) ||
      Option.isNone(replacement) ||
      !isDisabled(previous.value) ||
      previous.value.revision !== input.previous.revision ||
      !isActive(replacement.value.route) ||
      winner.rotation_idempotency_key !== input.replacement.idempotencyKey ||
      winner.rotation_fingerprint !== input.replacement.creationFingerprint ||
      winner.rotation_replacement_id !== replacement.value.route.id ||
      replacement.value.creationFingerprint !==
        input.replacement.creationFingerprint
    ) {
      return yield* new RouteStoreTransitionConflict({
        routeId: input.previous.id,
        reason: "concurrent_update",
      })
    }
    return {
      previous: previous.value,
      replacement: replacement.value.route,
    }
  })

const rotate = (
  database: D1Database,
  input: RotateRouteInput,
): Effect.Effect<
  { readonly previous: import("../../core/route.js").DisabledRoute
    readonly replacement: import("../../core/route.js").ActiveRoute },
  RouteAddressConflict | RouteAdminStoreFailure | RouteStoreTransitionConflict
> =>
  Effect.gen(function*() {
    if (
      input.previous.scope.namespace !== input.scope.namespace ||
      input.previous.scope.environment !== input.scope.environment ||
      input.replacement.scope.namespace !== input.scope.namespace ||
      input.replacement.scope.environment !== input.scope.environment ||
      input.previous.lifecycle._tag !== "Disabled" ||
      input.previous.revision !== input.expectedRevision + 1
    ) {
      return yield* new RouteStoreTransitionConflict({
        routeId: input.previous.id,
        reason: "concurrent_update",
      })
    }
    const attempted = yield* Effect.result(batch(database, [
      database.prepare(
        `UPDATE ${RoutesTable}
         SET status = 'disabled', revision = ?1, updated_at = ?2,
             disabled_at = ?2,
             rotation_idempotency_key = ?3,
             rotation_fingerprint = ?4,
             rotation_replacement_id = ?5
         WHERE namespace = ?6 AND environment = ?7 AND id = ?8
           AND revision = ?9 AND status != 'disabled'
           AND rotation_idempotency_key IS NULL
           AND rotation_fingerprint IS NULL
           AND rotation_replacement_id IS NULL`,
      ).bind(
        input.previous.revision,
        DateTime.toEpochMillis(input.previous.lifecycle.disabledAt),
        input.replacement.idempotencyKey,
        input.replacement.creationFingerprint,
        input.replacement.id,
        input.scope.namespace,
        input.scope.environment,
        input.previous.id,
        input.expectedRevision,
      ),
      routeInsert(database, input.replacement, {
        previousId: input.previous.id,
        previousRevision: input.previous.revision,
      }),
    ], () => adminFailure("rotate")))

    const replay = yield* Effect.result(loadRotated(database, input))
    if (replay._tag === "Success") {
      return replay.success
    }
    if (yield* addressExists(database, input.replacement.address, "rotate")) {
      return yield* new RouteAddressConflict({
        reason: "already_reserved",
      })
    }
    if (attempted._tag === "Failure") {
      return yield* Effect.fail(attempted.failure)
    }
    return yield* new RouteStoreTransitionConflict({
      routeId: input.previous.id,
      reason: "concurrent_update",
    })
  })

/** Construct D1-backed domain, route-read, and route-administration ports. */
export const makeD1RouteStores = (database: D1Database) => ({
  platformDomainRegistry: PlatformDomainRegistry.of({
    requireActive: (environment) => Effect.gen(function*() {
      const row = yield* readFirst(
        database,
        `SELECT id, domain, environment
         FROM ${DomainsTable}
         WHERE kind = 'platform'
           AND environment = ?1
           AND inbound_status = 'active'
           AND outbound_status = 'active'
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [environment],
        () => new PlatformDomainUnavailable({
          environment,
          reason: "unavailable",
        }),
      )
      return row === null
        ? yield* new PlatformDomainUnavailable({
            environment,
            reason: "not_configured",
          })
        : yield* decodeDomain(row, environment)
    }),
    resolveInbound: (domain) => Effect.gen(function*() {
      const unavailable = () => new PlatformDomainUnavailable({
        environment: "live" as const,
        reason: "unavailable" as const,
      })
      const row = yield* readFirst(
        database,
        `SELECT id, domain, environment
         FROM ${DomainsTable}
         WHERE kind = 'platform' AND domain = ?1 AND inbound_status = 'active'
         ORDER BY environment ASC
         LIMIT 1`,
        [domain],
        unavailable,
      )
      if (row === null) {
        return yield* new PlatformDomainUnavailable({
          environment: "live",
          reason: "not_configured",
        })
      }
      const decoded = yield* Schema.decodeUnknownEffect(DomainRowSchema)(row, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(unavailable))
      const environment = decoded.environment === "test" ? "test" as const
        : decoded.environment === "live" ? "live" as const
        : undefined
      return environment === undefined
        ? yield* Effect.fail(unavailable())
        : yield* decodeDomain(row, environment)
    }),
  }),
  routeStore: RouteStore.of({
    findDefaultSender: (scope) => Effect.gen(function*() {
      const onError = () => routeStoreFailure("find_default_sender")
      const row = yield* readFirst(
        database,
        `SELECT ${RouteProjection}
         FROM ${RoutesTable}
         WHERE namespace = ?1 AND environment = ?2
           AND outbound_kind = 'sender' AND sender_role = 'default'
           AND status != 'disabled'
         LIMIT 1`,
        [scope.namespace, scope.environment],
        onError,
      )
      if (row === null) return Option.none()
      const route = yield* decodeRoute(row, onError)
      return isSender(route)
        ? Option.some(route)
        : yield* Effect.fail(onError())
    }),
    findById: (scope, routeId) => routeById(
      database,
      scope,
      routeId,
      () => routeStoreFailure("find_by_id"),
    ),
    findByInboundAddress: (address) => Effect.gen(function*() {
      const onError = () => routeStoreFailure("find_by_inbound_address")
      const row = yield* readFirst(
        database,
        `SELECT ${RouteProjection}
         FROM ${RoutesTable}
         WHERE address = ?1
         LIMIT 1`,
        [address],
        onError,
      )
      return row === null
        ? Option.none()
        : Option.some(yield* decodeRoute(row, onError))
    }),
  }),
  routeAdminStore: RouteAdminStore.of({
    findByIdempotency: (scope, key) =>
      storedByIdempotency(database, scope, key, "find_idempotency"),
    reserve: (input) => reserve(database, input),
    list: (scope) => Effect.gen(function*() {
      const onError = () => adminFailure("list")
      const rows = yield* readAll(
        database,
        `SELECT ${RouteProjection}
         FROM ${RoutesTable}
         WHERE namespace = ?1 AND environment = ?2
         ORDER BY created_at ASC, id ASC`,
        [scope.namespace, scope.environment],
        onError,
      )
      return yield* Effect.forEach(rows, (row) => decodeRoute(row, onError))
    }),
    transition: (input) => transition(database, input),
    rotate: (input) => rotate(database, input),
  }),
})
