import { Schema } from "effect"
import { ActorSchema } from "./actor.js"
import {
  AttachmentSchema,
  BodySchema,
  CustomHeaderSchema,
} from "./email-command.js"
import {
  IdempotencyKeySchema,
  MessageIdSchema,
} from "./identifiers.js"
import { ScopeSchema } from "./scope.js"

/**
 * Constrained reply action whose route, recipient, subject, and threading are
 * derived from an existing scoped inbound message.
 */
export const ReplyCommandSchema = Schema.Struct({
  scope: ScopeSchema,
  actor: ActorSchema,
  idempotencyKey: IdempotencyKeySchema,
  sourceMessageId: MessageIdSchema,
  body: BodySchema,
  headers: Schema.Array(CustomHeaderSchema).check(Schema.isMaxLength(100)),
  attachments: Schema.Array(AttachmentSchema).check(
    Schema.isMaxLength(100),
  ),
})

/**
 * Constrained reply action whose route, recipient, subject, and threading are
 * derived from an existing scoped inbound message.
 */
export interface ReplyCommand extends Schema.Schema.Type<
  typeof ReplyCommandSchema
> {}
