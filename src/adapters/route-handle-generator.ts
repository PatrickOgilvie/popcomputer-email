import { Context, Effect } from "effect"
import type { MailboxHandle } from "../core/address.js"

/** Generator kept behind a port so collision behavior is deterministic in tests. */
export class RouteHandleGenerator extends Context.Service<
  RouteHandleGenerator,
  { readonly next: Effect.Effect<MailboxHandle> }
>()("@popcomputer/email/RouteHandleGenerator") {}
