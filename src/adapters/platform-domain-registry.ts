import { Context, Effect, Schema } from "effect"
import type { EmailDomain } from "../core/address.js"
import type { Environment } from "../core/scope.js"

/** Active package-owned platform domain used to provision and resolve routes. */
export interface PlatformDomain {
  readonly id: string
  readonly domain: EmailDomain
  readonly environment: Environment
}

/** No active platform domain exists for the requested environment. */
export class PlatformDomainUnavailable extends Schema.TaggedError<
  PlatformDomainUnavailable
>()("PlatformDomainUnavailable", {
  environment: Schema.Literals(["test", "live"]),
  reason: Schema.Literals(["not_configured", "unavailable"]),
}) {}

/** Registry for package-owned platform domains; host domains remain out of scope. */
export class PlatformDomainRegistry extends Context.Service<
  PlatformDomainRegistry,
  {
    readonly requireActive: (
      environment: Environment,
    ) => Effect.Effect<PlatformDomain, PlatformDomainUnavailable>
    readonly resolveInbound: (
      domain: EmailDomain,
    ) => Effect.Effect<PlatformDomain, PlatformDomainUnavailable>
  }
>()("@popcomputer/email/PlatformDomainRegistry") {}
