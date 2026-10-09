import { Effect, Layer } from "effect"
import { SendTransport, type SendTransportResult } from "./send-transport.js"

const captured: SendTransportResult = { _tag: "Captured" }

/**
 * Transport for deployments without a mail provider. Every send passes
 * preflight and terminalizes as `Captured`; nothing leaves the host.
 */
export const makeCaptureSendTransport = (): SendTransport["Service"] =>
  SendTransport.of({
    preflight: () => Effect.void,
    send: () => Effect.succeed(captured),
  })

/** Provide SendTransport that captures instead of delivering. */
export const captureSendTransport: Layer.Layer<SendTransport> = Layer.succeed(
  SendTransport,
  makeCaptureSendTransport(),
)
