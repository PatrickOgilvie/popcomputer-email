import { Effect, Layer, Option } from "effect"
import {
  PlatformDomainRegistry,
  PlatformDomainUnavailable,
  type PlatformDomain,
} from "../adapters/platform-domain-registry.js"
import {
  RouteAddressConflict,
  RouteAdminStore,
  RouteStoreTransitionConflict,
  type ReserveRouteInput,
  type StoredRoute,
} from "../adapters/route-admin-store.js"
import { RouteStore } from "../adapters/route-store.js"
import {
  RouteLifecycleSchema,
  RouteRevisionSchema,
  RouteSchema,
  isActive,
  isSender,
  type ActiveRoute,
  type DisabledRoute,
  type Route,
} from "../core/route.js"
import type { Scope } from "../core/scope.js"

const scopeKey = (scope: Scope): string =>
  `${scope.namespace}\u0000${scope.environment}`

const routeKey = (scope: Scope, id: string): string =>
  `${scopeKey(scope)}\u0000${id}`

const idempotencyKey = (scope: Scope, key: string): string =>
  `${scopeKey(scope)}\u0000${key}`

const buildRoute = (input: ReserveRouteInput): ActiveRoute => {
  const common = {
    id: input.id,
    scope: input.scope,
    address: input.address,
    mailboxHandle: input.mailboxHandle,
    lifecycle: RouteLifecycleSchema.cases.Active.make({}),
    revision: RouteRevisionSchema.make(1),
    actor: input.actor,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  }
  const route = RouteSchema.make({
    ...common,
    inbound: input.inbound,
    outbound: input.outbound,
  })
  if (!isActive(route)) {
    throw new Error("new in-memory route did not start active")
  }
  return route
}

/** Shared, inspectable in-memory route lookup and administration stores. */
export interface InMemoryRoutes {
  readonly routeStore: RouteStore["Service"]
  readonly adminStore: RouteAdminStore["Service"]
  readonly routes: ReadonlyArray<Route>
  readonly layer: Layer.Layer<RouteStore | RouteAdminStore>
}

/** Create isolated route stores whose writes are synchronous compare-and-set operations. */
export const makeInMemoryRoutes = (): InMemoryRoutes => {
  const byId = new Map<string, StoredRoute>()
  const byAddress = new Map<string, StoredRoute>()
  const byIdempotency = new Map<string, StoredRoute>()
  const rotations = new Map<string, {
    readonly idempotencyKey: string
    readonly creationFingerprint: string
    readonly previous: DisabledRoute
    readonly replacement: StoredRoute & { readonly route: ActiveRoute }
  }>()

  const save = (record: StoredRoute): void => {
    byId.set(routeKey(record.route.scope, record.route.id), record)
    byAddress.set(record.route.address, record)
  }

  const routeStore = RouteStore.of({
    findDefaultSender: (scope) => Effect.sync(() => {
      const found = Array.from(byId.values()).find((record) =>
        scopeKey(record.route.scope) === scopeKey(scope) &&
        record.route.outbound._tag === "Sender" &&
        record.route.outbound.role === "default" &&
        record.route.lifecycle._tag !== "Disabled")
      return found !== undefined && isSender(found.route)
        ? Option.some(found.route)
        : Option.none()
    }),
    findById: (scope, id) => Effect.sync(() => {
      const found = byId.get(routeKey(scope, id))
      return found === undefined ? Option.none() : Option.some(found.route)
    }),
    findByInboundAddress: (address) => Effect.sync(() => {
      const found = byAddress.get(address)
      return found === undefined ? Option.none() : Option.some(found.route)
    }),
  })

  const adminStore = RouteAdminStore.of({
    findByIdempotency: (scope, key) => Effect.sync(() => {
      const found = byIdempotency.get(idempotencyKey(scope, key))
      return found === undefined ? Option.none() : Option.some(found)
    }),
    reserve: (input) => Effect.gen(function*() {
      const replay = byIdempotency.get(
        idempotencyKey(input.scope, input.idempotencyKey),
      )
      if (replay !== undefined) {
        return { _tag: "Existing" as const, record: replay }
      }
      if (byAddress.has(input.address)) {
        return yield* new RouteAddressConflict({
          reason: "already_reserved",
        })
      }
      if (
        input.outbound._tag === "Sender" &&
        input.outbound.role === "default" &&
        Array.from(byId.values()).some((record) =>
          scopeKey(record.route.scope) === scopeKey(input.scope) &&
          record.route.outbound._tag === "Sender" &&
          record.route.outbound.role === "default" &&
          record.route.lifecycle._tag !== "Disabled")
      ) {
        return yield* new RouteAddressConflict({
          reason: "already_reserved",
        })
      }
      const record: StoredRoute = {
        route: buildRoute(input),
        creationFingerprint: input.creationFingerprint,
      }
      save(record)
      byIdempotency.set(
        idempotencyKey(input.scope, input.idempotencyKey),
        record,
      )
      return { _tag: "Created" as const, record }
    }),
    list: (scope) => Effect.sync(() =>
      Array.from(byId.values())
        .map((record) => record.route)
        .filter((route) => scopeKey(route.scope) === scopeKey(scope))
        .sort((left, right) => left.createdAt.pipe(
          (createdAt) => createdAt.toString().localeCompare(right.createdAt.toString()),
        ))),
    transition: (input) => Effect.gen(function*() {
      const key = routeKey(input.scope, input.route.id)
      const current = byId.get(key)
      if (
        current === undefined ||
        current.route.revision !== input.expectedRevision
      ) {
        return yield* new RouteStoreTransitionConflict({
          routeId: input.route.id,
          reason: "concurrent_update",
        })
      }
      const record = {
        ...current,
        route: input.route,
      }
      save(record)
      return input.route
    }),
    rotate: (input) => Effect.gen(function*() {
      const key = routeKey(input.scope, input.previous.id)
      const winner = rotations.get(key)
      if (winner !== undefined) {
        if (
          winner.idempotencyKey === input.replacement.idempotencyKey &&
          winner.creationFingerprint ===
            input.replacement.creationFingerprint
        ) {
          return {
            previous: winner.previous,
            replacement: winner.replacement.route,
          }
        }
        return yield* new RouteStoreTransitionConflict({
          routeId: input.previous.id,
          reason: "concurrent_update",
        })
      }
      const current = byId.get(key)
      if (
        current === undefined ||
        current.route.revision !== input.expectedRevision ||
        current.route.lifecycle._tag === "Disabled" ||
        input.previous.lifecycle._tag !== "Disabled" ||
        input.previous.revision !== input.expectedRevision + 1 ||
        input.previous.scope.namespace !== input.scope.namespace ||
        input.previous.scope.environment !== input.scope.environment ||
        input.replacement.scope.namespace !== input.scope.namespace ||
        input.replacement.scope.environment !== input.scope.environment
      ) {
        return yield* new RouteStoreTransitionConflict({
          routeId: input.previous.id,
          reason: "concurrent_update",
        })
      }
      if (byAddress.has(input.replacement.address)) {
        return yield* new RouteAddressConflict({
          reason: "already_reserved",
        })
      }
      const previousRecord: StoredRoute = {
        ...current,
        route: input.previous,
      }
      const replacement = buildRoute(input.replacement)
      const replacementRecord: StoredRoute & { readonly route: ActiveRoute } = {
        route: replacement,
        creationFingerprint: input.replacement.creationFingerprint,
      }
      const existingIdempotency = byIdempotency.get(idempotencyKey(
        input.replacement.scope,
        input.replacement.idempotencyKey,
      ))
      if (existingIdempotency !== undefined) {
        return yield* new RouteStoreTransitionConflict({
          routeId: input.previous.id,
          reason: "concurrent_update",
        })
      }
      save(previousRecord)
      save(replacementRecord)
      byIdempotency.set(
        idempotencyKey(
          input.replacement.scope,
          input.replacement.idempotencyKey,
        ),
        replacementRecord,
      )
      rotations.set(key, {
        idempotencyKey: input.replacement.idempotencyKey,
        creationFingerprint: input.replacement.creationFingerprint,
        previous: input.previous,
        replacement: replacementRecord,
      })
      return {
        previous: input.previous,
        replacement,
      }
    }),
  })

  return {
    routeStore,
    adminStore,
    get routes() {
      return Array.from(byId.values(), (record) => record.route)
    },
    layer: Layer.merge(
      Layer.succeed(RouteStore, routeStore),
      Layer.succeed(RouteAdminStore, adminStore),
    ),
  }
}

/** Create an in-memory active-domain registry for route behavior tests. */
export const inMemoryPlatformDomains = (
  domains: ReadonlyArray<PlatformDomain>,
): Layer.Layer<PlatformDomainRegistry> => Layer.succeed(
  PlatformDomainRegistry,
  PlatformDomainRegistry.of({
    requireActive: (environment) => {
      const found = domains.find((domain) => domain.environment === environment)
      return found === undefined
        ? Effect.fail(new PlatformDomainUnavailable({
            environment,
            reason: "not_configured",
          }))
        : Effect.succeed(found)
    },
    resolveInbound: (value) => {
      const found = domains.find((domain) => domain.domain === value)
      return found === undefined
        ? Effect.fail(new PlatformDomainUnavailable({
            environment: "live",
            reason: "not_configured",
          }))
        : Effect.succeed(found)
    },
  }),
)
