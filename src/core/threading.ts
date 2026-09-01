import { Schema } from "effect"

const hasNoAsciiControlCharacters = (value: string): boolean =>
  Array.from(value).every((character) => {
    const code = character.charCodeAt(0)
    return code >= 32 && code !== 127
  })

/** One RFC message identifier safe to render in a threading header. */
export const ThreadMessageIdSchema = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(900),
  Schema.isPattern(/^<[^<>\r\n]+>$/u),
  Schema.makeFilter(hasNoAsciiControlCharacters, {
    title: "EmailThreadMessageId",
  }),
).pipe(Schema.brand("EmailThreadMessageId"))

/** One RFC message identifier safe to render in a threading header. */
export type ThreadMessageId = typeof ThreadMessageIdSchema.Type

/** Package-owned threading metadata rendered as structural MIME headers. */
export const ThreadingSchema = Schema.Struct({
  inReplyTo: ThreadMessageIdSchema,
  references: Schema.NonEmptyArray(ThreadMessageIdSchema).check(
    Schema.isMaxLength(100),
  ),
})

/** Package-owned threading metadata rendered as structural MIME headers. */
export interface Threading extends Schema.Schema.Type<
  typeof ThreadingSchema
> {}
