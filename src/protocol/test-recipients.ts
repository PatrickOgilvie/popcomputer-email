import { Schema } from "effect"
import { EmailAddressSchema } from "../core/address.js"
import {
  TestRecipientIdSchema,
} from "../core/identifiers.js"

/** Hosted test-recipient verification state. */
export const TestRecipientStatusSchema = Schema.Literals([
  "pending",
  "verified",
  "failed",
])

/** Hosted test-recipient verification state. */
export type TestRecipientStatus = typeof TestRecipientStatusSchema.Type

/** Public test-recipient grant returned by hosted operations. */
export const EmailTestRecipientSchema = Schema.Struct({
  id: TestRecipientIdSchema,
  address: EmailAddressSchema,
  status: TestRecipientStatusSchema,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
})

/** Public test-recipient grant returned by hosted operations. */
export interface EmailTestRecipient extends Schema.Schema.Type<
  typeof EmailTestRecipientSchema
> {}

/** Body for granting a test-mode recipient. */
export const AddTestRecipientRequestSchema = Schema.Struct({
  address: EmailAddressSchema,
})

/** Body for granting a test-mode recipient. */
export interface AddTestRecipientRequest extends Schema.Schema.Type<
  typeof AddTestRecipientRequestSchema
> {}

/** Hosted response containing one test-recipient grant. */
export const EmailTestRecipientEnvelopeSchema = Schema.Struct({
  recipient: EmailTestRecipientSchema,
})

/** Hosted response containing one test-recipient grant. */
export interface EmailTestRecipientEnvelope extends Schema.Schema.Type<
  typeof EmailTestRecipientEnvelopeSchema
> {}

/** Hosted response containing all test-recipient grants in scope. */
export const EmailTestRecipientListSchema = Schema.Struct({
  items: Schema.Array(EmailTestRecipientSchema),
})

/** Hosted response containing all test-recipient grants in scope. */
export interface EmailTestRecipientList extends Schema.Schema.Type<
  typeof EmailTestRecipientListSchema
> {}
