import { Effect } from "effect"
import {
  parse as parseAddress,
  type InvalidEmailAddress,
} from "../../core/address.js"
import {
  InboundService,
  type InboundError,
} from "../../application/inbound-service.js"

/** Narrow structural contract for Cloudflare's inbound email event. */
export interface ForwardableEmailMessageLike {
  readonly from: string
  readonly to: string
  readonly raw: ReadableStream<Uint8Array>
  readonly rawSize: number
  readonly setReject: (reason: string) => void
}

/** Awaited Cloudflare email handler returned by the adapter factory. */
export type InboundEmailHandler = (
  message: ForwardableEmailMessageLike,
) => Promise<void>

const reject = (
  message: ForwardableEmailMessageLike,
  reason: string,
): Effect.Effect<void> => Effect.sync(() => message.setReject(reason))

const ingest = (
  service: InboundService["Service"],
  message: ForwardableEmailMessageLike,
): Effect.Effect<void, InboundError | InvalidEmailAddress> =>
  Effect.gen(function*() {
    const from = yield* parseAddress(message.from)
    const to = yield* parseAddress(message.to)
    yield* service.ingest({
      from,
      to,
      raw: message.raw,
      claimedSizeBytes: message.rawSize,
    })
  })

/**
 * Build an awaited Cloudflare inbound-email handler.
 *
 * Permanent SMTP-facing failures call `setReject`; transient archival and
 * persistence failures remain rejected promises so the runtime can retry.
 */
export const makeInboundEmailHandler = (
  service: InboundService["Service"],
): InboundEmailHandler => async (message) => {
  await Effect.runPromise(ingest(service, message).pipe(
    Effect.catchTags({
      InvalidEmailAddress: () => reject(message, "Invalid email envelope"),
      InboundRouteNotFound: () => reject(message, "Mailbox not found"),
      InboundRouteInactive: () => reject(message, "Mailbox unavailable"),
      InboundMessageTooLarge: () => reject(message, "Message too large"),
      InvalidInboundMime: () => reject(message, "Invalid MIME message"),
    }),
  ))
}
