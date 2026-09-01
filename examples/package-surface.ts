import {
  Address,
  Email,
  Inbound,
  Maintenance,
  Message,
  Route,
  Scope,
  TestRecipient,
  Workflow,
} from "@popcomputer/email"
import { Effect, Redacted } from "effect"
import * as Adapter from "@popcomputer/email/adapter"
import * as Client from "@popcomputer/email/client"
import * as Cloudflare from "@popcomputer/email/cloudflare"
import * as D1 from "@popcomputer/email/d1"
import * as D1Schema from "@popcomputer/email/d1/schema"
import * as Protocol from "@popcomputer/email/protocol"
import * as Testing from "@popcomputer/email/testing"

/** All supported public entry points are independently importable. */
export const emailPackage = {
  Address,
  Email,
  Inbound,
  Maintenance,
  Message,
  Route,
  Scope,
  TestRecipient,
  Workflow,
  Adapter,
  Client,
  Cloudflare,
  D1,
  D1Schema,
  Protocol,
  Testing,
} as const

/** Read one scoped message through the root Email service namespace. */
export const readMessage = (input: Email.GetMessageInput) =>
  Effect.gen(function* () {
    const email = yield* Email.Service
    return yield* email.getMessage(input)
  })

/** Construct the hosted client with an injected Fetch-compatible transport. */
export const makeHostedClient = (fetch: Client.Fetch): Client.Client =>
  Client.make({
    baseUrl: new URL("https://email.example.com"),
    accessToken: Redacted.make("example-token"),
    fetch,
  })

/** Build the D1 message-store Layer from the package-owned structural contract. */
export const makeD1MessageStoreLayer = (
  database: D1.D1Database,
) => D1.d1MessageStore({ database })

/** Build isolated deterministic adapters for service-level tests. */
export const makeEmailTestKit = () => ({
  identifiers: Testing.deterministicIdentifiers("example"),
  routeHandles: Testing.deterministicRouteHandles("example"),
  routes: Testing.makeInMemoryRoutes(),
})

/** Portable production identity generators for Node.js and Workers. */
export const productionIdentityLayer = Adapter.webCryptoIdentity

/** Project an application read result without exposing internal metadata. */
export const projectMessageDetails = (
  details: Email.MessageDetails,
) => Protocol.projectMessageEnvelope(details)

/** Send and project the hosted response without a second storage read. */
export const sendHostedMessage = (command: Email.SendCommand) =>
  Effect.gen(function* () {
    const email = yield* Email.Service
    const details = yield* email.send(command)
    return yield* Protocol.projectMessageEnvelope(details)
  })

/** Project an application page into the hosted cursor representation. */
export const projectMessagePage = (
  page: Email.MessagePage,
) => Protocol.projectMessagePage(page)

/** Map authenticated host context and a decoded request into Email.SendCommand. */
export const authenticatedSendCommand = (
  input: Protocol.AuthenticatedSendCommandInput,
): Email.SendCommand => Protocol.makeSendCommand(input)

/** Map authenticated host context and decoded content into Email.ReplyCommand. */
export const authenticatedReplyCommand = (
  input: Protocol.AuthenticatedReplyCommandInput,
): Email.ReplyCommand => Protocol.makeReplyCommand(input)

/** Envelope bounded received content for a hosted JSON response. */
export const projectReceivedContent = (
  content: Message.ReceivedContent,
) => Protocol.projectReceivedContentEnvelope(content)
