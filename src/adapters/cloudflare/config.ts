import { Redacted } from "effect"

/** Fetch-compatible function injected into Cloudflare REST adapters. */
export type CloudflareFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

/** Cloudflare account and redacted API credential for email REST adapters. */
export interface CloudflareEmailApiConfig {
  readonly accountId: string
  readonly apiToken: Redacted.Redacted<string>
}

/** Return true when the REST adapter has a minimally usable configuration. */
export const hasUsableCloudflareEmailConfig = (
  config: CloudflareEmailApiConfig,
): boolean =>
  config.accountId.trim().length > 0 &&
  Redacted.value(config.apiToken).trim().length > 0

/** Build Cloudflare authorization headers, unwrapping the token only at I/O. */
export const cloudflareAuthorizationHeaders = (
  config: CloudflareEmailApiConfig,
): Headers => {
  const headers = new Headers()
  headers.set("Authorization", `Bearer ${Redacted.value(config.apiToken)}`)
  return headers
}

/** Build an account-scoped Cloudflare v4 API URL. */
export const cloudflareAccountUrl = (
  config: CloudflareEmailApiConfig,
  path: string,
): string =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/${path}`
