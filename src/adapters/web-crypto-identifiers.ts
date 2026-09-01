import { Effect, Layer } from "effect"
import { MailboxHandleSchema } from "../core/address.js"
import {
  LeaseTokenSchema,
  MessageIdSchema,
  RecipientIdSchema,
  RouteIdSchema,
  TestRecipientIdSchema,
  WorkflowEventIdSchema,
} from "../core/identifiers.js"
import { IdentifierGenerator } from "./identifier-generator.js"
import { RouteHandleGenerator } from "./route-handle-generator.js"

const uuid = (kind: string): string => `${kind}:${globalThis.crypto.randomUUID()}`

/** Construct cryptographically random opaque identifiers using Web Crypto. */
export const makeWebCryptoIdentifierGenerator = (): IdentifierGenerator["Service"] =>
  IdentifierGenerator.of({
    messageId: Effect.sync(() => MessageIdSchema.make(uuid("message"))),
    recipientId: Effect.sync(() => RecipientIdSchema.make(uuid("recipient"))),
    routeId: Effect.sync(() => RouteIdSchema.make(uuid("route"))),
    testRecipientId: Effect.sync(() =>
      TestRecipientIdSchema.make(uuid("test-recipient"))),
    workflowEventId: Effect.sync(() =>
      WorkflowEventIdSchema.make(uuid("workflow-event"))),
    leaseToken: Effect.sync(() => LeaseTokenSchema.make(uuid("lease"))),
  })

/** Construct random generated mailbox handles using Web Crypto. */
export const makeWebCryptoRouteHandleGenerator = (): RouteHandleGenerator["Service"] =>
  RouteHandleGenerator.of({
    next: Effect.sync(() =>
      MailboxHandleSchema.make(`mail-${globalThis.crypto.randomUUID()}`)),
  })

/** Production-ready Web Crypto identifier Layer for Node and Workers. */
export const webCryptoIdentifiers: Layer.Layer<IdentifierGenerator> =
  Layer.sync(IdentifierGenerator, makeWebCryptoIdentifierGenerator)

/** Production-ready Web Crypto generated-route-handle Layer. */
export const webCryptoRouteHandles: Layer.Layer<RouteHandleGenerator> =
  Layer.sync(RouteHandleGenerator, makeWebCryptoRouteHandleGenerator)

/** Both portable production generators used by email application services. */
export const webCryptoIdentity: Layer.Layer<
  IdentifierGenerator | RouteHandleGenerator
> = Layer.merge(webCryptoIdentifiers, webCryptoRouteHandles)
