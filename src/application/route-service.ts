import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { ContentDigest, type ContentDigestFailure } from "../adapters/content-digest.js"
import { IdentifierGenerator } from "../adapters/identifier-generator.js"
import {
  PlatformDomainRegistry,
  type PlatformDomainUnavailable,
} from "../adapters/platform-domain-registry.js"
import {
  RouteAddressConflict,
  RouteAdminStore,
  type RouteAdminStoreFailure,
  type RouteStoreTransitionConflict,
  type ReserveRouteInput,
  type StoredRoute,
} from "../adapters/route-admin-store.js"
import { RouteHandleGenerator } from "../adapters/route-handle-generator.js"
import { RouteStore, type RouteStoreFailure } from "../adapters/route-store.js"
import { EmailAddressSchema } from "../core/address.js"
import type { Actor } from "../core/actor.js"
import { IdempotencyConflict } from "../core/email-command.js"
import type { IdempotencyKey, RouteId } from "../core/identifiers.js"
import {
  disable,
  isActive,
  isDisabled,
  isPaused,
  pause,
  type ProvisionRouteInput,
  type Route,
  resume,
  RouteNotFound,
} from "../core/route.js"
import type { Scope } from "../core/scope.js"

/** A route lifecycle operation is not legal from its current state. */
export class InvalidRouteTransition extends Schema.TaggedError<
  InvalidRouteTransition
>()("InvalidRouteTransition", {
  routeId: Schema.String,
  operation: Schema.Literals(["pause", "resume", "disable", "rotate"]),
  state: Schema.Literals(["active", "paused", "disabled"]),
}) {}

/** Generated route handles exhausted the bounded collision budget. */
export class RouteHandleUnavailable extends Schema.TaggedError<
  RouteHandleUnavailable
>()("RouteHandleUnavailable", {
  reason: Schema.Literal("collision_budget_exhausted"),
}) {}

/** Typed failures exposed by route administration. */
export type RouteServiceError =
  | ContentDigestFailure
  | IdempotencyConflict
  | InvalidRouteTransition
  | PlatformDomainUnavailable
  | RouteAddressConflict
  | RouteAdminStoreFailure
  | RouteHandleUnavailable
  | RouteNotFound
  | RouteStoreFailure
  | RouteStoreTransitionConflict

/** Input for scoped route lifecycle mutations. */
export interface RouteMutationInput {
  readonly scope: Scope
  readonly routeId: RouteId
}

/** Input for idempotent address rotation. */
export interface RotateRouteCommand extends RouteMutationInput {
  readonly actor: Actor
  readonly idempotencyKey: IdempotencyKey
}

/** Disabled original route and its newly active replacement. */
export interface RouteRotation {
  readonly previous: Route
  readonly replacement: Route
}

const encoder = new TextEncoder()

type RouteFingerprintInput =
  | {
      readonly kind: "provision"
      readonly handle: ProvisionRouteInput["handle"]
      readonly inbound: ProvisionRouteInput["inbound"]
      readonly outbound: ProvisionRouteInput["outbound"]
    }
  | { readonly kind: "rotate"; readonly routeId: RouteId }

const fingerprint = (value: RouteFingerprintInput) =>
  Effect.flatMap(ContentDigest, (digest) =>
    digest.requestFingerprint(encoder.encode(JSON.stringify(value))))

const assertReplay = (
  stored: StoredRoute,
  expected: import("../core/identifiers.js").RequestFingerprint,
): Effect.Effect<Route, IdempotencyConflict> =>
  stored.creationFingerprint === expected
    ? Effect.succeed(stored.route)
    : Effect.fail(new IdempotencyConflict({ reason: "fingerprint_mismatch" }))

const stateName = (route: Route): "active" | "paused" | "disabled" =>
  isActive(route) ? "active" : isPaused(route) ? "paused" : "disabled"

const requireRoute = Effect.fn("Email.route.require")(function*(
  input: RouteMutationInput,
) {
  const routes = yield* RouteStore
  const found = yield* routes.findById(input.scope, input.routeId)
  if (Option.isNone(found)) {
    return yield* new RouteNotFound({
      routeId: input.routeId,
      reason: "not_found",
    })
  }
  return found.value
})

const reserveGenerated = Effect.fn("Email.route.reserveGenerated")(function*(
  makeInput: (
    routeId: RouteId,
    mailboxHandle: import("../core/address.js").MailboxHandle,
  ) => ReserveRouteInput,
) {
  const handles = yield* RouteHandleGenerator
  const identifiers = yield* IdentifierGenerator
  const store = yield* RouteAdminStore
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const mailboxHandle = yield* handles.next
    const routeId = yield* identifiers.routeId
    const input = makeInput(routeId, mailboxHandle)
    const reserved = yield* store.reserve(input).pipe(
      Effect.map(Option.some),
      Effect.catchTag("RouteAddressConflict", () => Effect.succeed(Option.none())),
    )
    if (Option.isSome(reserved)) {
      return yield* assertReplay(
        reserved.value.record,
        input.creationFingerprint,
      )
    }
  }
  return yield* new RouteHandleUnavailable({
    reason: "collision_budget_exhausted",
  })
})

/** Effect service for provisioning and lifecycle management of email routes. */
export class RouteService extends Context.Service<RouteService, {
  readonly provision: (
    input: ProvisionRouteInput,
  ) => Effect.Effect<Route, RouteServiceError>
  readonly list: (
    scope: Scope,
  ) => Effect.Effect<ReadonlyArray<Route>, RouteServiceError>
  readonly pause: (
    input: RouteMutationInput,
  ) => Effect.Effect<Route, RouteServiceError>
  readonly resume: (
    input: RouteMutationInput,
  ) => Effect.Effect<Route, RouteServiceError>
  readonly disable: (
    input: RouteMutationInput,
  ) => Effect.Effect<Route, RouteServiceError>
  readonly rotate: (
    input: RotateRouteCommand,
  ) => Effect.Effect<RouteRotation, RouteServiceError>
}>()("@popcomputer/email/RouteService") {}

/** Construct RouteService while keeping all infrastructure at the layer edge. */
export const layer: Layer.Layer<
  RouteService,
  never,
  | ContentDigest
  | IdentifierGenerator
  | PlatformDomainRegistry
  | RouteAdminStore
  | RouteHandleGenerator
  | RouteStore
> = Layer.effect(
  RouteService,
  Effect.gen(function*() {
    const digest = yield* ContentDigest
    const identifiers = yield* IdentifierGenerator
    const domains = yield* PlatformDomainRegistry
    const admin = yield* RouteAdminStore
    const handles = yield* RouteHandleGenerator
    const routeStore = yield* RouteStore

    const provide = <A, E>(effect: Effect.Effect<A, E,
      | ContentDigest
      | IdentifierGenerator
      | PlatformDomainRegistry
      | RouteAdminStore
      | RouteHandleGenerator
      | RouteStore
    >): Effect.Effect<A, E> => effect.pipe(
      Effect.provideService(ContentDigest, digest),
      Effect.provideService(IdentifierGenerator, identifiers),
      Effect.provideService(PlatformDomainRegistry, domains),
      Effect.provideService(RouteAdminStore, admin),
      Effect.provideService(RouteHandleGenerator, handles),
      Effect.provideService(RouteStore, routeStore),
    )

    const transition = (
      input: RouteMutationInput,
      operation: "pause" | "resume" | "disable",
    ): Effect.Effect<Route, RouteServiceError> => provide(Effect.gen(function*() {
      const current = yield* requireRoute(input)
      const now = yield* DateTime.now
      const next = operation === "pause"
        ? isActive(current)
          ? pause(current, now)
          : undefined
        : operation === "resume"
        ? isPaused(current)
          ? resume(current, now)
          : undefined
        : isActive(current) || isPaused(current)
        ? disable(current, now)
        : undefined
      if (next === undefined) {
        return yield* new InvalidRouteTransition({
          routeId: input.routeId,
          operation,
          state: stateName(current),
        })
      }
      return yield* admin.transition({
        scope: input.scope,
        route: next,
        expectedRevision: current.revision,
      })
    }))

    return RouteService.of({
      provision: (input) => provide(Effect.gen(function*() {
        const requestFingerprint = yield* fingerprint({
          kind: "provision",
          handle: input.handle,
          inbound: input.inbound,
          outbound: input.outbound,
        })
        const existing = yield* admin.findByIdempotency(
          input.scope,
          input.idempotencyKey,
        )
        if (Option.isSome(existing)) {
          return yield* assertReplay(existing.value, requestFingerprint)
        }
        const domain = yield* domains.requireActive(input.scope.environment)
        const now = yield* DateTime.now
        const makeInput = (
          routeId: RouteId,
          mailboxHandle: import("../core/address.js").MailboxHandle,
        ): ReserveRouteInput => ({
          id: routeId,
          scope: input.scope,
          domainId: domain.id,
          address: EmailAddressSchema.make(`${mailboxHandle}@${domain.domain}`),
          mailboxHandle,
          inbound: input.inbound,
          outbound: input.outbound,
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          creationFingerprint: requestFingerprint,
          createdAt: now,
        })
        if (input.handle._tag === "Generated") {
          return yield* reserveGenerated(makeInput)
        }
        const result = yield* admin.reserve(makeInput(
          yield* identifiers.routeId,
          input.handle.mailboxHandle,
        ))
        return yield* assertReplay(result.record, requestFingerprint)
      })),
      list: (scope) => admin.list(scope),
      pause: (input) => transition(input, "pause"),
      resume: (input) => transition(input, "resume"),
      disable: (input) => transition(input, "disable"),
      rotate: (input) => provide(Effect.gen(function*() {
        const current = yield* requireRoute(input)
        const requestFingerprint = yield* fingerprint({
          kind: "rotate",
          routeId: input.routeId,
        })
        const existing = yield* admin.findByIdempotency(
          input.scope,
          input.idempotencyKey,
        )
        if (Option.isSome(existing)) {
          const replacement = yield* assertReplay(
            existing.value,
            requestFingerprint,
          )
          return { previous: current, replacement }
        }
        if (isDisabled(current)) {
          return yield* new InvalidRouteTransition({
            routeId: input.routeId,
            operation: "rotate",
            state: "disabled",
          })
        }
        const domain = yield* domains.requireActive(input.scope.environment)
        const now = yield* DateTime.now
        const mailboxHandle = yield* handles.next
        const shared = {
          id: yield* identifiers.routeId,
          scope: input.scope,
          domainId: domain.id,
          address: EmailAddressSchema.make(`${mailboxHandle}@${domain.domain}`),
          mailboxHandle,
          actor: input.actor,
          idempotencyKey: input.idempotencyKey,
          creationFingerprint: requestFingerprint,
          createdAt: now,
        } as const
        const replacement: ReserveRouteInput = {
          ...shared,
          inbound: current.inbound,
          outbound: current.outbound,
        }
        const previous = isActive(current)
          ? disable(current, now)
          : isPaused(current)
          ? disable(current, now)
          : undefined
        if (previous === undefined) {
          return yield* new InvalidRouteTransition({
            routeId: input.routeId,
            operation: "rotate",
            state: "disabled",
          })
        }
        const rotated = yield* admin.rotate({
          scope: input.scope,
          previous,
          expectedRevision: current.revision,
          replacement,
        })
        return rotated
      })),
    })
  }),
)
