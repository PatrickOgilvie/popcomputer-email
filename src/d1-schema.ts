/**
 * Query-oriented Drizzle declarations for package-owned D1 tables.
 *
 * These declarations are not a migration source. Apply the shipped SQL under
 * `@popcomputer/email/migrations/d1`; it is authoritative for every CHECK,
 * partial index, and storage invariant.
 */
export * from "./storage/d1/schema.js"
