import {
  Address,
  Email,
  Identifiers,
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
import * as Root from "@popcomputer/email"
import * as Testing from "@popcomputer/email/testing"

type NonEmptyModule<Module extends object> =
  keyof Module extends never ? never : Module

const rootModules = {
  Address,
  Email,
  Identifiers,
  Inbound,
  Maintenance,
  Message,
  Route,
  Scope,
  TestRecipient,
  Workflow,
} as const

const adapter: NonEmptyModule<typeof Adapter> = Adapter
const client: NonEmptyModule<typeof Client> = Client
const cloudflare: NonEmptyModule<typeof Cloudflare> = Cloudflare
const d1: NonEmptyModule<typeof D1> = D1
const d1Schema: NonEmptyModule<typeof D1Schema> = D1Schema
const protocol: NonEmptyModule<typeof Protocol> = Protocol
const root: NonEmptyModule<typeof Root> = Root
const testing: NonEmptyModule<typeof Testing> = Testing

void Email.Service
void Email.conservativeReplyPolicyLayer
void Email.layerWithReplyPolicy(Email.conservativeReplyPolicy)
void Email.replyEmail
void Email.replyEmailWithPolicy
void Inbound.MaximumOperationalDurationMilliseconds
void Inbound.OperationalDurationMillisecondsSchema
void Maintenance.MaintenanceLimitSchema
void Maintenance.MaximumMaintenanceBatchLimit
void Maintenance.MaximumOperationalDurationMilliseconds
void Workflow.WorkflowDispatchLimitSchema
void Workflow.MaximumWorkflowReadyLimit
void Workflow.OperationalDurationMillisecondsSchema
void rootModules
void adapter
void client
void Client.InvalidClientRequest
void cloudflare
void d1
void d1Schema
void protocol
void root
void testing

const readMessage = (input: Email.GetMessageInput) =>
  Effect.gen(function* () {
    const email = yield* Email.Service
    return yield* email.getMessage(input)
  })

const hostedClient: Client.Client = Client.make({
  baseUrl: new URL("https://email.example.com"),
  accessToken: Redacted.make("package-type-test"),
})

const d1Layer = (database: D1.D1Database) =>
  D1.d1MessageStore({ database })

const testingLayers = {
  identifiers: Testing.deterministicIdentifiers("package-type-test"),
  routeHandles: Testing.deterministicRouteHandles("package-type-test"),
} as const

const productionIdentityLayer = Adapter.webCryptoIdentity

const projectMessageDetails = (details: Email.MessageDetails) =>
  Protocol.projectMessageEnvelope(details)

const sendHostedMessage = (command: Email.SendCommand) =>
  Effect.gen(function* () {
    const email = yield* Email.Service
    return yield* Protocol.projectMessageEnvelope(yield* email.send(command))
  })

const projectMessagePage = (page: Email.MessagePage) =>
  Protocol.projectMessagePage(page)

const makeAuthenticatedSendCommand = (
  input: Protocol.AuthenticatedSendCommandInput,
): Email.SendCommand => Protocol.makeSendCommand(input)

const makeAuthenticatedReplyCommand = (
  input: Protocol.AuthenticatedReplyCommandInput,
): Email.ReplyCommand => Protocol.makeReplyCommand(input)

const projectReceivedContent = (
  content: Message.ReceivedContent,
) => Protocol.projectReceivedContentEnvelope(content)

void readMessage
void hostedClient
void d1Layer
void testingLayers
void productionIdentityLayer
void projectMessageDetails
void sendHostedMessage
void projectMessagePage
void makeAuthenticatedSendCommand
void makeAuthenticatedReplyCommand
void projectReceivedContent
