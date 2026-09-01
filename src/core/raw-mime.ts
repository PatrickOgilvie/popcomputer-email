import { Schema } from "effect"
import {
  MessageIdSchema,
  RawMessageRefSchema,
  Sha256Schema,
} from "./identifiers.js"
import { DirectionSchema } from "./message.js"
import { ScopeSchema } from "./scope.js"

/** Immutable metadata proving the identity and size of archived raw MIME. */
export const RawMimeDescriptorSchema = Schema.Struct({
  scope: ScopeSchema,
  direction: DirectionSchema,
  messageId: MessageIdSchema,
  ref: RawMessageRefSchema,
  sha256: Sha256Schema,
  sizeBytes: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0),
  ),
})

/** Immutable metadata proving the identity and size of archived raw MIME. */
export interface RawMimeDescriptor extends Schema.Schema.Type<
  typeof RawMimeDescriptorSchema
> {}
