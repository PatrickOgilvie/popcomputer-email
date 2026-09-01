import { readFile, writeFile } from "node:fs/promises"
import { tsImport } from "tsx/esm/api"

const target = new URL("../openapi/email.v1.json", import.meta.url)
const { renderOpenApiDocument } = await tsImport(
  "../src/protocol/openapi.ts",
  import.meta.url,
)
const expected = renderOpenApiDocument()

if (process.argv.includes("--write")) {
  await writeFile(target, expected, "utf8")
  process.stdout.write("openapi: wrote openapi/email.v1.json\n")
  process.exit(0)
}

let actual
try {
  actual = await readFile(target, "utf8")
} catch {
  process.stderr.write(
    "openapi: openapi/email.v1.json is missing; run with --write\n",
  )
  process.exit(1)
}

if (actual !== expected) {
  process.stderr.write(
    "openapi: openapi/email.v1.json is stale; run with --write\n",
  )
  process.exit(1)
}

process.stdout.write("openapi: openapi/email.v1.json is current\n")
