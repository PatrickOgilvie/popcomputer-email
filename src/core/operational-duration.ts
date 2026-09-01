import { Schema } from "effect"
import { PositiveSafeIntegerSchema } from "./positive-safe-integer.js"

/**
 * Largest configurable deadline offset: one hundred leap-length years.
 *
 * Email leases, retry delays, and retention windows are expected to be much
 * shorter. This ceiling keeps contemporary timestamp arithmetic comfortably
 * inside ECMAScript Date's plus-or-minus 100,000,000-day representable range.
 */
export const MaximumOperationalDurationMilliseconds =
  100 * 366 * 24 * 60 * 60 * 1_000

/** A positive millisecond duration safe for operational DateTime arithmetic. */
export const OperationalDurationMillisecondsSchema =
  PositiveSafeIntegerSchema.check(
    Schema.isLessThanOrEqualTo(MaximumOperationalDurationMilliseconds),
  )
