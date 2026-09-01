import { Schema } from "effect"

const InboundProviderNameValueSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[a-z0-9][a-z0-9._:-]*$/u),
)

const hasNoAsciiControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  })

/** Stable name of the provider that assigned an inbound delivery identity. */
export const InboundProviderNameSchema = InboundProviderNameValueSchema.pipe(
  Schema.brand("EmailInboundProviderName"),
)

/** Stable name of the provider that assigned an inbound delivery identity. */
export type InboundProviderName = typeof InboundProviderNameSchema.Type

/** Provider-owned identity that remains stable across retries of one delivery. */
export const InboundProviderDeliveryIdSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(998),
  Schema.makeFilter(hasNoAsciiControlCharacters, {
    title: "EmailInboundProviderDeliveryId",
  }),
).pipe(Schema.brand("EmailInboundProviderDeliveryId"))

/** Provider-owned identity that remains stable across retries of one delivery. */
export type InboundProviderDeliveryId =
  typeof InboundProviderDeliveryIdSchema.Type

/** Namespaced provider identity for one inbound delivery. */
export const InboundProviderDeliverySchema = Schema.Struct({
  provider: InboundProviderNameSchema,
  deliveryId: InboundProviderDeliveryIdSchema,
})

/** Namespaced provider identity for one inbound delivery. */
export interface InboundProviderDelivery extends Schema.Schema.Type<
  typeof InboundProviderDeliverySchema
> {}
