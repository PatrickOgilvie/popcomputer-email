import path from "node:path"
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-plugin"
import { defineConfig } from "vitest/config"

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations", "d1"),
  )

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          compatibilityDate: "2026-08-22",
          compatibilityFlags: ["nodejs_compat"],
          d1Databases: ["EMAIL_DB"],
          r2Buckets: ["EMAIL_RAW"],
          bindings: { TEST_MIGRATIONS: migrations },
        },
      }),
    ],
    test: {
      include: ["tests/cloudflare/**/*.worker.ts"],
      setupFiles: ["./tests/cloudflare/setup-d1.ts"],
    },
  }
})
