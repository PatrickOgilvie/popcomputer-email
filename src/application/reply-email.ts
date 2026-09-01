import { Effect, Option, Schema } from "effect"
import type { ContentDigestFailure } from "../adapters/content-digest.js"
import { ContentDigest } from "../adapters/content-digest.js"
import { MessageStore } from "../adapters/message-store.js"
import { RawMessageArchive } from "../adapters/raw-message-archive.js"
import {
  RouteStore,
  type RouteStoreFailure,
} from "../adapters/route-store.js"
import { SendCommandSchema, type SendCommand } from "../core/email-command.js"
import {
  EmailAddressSchema,
  type EmailAddress,
} from "../core/address.js"
import { MessageIdSchema } from "../core/identifiers.js"
import { RouteIdSchema } from "../core/identifiers.js"
import { RouteNotFound } from "../core/route.js"
import type { ReplyCommand } from "../core/reply-command.js"
import {
  defaultReceivedContentConfig,
  loadReceivedContent,
  type ReadReceivedContentFailure,
  type ReceivedContentConfig,
} from "./read-received-content.js"
import {
  executeOutbound,
  type SendEmailFailure,
} from "./send-email.js"
import { fingerprintReplyCommand } from "./outbound-fingerprint.js"
import type { MessageDetails } from "./read-email.js"
import {
  conservativeReplyPolicy,
  ReplyLoopPrevented,
  ReplyPolicy,
  type ReplyPolicyFailure,
} from "./reply-policy.js"

/** A received message did not identify exactly one safe reply destination. */
export class ReplyTargetUnavailable extends Schema.TaggedError<
  ReplyTargetUnavailable
>()("ReplyTargetUnavailable", {
  messageId: MessageIdSchema,
  reason: Schema.Literals(["missing", "ambiguous"]),
}) {}

/** The stored source message and its receiving route disagree. */
export class ReplySourceRouteMismatch extends Schema.TaggedError<
  ReplySourceRouteMismatch
>()("ReplySourceRouteMismatch", {
  messageId: MessageIdSchema,
  routeId: RouteIdSchema,
  reason: Schema.Literal("source_route_mismatch"),
}) {}

/** Typed failures produced by one constrained reply action. */
export type ReplyEmailFailure =
  | ContentDigestFailure
  | ReadReceivedContentFailure
  | ReplyPolicyFailure
  | ReplySourceRouteMismatch
  | ReplyTargetUnavailable
  | RouteNotFound
  | RouteStoreFailure
  | SendEmailFailure

const subjectForReply = (subject: string | null): string => {
  if (subject === null || subject.length === 0) return "Re:"
  if (/^\s*re:/iu.test(subject)) return subject
  return `Re: ${subject.slice(0, 994)}`
}

const replyTarget = (
  command: ReplyCommand,
  input: {
    readonly replyTo: ReadonlyArray<EmailAddress>
    readonly headerFrom: ReadonlyArray<EmailAddress>
    readonly envelopeFrom: EmailAddress
  },
): Effect.Effect<
  EmailAddress,
  ReplyTargetUnavailable
> => {
  const candidates = input.replyTo.length > 0
    ? input.replyTo
    : input.headerFrom.length > 0
    ? input.headerFrom
    : [input.envelopeFrom]
  if (candidates.length === 0) {
    return Effect.fail(
      new ReplyTargetUnavailable({
        messageId: command.sourceMessageId,
        reason: "missing",
      }),
    )
  }
  if (candidates.length !== 1) {
    return Effect.fail(
      new ReplyTargetUnavailable({
        messageId: command.sourceMessageId,
        reason: "ambiguous",
      }),
    )
  }
  const first = candidates[0]
  return first === undefined
    ? Effect.fail(
        new ReplyTargetUnavailable({
          messageId: command.sourceMessageId,
          reason: "missing",
        }),
      )
    : Effect.succeed(first)
}

const assertReplyIsNotSelfTarget = Effect.fn("Email.reply.assertNotSelf")(
  function*(
    command: ReplyCommand,
    sourceAddress: EmailAddress,
    target: EmailAddress,
  ) {
    if (target.toLowerCase() === sourceAddress.toLowerCase()) {
      return yield* new ReplyLoopPrevented({
        messageId: command.sourceMessageId,
        reason: "self_target",
      })
    }
  },
)

const prepareReplyCommand = Effect.fn("Email.reply.prepare")(function*(
  command: ReplyCommand,
  config: ReceivedContentConfig,
): Effect.fn.Return<
  SendCommand,
  | ReadReceivedContentFailure
  | ReplyPolicyFailure
  | ReplySourceRouteMismatch
  | ReplyTargetUnavailable
  | RouteNotFound
  | RouteStoreFailure,
  ContentDigest | MessageStore | RawMessageArchive | ReplyPolicy | RouteStore
> {
  const loaded = yield* loadReceivedContent({
    scope: command.scope,
    messageId: command.sourceMessageId,
  }, config)
  const routes = yield* RouteStore
  const route = yield* routes.findById(command.scope, loaded.source.routeId)
  if (Option.isNone(route)) {
    return yield* new RouteNotFound({
      routeId: loaded.source.routeId,
      reason: "not_found",
    })
  }
  if (!loaded.source.to.includes(route.value.address)) {
    return yield* new ReplySourceRouteMismatch({
      messageId: loaded.source.id,
      routeId: loaded.source.routeId,
      reason: "source_route_mismatch",
    })
  }
  const target = yield* replyTarget(command, loaded.content)
  yield* assertReplyIsNotSelfTarget(
    command,
    route.value.address,
    target,
  )
  const normalizedTarget = EmailAddressSchema.make(target.toLowerCase())
  const targetRoute = yield* routes.findByInboundAddress(normalizedTarget)
  const policy = yield* ReplyPolicy
  yield* policy.check({
    source: loaded.source,
    content: loaded.content,
    sourceRoute: route.value,
    target,
    targetRoute,
  })
  const sourceMessageId = loaded.content.threading.messageId
  const priorReferences = sourceMessageId === null
    ? []
    : Array.from(new Set(loaded.content.threading.references))
        .filter((reference) => reference !== sourceMessageId)
        .slice(-99)
  const [firstReference, ...remainingReferences] = priorReferences
  const threading = sourceMessageId === null
    ? undefined
    : {
        inReplyTo: sourceMessageId,
        references: firstReference === undefined
          ? [sourceMessageId] as const
          : [firstReference, ...remainingReferences, sourceMessageId] as const,
      }
  const base = {
    scope: command.scope,
    actor: command.actor,
    idempotencyKey: command.idempotencyKey,
    from: SendCommandSchema.fields.from.cases.Route.make({
      routeId: loaded.source.routeId,
    }),
    to: [target] as const,
    cc: [],
    bcc: [],
    subject: subjectForReply(loaded.source.subject),
    body: command.body,
    headers: command.headers,
    attachments: command.attachments,
    automation: "auto_reply" as const,
  }
  return SendCommandSchema.make(
    threading === undefined ? base : { ...base, threading },
  )
})

/**
 * Reply from the receiving route with package-derived recipient and threading.
 *
 * The caller controls only reply content and the mutation idempotency key;
 * the host must explicitly provide the `ReplyPolicy` service.
 */
export const replyEmailWithPolicy = Effect.fn("Email.reply.withPolicy")(function*(
  command: ReplyCommand,
  config: ReceivedContentConfig = defaultReceivedContentConfig,
): Effect.fn.Return<
  MessageDetails,
  ReplyEmailFailure,
  | ContentDigest
  | import("../adapters/identifier-generator.js").IdentifierGenerator
  | MessageStore
  | import("../adapters/outbound-policy.js").OutboundPolicy
  | RawMessageArchive
  | ReplyPolicy
  | import("../adapters/route-store.js").RouteStore
  | import("../adapters/send-transport.js").SendTransport
> {
  const fingerprint = yield* fingerprintReplyCommand(command)
  return yield* executeOutbound({
    scope: command.scope,
    idempotencyKey: command.idempotencyKey,
    fingerprint,
    prepare: prepareReplyCommand(command, config),
  })
})

/**
 * Reply using the package's conservative automation and trigger-loop policy.
 *
 * Use `replyEmailWithPolicy` only when the host deliberately supplies a
 * different `ReplyPolicy` service.
 */
export const replyEmail = Effect.fn("Email.reply")(function*(
  command: ReplyCommand,
  config: ReceivedContentConfig = defaultReceivedContentConfig,
): Effect.fn.Return<
  MessageDetails,
  ReplyEmailFailure,
  | ContentDigest
  | import("../adapters/identifier-generator.js").IdentifierGenerator
  | MessageStore
  | import("../adapters/outbound-policy.js").OutboundPolicy
  | RawMessageArchive
  | import("../adapters/route-store.js").RouteStore
  | import("../adapters/send-transport.js").SendTransport
> {
  return yield* replyEmailWithPolicy(command, config).pipe(
    Effect.provideService(ReplyPolicy, conservativeReplyPolicy),
  )
})

export { ReplyLoopPrevented } from "./reply-policy.js"
