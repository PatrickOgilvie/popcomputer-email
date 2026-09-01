import { Layer } from "effect"
import { InboundStore } from "../../adapters/inbound-store.js"
import { MaintenanceStore } from "../../adapters/maintenance-store.js"
import { MessageStore } from "../../adapters/message-store.js"
import { OutboundPolicy } from "../../adapters/outbound-policy.js"
import { PlatformDomainRegistry } from "../../adapters/platform-domain-registry.js"
import { RouteAdminStore } from "../../adapters/route-admin-store.js"
import { RouteStore } from "../../adapters/route-store.js"
import { TestRecipientStore } from "../../adapters/test-recipient-store.js"
import { WorkflowStore } from "../../adapters/workflow-store.js"
import type { D1Database } from "./contract.js"
import { makeD1InboundStore } from "./inbound-store.js"
import { makeD1MaintenanceStore } from "./maintenance-store.js"
import { makeD1MessageStore } from "./message-store.js"
import {
  defaultD1OutboundPolicyConfig,
  makeD1OutboundPolicy,
  type D1OutboundPolicyConfig,
} from "./outbound-policy.js"
import { makeD1RouteStores } from "./route-store.js"
import {
  makeD1TestRecipientStore,
  type D1TestRecipientStoreConfig,
} from "./test-recipient-store.js"
import { makeD1WorkflowStore } from "./workflow-store.js"

/** Configuration for package-owned persistence in one D1 database. */
export interface D1Config {
  readonly database: D1Database
}

/** Backward-compatible focused configuration for the message-store Layer. */
export interface D1MessageStoreConfig extends D1Config {}

/** D1 plus the Cloudflare account identity owning destination records. */
export interface D1TestRecipientLayerConfig
  extends D1Config, D1TestRecipientStoreConfig {}

/** Configuration needed by the aggregate package persistence Layer. */
export interface D1LayerConfig extends D1TestRecipientLayerConfig {
  readonly policy?: D1OutboundPolicyConfig
}

/**
 * Provide the package message-store service through a Cloudflare D1 binding.
 *
 * Apply `migrations/d1/0001_email.sql` before constructing the Layer.
 */
export const d1MessageStore = (
  config: D1MessageStoreConfig,
): Layer.Layer<MessageStore> =>
  Layer.succeed(MessageStore, makeD1MessageStore(config.database))

/** Provide configured message/recipient limits and test grant enforcement. */
export const d1OutboundPolicy = (
  config: D1Config & {
    readonly policy?: D1OutboundPolicyConfig
  },
): Layer.Layer<OutboundPolicy> => Layer.succeed(
  OutboundPolicy,
  makeD1OutboundPolicy(
    config.database,
    config.policy ?? defaultD1OutboundPolicyConfig,
  ),
)

/** Provide the active package-platform-domain registry from D1. */
export const d1PlatformDomainRegistry = (
  config: D1Config,
): Layer.Layer<PlatformDomainRegistry> => Layer.succeed(
  PlatformDomainRegistry,
  makeD1RouteStores(config.database).platformDomainRegistry,
)

/** Provide scope-safe route reads from D1. */
export const d1RouteStore = (
  config: D1Config,
): Layer.Layer<RouteStore> => Layer.succeed(
  RouteStore,
  makeD1RouteStores(config.database).routeStore,
)

/** Provide route reservation and lifecycle administration from D1. */
export const d1RouteAdminStore = (
  config: D1Config,
): Layer.Layer<RouteAdminStore> => Layer.succeed(
  RouteAdminStore,
  makeD1RouteStores(config.database).routeAdminStore,
)

/** Provide inbound dedupe, archive-intent, and outbox persistence from D1. */
export const d1InboundStore = (
  config: D1Config,
): Layer.Layer<InboundStore> => Layer.succeed(
  InboundStore,
  makeD1InboundStore(config.database),
)

/** Provide the leased workflow outbox from D1. */
export const d1WorkflowStore = (
  config: D1Config,
): Layer.Layer<WorkflowStore> => Layer.succeed(
  WorkflowStore,
  makeD1WorkflowStore(config.database),
)

/** Provide namespace-local test-recipient grants from D1. */
export const d1TestRecipientStore = (
  config: D1TestRecipientLayerConfig,
): Layer.Layer<TestRecipientStore> => Layer.succeed(
  TestRecipientStore,
  makeD1TestRecipientStore(config.database, config),
)

/** Provide crash recovery and raw-archive cleanup queues from D1. */
export const d1MaintenanceStore = (
  config: D1Config,
): Layer.Layer<MaintenanceStore> => Layer.succeed(
  MaintenanceStore,
  makeD1MaintenanceStore(config.database),
)

/** Provide every package-owned D1 persistence port as one Layer. */
export const d1Layer = (
  config: D1LayerConfig,
): Layer.Layer<
  | InboundStore
  | MaintenanceStore
  | MessageStore
  | OutboundPolicy
  | PlatformDomainRegistry
  | RouteAdminStore
  | RouteStore
  | TestRecipientStore
  | WorkflowStore
> => Layer.mergeAll(
  d1MessageStore(config),
  d1OutboundPolicy(config),
  d1PlatformDomainRegistry(config),
  d1RouteStore(config),
  d1RouteAdminStore(config),
  d1InboundStore(config),
  d1WorkflowStore(config),
  d1TestRecipientStore(config),
  d1MaintenanceStore(config),
)
