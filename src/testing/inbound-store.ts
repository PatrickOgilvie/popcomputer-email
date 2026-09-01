import { DateTime, Effect, Layer, Option } from "effect"
import {
  InboundStore,
  InboundStoreFailure,
  type InboundDuplicateKey,
} from "../adapters/inbound-store.js"
import type { InboundMessage } from "../core/message.js"
import type {
  MessageId,
  RawMessageRef,
  Sha256,
} from "../core/identifiers.js"
import type { Scope } from "../core/scope.js"
import type { WorkflowEvent } from "../core/workflow.js"

const keyBase = (input: InboundDuplicateKey): string =>
  `${input.scope.namespace}\u0000${input.scope.environment}\u0000${input.routeId}`

const duplicateKey = (input: InboundDuplicateKey): string =>
  input._tag === "Provider"
    ? `${keyBase(input)}\u0000provider\u0000${input.provider}\u0000${input.deliveryId}`
    : `${keyBase(input)}\u0000digest\u0000${input.envelopeFrom}\u0000${input.rawSha256}`

interface DuplicateReceipt {
  readonly message: InboundMessage
  readonly expiresAtEpochMillis: number | undefined
}

interface Intent {
  readonly messageId: MessageId
  readonly scope: Scope
  readonly rawSha256: Sha256 | undefined
  readonly rawRef: RawMessageRef
  readonly cleanupNeeded: boolean
  readonly cleanupObservedAt: import("effect").DateTime.Utc | undefined
  readonly expiresAt: import("effect").DateTime.Utc | undefined
  readonly nextAttemptAt: import("effect").DateTime.Utc | undefined
  readonly now: import("effect").DateTime.Utc
}

/** Inspectable in-memory inbound dedupe/intent/atomic-commit store. */
export interface InMemoryInboundStore {
  readonly service: InboundStore["Service"]
  readonly messages: ReadonlyArray<InboundMessage>
  readonly intents: ReadonlyArray<Intent>
  readonly layer: Layer.Layer<InboundStore>
}

/** Create an isolated inbound store; optional callback joins a workflow fake. */
export const makeInMemoryInboundStore = (options: {
  readonly onWorkflowEvent?: (event: WorkflowEvent) => void
} = {}): InMemoryInboundStore => {
  const duplicates = new Map<string, DuplicateReceipt>()
  const messages = new Map<string, InboundMessage>()
  const intents = new Map<string, Intent>()

  const findDuplicate = (key: InboundDuplicateKey): InboundMessage | undefined => {
    const receipt = duplicates.get(duplicateKey(key))
    if (receipt === undefined) return undefined
    if (key._tag === "Provider") return receipt.message
    return receipt.expiresAtEpochMillis !== undefined &&
        receipt.expiresAtEpochMillis > DateTime.toEpochMillis(key.observedAt)
      ? receipt.message
      : undefined
  }

  const service = InboundStore.of({
    findDuplicate: (key) => Effect.sync(() => {
      const found = findDuplicate(key)
      return found === undefined ? Option.none() : Option.some(found)
    }),
    createArchiveIntent: (input) => Effect.gen(function*() {
      const current = intents.get(input.messageId)
      if (current === undefined) {
        intents.set(input.messageId, {
          messageId: input.messageId,
          scope: input.scope,
          rawSha256: input.rawSha256,
          rawRef: input.rawRef,
          cleanupNeeded: false,
          cleanupObservedAt: undefined,
          expiresAt: input.expiresAt,
          nextAttemptAt: undefined,
          now: input.now,
        })
        return
      }
      if (
        current.scope.namespace !== input.scope.namespace ||
        current.scope.environment !== input.scope.environment ||
        current.rawSha256 !== input.rawSha256 ||
        current.rawRef !== input.rawRef
      ) {
        return yield* new InboundStoreFailure({
          operation: "create_archive_intent",
          reason: "unavailable",
        })
      }
    }),
    commit: (input) => Effect.gen(function*() {
      const intent = intents.get(input.message.id)
      const scopeMatches = input.message.scope.namespace ===
          input.duplicateKey.scope.namespace &&
        input.message.scope.environment ===
          input.duplicateKey.scope.environment &&
        input.raw.scope.namespace === input.message.scope.namespace &&
        input.raw.scope.environment === input.message.scope.environment
      if (
        intent === undefined ||
        intent.scope.namespace !== input.message.scope.namespace ||
        intent.scope.environment !== input.message.scope.environment ||
        intent.cleanupNeeded ||
        intent.rawSha256 !== input.raw.sha256 ||
        intent.rawRef !== input.raw.ref ||
        input.raw.messageId !== input.message.id ||
        input.raw.direction !== "inbound" ||
        !scopeMatches
      ) {
        return yield* new InboundStoreFailure({
          operation: "commit",
          reason: "unavailable",
        })
      }
      const duplicateMatches = input.message.routeId ===
          input.duplicateKey.routeId &&
        (input.duplicateKey._tag === "Provider" || (
          input.duplicateKey.envelopeFrom === input.message.from &&
          input.duplicateKey.rawSha256 === input.raw.sha256 &&
          DateTime.toEpochMillis(input.duplicateKey.expiresAt) >
            DateTime.toEpochMillis(input.duplicateKey.observedAt)
        ))
      if (!duplicateMatches) {
        return yield* new InboundStoreFailure({
          operation: "commit",
          reason: "unavailable",
        })
      }
      const existing = findDuplicate(input.duplicateKey)
      if (existing !== undefined) {
        return { _tag: "Existing" as const, message: existing }
      }
      messages.set(input.message.id, input.message)
      duplicates.set(duplicateKey(input.duplicateKey), {
        message: input.message,
        expiresAtEpochMillis: input.duplicateKey._tag === "Digest"
          ? DateTime.toEpochMillis(input.duplicateKey.expiresAt)
          : undefined,
      })
      if (input.workflowEvent !== undefined) {
        options.onWorkflowEvent?.(input.workflowEvent)
      }
      intents.delete(input.message.id)
      return { _tag: "Created" as const, message: input.message }
    }),
    deleteArchiveIntent: (_scope, messageId) => Effect.sync(() => {
      intents.delete(messageId)
    }),
    markArchiveCleanup: (input) => Effect.gen(function*() {
      const current = intents.get(input.messageId)
      if (
        current === undefined ||
        current.scope.namespace !== input.scope.namespace ||
        current.scope.environment !== input.scope.environment ||
        current.rawRef !== input.rawRef
      ) {
        return yield* new InboundStoreFailure({
          operation: "mark_archive_cleanup",
          reason: "unavailable",
        })
      }
      if (current.cleanupNeeded) return
      intents.set(input.messageId, {
        ...current,
        cleanupNeeded: true,
        cleanupObservedAt: input.now,
        nextAttemptAt: input.nextAttemptAt,
      })
    }),
  })

  return {
    service,
    get messages() {
      return Array.from(messages.values())
    },
    get intents() {
      return Array.from(intents.values())
    },
    layer: Layer.succeed(InboundStore, service),
  }
}
