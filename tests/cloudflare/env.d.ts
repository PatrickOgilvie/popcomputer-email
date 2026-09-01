declare global {
  namespace Cloudflare {
    interface Env {
      readonly EMAIL_DB: D1Database
      readonly EMAIL_RAW: R2Bucket
      readonly TEST_MIGRATIONS: ReadonlyArray<{
        readonly name: string
        readonly queries: ReadonlyArray<string>
      }>
    }
  }
}

export {}
