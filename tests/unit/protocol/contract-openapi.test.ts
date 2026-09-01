import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import {
  operations,
  type Method,
} from "../../../src/protocol/contract.js"
import {
  generateOpenApiDocument,
  renderOpenApiDocument,
} from "../../../src/protocol/openapi.js"

interface ExpectedOperation {
  readonly operationId: string
  readonly method: Method
  readonly path: string
}

const ExpectedOperations: ReadonlyArray<ExpectedOperation> = [
  { operationId: "sendEmail", method: "POST", path: "/emails" },
  { operationId: "listEmails", method: "GET", path: "/emails" },
  {
    operationId: "getEmailContent",
    method: "GET",
    path: "/emails/{email}/content",
  },
  {
    operationId: "getEmailAttachment",
    method: "GET",
    path: "/emails/{email}/attachments/{attachment}",
  },
  {
    operationId: "getRawEmail",
    method: "GET",
    path: "/emails/{email}/raw",
  },
  {
    operationId: "replyToEmail",
    method: "POST",
    path: "/emails/{email}/reply",
  },
  {
    operationId: "getEmail",
    method: "GET",
    path: "/emails/{email}",
  },
  {
    operationId: "listEmailRoutes",
    method: "GET",
    path: "/email-routes",
  },
  {
    operationId: "provisionEmailRoute",
    method: "POST",
    path: "/email-routes",
  },
  {
    operationId: "pauseEmailRoute",
    method: "POST",
    path: "/email-routes/{route}/pause",
  },
  {
    operationId: "resumeEmailRoute",
    method: "POST",
    path: "/email-routes/{route}/resume",
  },
  {
    operationId: "rotateEmailRoute",
    method: "POST",
    path: "/email-routes/{route}/rotate",
  },
  {
    operationId: "disableEmailRoute",
    method: "DELETE",
    path: "/email-routes/{route}",
  },
  {
    operationId: "listEmailTestRecipients",
    method: "GET",
    path: "/email-test-recipients",
  },
  {
    operationId: "createEmailTestRecipient",
    method: "POST",
    path: "/email-test-recipients",
  },
  {
    operationId: "refreshEmailTestRecipient",
    method: "POST",
    path: "/email-test-recipients/{recipient}/refresh",
  },
]

describe("hosted email protocol contract", () => {
  test("keeps exactly sixteen stable operation IDs, methods, and paths", () => {
    expect(
      operations.map(({ operationId, method, path }) => ({
        operationId,
        method,
        path,
      })),
    ).toEqual([...ExpectedOperations])
    expect(new Set(operations.map(({ operationId }) => operationId)).size)
      .toBe(16)
  })

  test("generates matching OpenAPI operations from the registry", () => {
    const document = generateOpenApiDocument()

    for (const expected of ExpectedOperations) {
      const pathItem = document.paths[expected.path]
      if (pathItem === undefined) {
        throw new Error(`missing OpenAPI path ${expected.path}`)
      }
      const operation = expected.method === "GET"
        ? pathItem.get
        : expected.method === "POST"
        ? pathItem.post
        : pathItem.delete
      expect(operation?.operationId).toBe(expected.operationId)
    }

    const documentedIds = Object.values(document.paths).flatMap((pathItem) =>
      [pathItem.get, pathItem.post, pathItem.delete]
        .flatMap((operation) => operation?.operationId ?? [])
    )
    expect(documentedIds).toHaveLength(16)
  })

  test("documents idempotency, permissions, and binary media types", () => {
    const document = generateOpenApiDocument()

    for (const operation of operations) {
      const pathItem = document.paths[operation.path]
      if (pathItem === undefined) {
        throw new Error(`missing OpenAPI path ${operation.path}`)
      }
      const documented = operation.method === "GET"
        ? pathItem.get
        : operation.method === "POST"
        ? pathItem.post
        : pathItem.delete
      const idempotency = documented?.parameters.find(
        (parameter) => parameter.name === "idempotency-key",
      )
      expect(idempotency !== undefined).toBe(
        operation.idempotency === "required",
      )
      if (idempotency !== undefined) {
        expect(idempotency).toMatchObject({
          in: "header",
          required: true,
        })
      }
      expect(documented?.["x-popcomputer-permissions"]).toEqual(
        operation.permissions,
      )
      expect(operation.permissions.length).toBeGreaterThan(0)
    }

    expect(
      document.paths["/emails/{email}/reply"]?.post
        ?.["x-popcomputer-permissions"],
    ).toEqual(["read", "send"])

    expect(
      document.paths["/emails/{email}/raw"]?.get?.responses["200"]
        ?.content?.["message/rfc822"]?.schema,
    ).toMatchObject({
      type: "string",
      format: "binary",
    })
    expect(
      document.paths["/emails/{email}/attachments/{attachment}"]?.get
        ?.responses["200"]?.content?.["application/octet-stream"]
        ?.schema,
    ).toMatchObject({
      type: "string",
      format: "binary",
    })
  })

  test("keeps the committed OpenAPI artifact byte-for-byte current", async () => {
    const target = new URL(
      "../../../openapi/email.v1.json",
      import.meta.url,
    )
    expect(await readFile(target, "utf8")).toBe(renderOpenApiDocument())
  })
})
