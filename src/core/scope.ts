import { Schema } from "effect"
import { NamespaceSchema } from "./identifiers.js"

/** Deployment environment isolated within one email namespace. */
export const EnvironmentSchema = Schema.Literals(["test", "live"])

/** Deployment environment isolated within one email namespace. */
export type Environment = typeof EnvironmentSchema.Type

/** Complete tenant and environment scope for every package operation. */
export const ScopeSchema = Schema.Struct({
  namespace: NamespaceSchema,
  environment: EnvironmentSchema,
})

/** Complete tenant and environment scope for every package operation. */
export interface Scope extends Schema.Schema.Type<typeof ScopeSchema> {}

/** Scope restricted to test-mode operations such as test recipients. */
export const TestScopeSchema = Schema.Struct({
  namespace: NamespaceSchema,
  environment: Schema.Literal("test"),
})

/** Scope restricted to test-mode operations such as test recipients. */
export interface TestScope extends Schema.Schema.Type<
  typeof TestScopeSchema
> {}

/** Determine whether two parsed scopes identify the same isolated partition. */
export const equals = (left: Scope, right: Scope): boolean =>
  left.namespace === right.namespace &&
  left.environment === right.environment

/** Narrow a general scope to the test environment. */
export const isTest = (scope: Scope): scope is TestScope =>
  scope.environment === "test"
