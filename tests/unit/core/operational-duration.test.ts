import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import {
  MaximumOperationalDurationMilliseconds,
  OperationalDurationMillisecondsSchema,
} from "../../../src/core/operational-duration.js"

describe("operational duration", () => {
  test("bounds public deadline arithmetic inside the ECMAScript Date range", () => {
    const base = DateTime.makeUnsafe("2026-09-01T00:00:00.000Z")
    const future = DateTime.addDuration(
      base,
      MaximumOperationalDurationMilliseconds,
    )
    const past = DateTime.subtractDuration(
      base,
      MaximumOperationalDurationMilliseconds,
    )

    expect(Schema.is(OperationalDurationMillisecondsSchema)(
      MaximumOperationalDurationMilliseconds,
    )).toBe(true)
    expect(Schema.is(OperationalDurationMillisecondsSchema)(
      MaximumOperationalDurationMilliseconds + 1,
    )).toBe(false)
    expect(() => DateTime.formatIso(future)).not.toThrow()
    expect(() => DateTime.formatIso(past)).not.toThrow()
    expect(() => DateTime.formatIso(
      DateTime.addDuration(base, Number.MAX_SAFE_INTEGER),
    )).toThrow(RangeError)
  })
})
