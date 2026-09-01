import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  PageCursorSchema,
} from "../../../src/core/identifiers.js"
import { ScopeSchema } from "../../../src/core/scope.js"
import { makeInMemoryMessageStore } from "../../../src/testing/message-store.js"

const scope = Schema.decodeUnknownSync(ScopeSchema)({
  namespace: "tenant:in-memory-pages",
  environment: "test",
})

describe("in-memory message store pagination", () => {
  test("accepts the shared maximum page size", async () => {
    const store = makeInMemoryMessageStore().service
    const page = await Effect.runPromise(store.list({ scope, limit: 100 }))

    expect(page.items).toEqual([])
  })

  test("rejects malformed cursors and out-of-range limits as caller errors", async () => {
    const store = makeInMemoryMessageStore().service
    const [cursorFailure, limitFailure] = await Effect.runPromise(Effect.all([
      Effect.flip(store.list({
        scope,
        cursor: PageCursorSchema.make("not_an_offset"),
      })),
      Effect.flip(store.list({ scope, limit: 101 })),
    ]))

    expect(cursorFailure).toMatchObject({
      _tag: "InvalidPageRequest",
      reason: "invalid_cursor",
    })
    expect(limitFailure).toMatchObject({
      _tag: "InvalidPageRequest",
      reason: "invalid_limit",
    })
  })
})
