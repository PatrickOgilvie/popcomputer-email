import { Effect, Layer } from "effect"
import {
  SendTransport,
  type SendIndeterminate,
  type SendRejected,
  type SendTransportResult,
  type SendTransportUnavailable,
  type TransportMessage,
} from "../adapters/send-transport.js"

/** Mutable recording transport intended only for behavior tests. */
export interface RecordingSendTransport {
  readonly service: SendTransport["Service"]
  readonly sent: ReadonlyArray<TransportMessage>
  readonly layer: Layer.Layer<SendTransport>
}

/** Create a capture/recording transport with injectable typed behavior. */
export const makeRecordingSendTransport = (options: {
  readonly preflight?: (
    input: import("../adapters/send-transport.js").SendPreflightInput,
  ) => Effect.Effect<void, SendTransportUnavailable>
  readonly send?: (
    input: TransportMessage,
  ) => Effect.Effect<SendTransportResult, SendRejected | SendIndeterminate>
} = {}): RecordingSendTransport => {
  const sent: Array<TransportMessage> = []
  const service = SendTransport.of({
    preflight: options.preflight ?? (() => Effect.void),
    send: (input) => Effect.gen(function*() {
      sent.push({ ...input, rawMime: Uint8Array.from(input.rawMime) })
      return yield* options.send?.(input) ?? Effect.succeed({
        _tag: "Captured" as const,
      })
    }),
  })
  return {
    service,
    get sent() {
      return Array.from(sent)
    },
    layer: Layer.succeed(SendTransport, service),
  }
}
