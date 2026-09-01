import { Schema } from "effect"

/** A finite integer greater than zero and exactly representable by JavaScript. */
export const PositiveSafeIntegerSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
)

/** Return whether a runtime value is a positive JavaScript safe integer. */
export const isPositiveSafeInteger = Schema.is(PositiveSafeIntegerSchema)
