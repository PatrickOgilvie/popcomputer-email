import { Schema } from "effect"
import { ActorIdSchema } from "./identifiers.js"

/** Host principal responsible for an audited email mutation. */
export const ActorSchema = Schema.TaggedUnion({
  User: { id: ActorIdSchema },
  Credential: { id: ActorIdSchema },
  System: { id: ActorIdSchema },
})

/** Host principal responsible for an audited email mutation. */
export type Actor = typeof ActorSchema.Type

/** Actor authenticated as an end user by the host application. */
export type UserActor = typeof ActorSchema.cases.User.Type

/** Actor authenticated through a machine credential by the host application. */
export type CredentialActor = typeof ActorSchema.cases.Credential.Type

/** Trusted host system actor for scheduled or administrative work. */
export type SystemActor = typeof ActorSchema.cases.System.Type
