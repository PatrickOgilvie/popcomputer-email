import { Context, Effect, Schema } from "effect"
import type { EmailAddress } from "../core/address.js"
import type { MessageId, ProviderMessageId } from "../core/identifiers.js"
import type { RecipientTransportOutcome } from "../core/message.js"
import type { Scope } from "../core/scope.js"

/** Transport configuration or capacity could not accept a new send. */
export class SendTransportUnavailable extends Schema.TaggedError<SendTransportUnavailable>()(
  "SendTransportUnavailable",
  {
    operation: Schema.Literal("preflight"),
    reason: Schema.Literals(["configuration", "unavailable"]),
  },
) {}

/** Provider definitively rejected a message without accepting delivery. */
export class SendRejected extends Schema.TaggedError<SendRejected>()(
  "SendRejected",
  {
    reason: Schema.Literal("provider_rejected"),
  },
) {}

/** Provider handoff may have happened and therefore must not be retried. */
export class SendIndeterminate extends Schema.TaggedError<SendIndeterminate>()(
  "SendIndeterminate",
  {
    reason: Schema.Literals(["network", "timeout"]),
  },
) {}

/** Cheap provider readiness check performed before reserving a send. */
export interface SendPreflightInput {
  readonly scope: Scope
  readonly from: EmailAddress
  readonly recipientCount: number
  readonly sizeBytes: number
}

/** Complete provider handoff containing already-rendered canonical MIME. */
export interface TransportMessage {
  readonly scope: Scope
  readonly messageId: MessageId
  readonly from: EmailAddress
  readonly to: readonly [EmailAddress, ...Array<EmailAddress>]
  readonly cc: ReadonlyArray<EmailAddress>
  readonly bcc: ReadonlyArray<EmailAddress>
  readonly rawMime: Uint8Array
}

/** Successful transport outcome requiring one durable finalization. */
export type SendTransportResult =
  | { readonly _tag: "Captured" }
  | {
      readonly _tag: "Accepted"
      readonly providerMessageId?: ProviderMessageId
      readonly outcomes: ReadonlyArray<RecipientTransportOutcome>
    }

/** Provider boundary for readiness checks and exactly one message handoff. */
export class SendTransport extends Context.Service<SendTransport, {
  readonly preflight: (
    input: SendPreflightInput,
  ) => Effect.Effect<void, SendTransportUnavailable>
  readonly send: (
    message: TransportMessage,
  ) => Effect.Effect<SendTransportResult, SendRejected | SendIndeterminate>
}>()("@popcomputer/email/SendTransport") {}
