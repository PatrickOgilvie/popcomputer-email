import { Effect, Schema, SchemaGetter } from "effect"

const MaximumAddressLength = 320
const MaximumLocalPartLength = 64
const MaximumDomainLength = 253

const canonicalDomain = (value: string): string => value.toLowerCase()

const canonicalAddress = (value: string): string => {
  const separator = value.lastIndexOf("@")
  if (separator < 0) return value
  return `${value.slice(0, separator)}@${canonicalDomain(value.slice(separator + 1))}`
}

const isValidDomain = (domain: string): boolean => {
  if (domain.length === 0 || domain.length > MaximumDomainLength) {
    return false
  }
  const labels = domain.split(".")
  return labels.every((label) =>
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  )
}

const isValidLocalPart = (localPart: string): boolean =>
  localPart.length > 0 &&
  localPart.length <= MaximumLocalPartLength &&
  !localPart.startsWith(".") &&
  !localPart.endsWith(".") &&
  !localPart.includes("..") &&
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/u.test(localPart)

const isCanonicalAddress = (value: string): boolean => {
  if (value.length === 0 || value.length > MaximumAddressLength) {
    return false
  }
  const separator = value.lastIndexOf("@")
  if (separator <= 0 || separator !== value.indexOf("@")) return false
  const localPart = value.slice(0, separator)
  const domain = value.slice(separator + 1)
  return isValidLocalPart(localPart) &&
    isValidDomain(domain) &&
    domain === canonicalDomain(domain)
}

/** Canonical DNS domain accepted by the email service. */
export const EmailDomainSchema = Schema.Trimmed.pipe(
  Schema.decode({
    decode: SchemaGetter.transform(canonicalDomain),
    encode: SchemaGetter.transform(canonicalDomain),
  }),
  Schema.check(
    Schema.makeFilter(isValidDomain, { title: "EmailDomain" }),
  ),
  Schema.brand("EmailDomain"),
)

/** Canonical DNS domain accepted by the email service. */
export type EmailDomain = typeof EmailDomainSchema.Type

/** Parsed email address whose local part is preserved and domain is lowercase. */
export const EmailAddressSchema = Schema.Trimmed.pipe(
  Schema.decode({
    decode: SchemaGetter.transform(canonicalAddress),
    encode: SchemaGetter.transform(canonicalAddress),
  }),
  Schema.check(
    Schema.makeFilter(isCanonicalAddress, { title: "EmailAddress" }),
  ),
  Schema.brand("EmailAddress"),
)

/** Parsed email address whose local part is preserved and domain is lowercase. */
export type EmailAddress = typeof EmailAddressSchema.Type

/** Canonical local-part handle that can be allocated as a mailbox route. */
export const MailboxHandleSchema = Schema.Trimmed.pipe(
  Schema.decode({
    decode: SchemaGetter.transform((value) => value.toLowerCase()),
    encode: SchemaGetter.transform((value) => value.toLowerCase()),
  }),
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u),
    Schema.makeFilter((value) => !value.includes(".."), {
      title: "MailboxHandle",
    }),
  ),
  Schema.brand("MailboxHandle"),
)

/** Canonical local-part handle that can be allocated as a mailbox route. */
export type MailboxHandle = typeof MailboxHandleSchema.Type

/** Safe reason an untrusted email address was rejected. */
export const InvalidEmailAddressReasonSchema = Schema.Literal(
  "invalid_format",
)

/** Untrusted input did not represent a supported canonical email address. */
export class InvalidEmailAddress extends Schema.TaggedError<
  InvalidEmailAddress
>()("InvalidEmailAddress", {
  reason: InvalidEmailAddressReasonSchema,
}) {}

/** Parse and normalize an untrusted email address without exposing it on failure. */
export const parse = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This public boundary immediately decodes and normalizes the complete address schema.
  input: unknown,
): Effect.Effect<EmailAddress, InvalidEmailAddress> =>
  Schema.decodeUnknownEffect(EmailAddressSchema)(input).pipe(
    Effect.mapError(() =>
      new InvalidEmailAddress({ reason: "invalid_format" })
    ),
  )

/** Return the preserved local part of a parsed email address. */
export const localPart = (address: EmailAddress): string =>
  address.slice(0, address.lastIndexOf("@"))

/** Return the canonical lowercase domain of a parsed email address. */
export const domain = (address: EmailAddress): EmailDomain =>
  EmailDomainSchema.make(address.slice(address.lastIndexOf("@") + 1))
