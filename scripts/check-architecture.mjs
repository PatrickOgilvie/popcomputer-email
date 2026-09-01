import fs from "node:fs"
import path from "node:path"
import ts from "typescript"

const sourceRoot = path.resolve("src")

const expectedRootNamespaces = new Set([
  "Address",
  "Email",
  "Inbound",
  "Maintenance",
  "Message",
  "Route",
  "Scope",
  "TestRecipient",
  "Workflow",
])

const expectedEntrypoints = new Set([
  "adapter.ts",
  "client.ts",
  "cloudflare.ts",
  "d1-schema.ts",
  "d1.ts",
  "index.ts",
  "protocol.ts",
  "testing.ts",
])

const toPosix = (value) => value.split(path.sep).join("/")

if (!fs.existsSync(sourceRoot)) {
  process.stderr.write("architecture: src directory is missing\n")
  process.exit(1)
}

const sourceFiles = fs
  .readdirSync(sourceRoot, { recursive: true })
  .filter((file) => /\.(?:ts|tsx)$/.test(file))
  .map(toPosix)

const errors = []

for (const entrypoint of expectedEntrypoints) {
  if (!sourceFiles.includes(entrypoint)) {
    errors.push(`missing public source entry point ${entrypoint}`)
  }
}

const resolveRelative = (from, specifier) => {
  if (!specifier.startsWith(".")) {
    return undefined
  }

  const unresolved = path.resolve(
    sourceRoot,
    path.dirname(from),
    specifier,
  )
  const withoutJs = unresolved.replace(/\.js$/, "")

  for (const candidate of [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    path.join(withoutJs, "index.ts"),
  ]) {
    if (fs.existsSync(candidate)) {
      return toPosix(path.relative(sourceRoot, candidate))
    }
  }

  return undefined
}

const isRuntimeImport = (declaration) => {
  if (declaration.importClause === undefined) {
    return true
  }
  if (declaration.importClause.isTypeOnly) {
    return false
  }

  const bindings = declaration.importClause.namedBindings
  return !(
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  )
}

const isTesting = (file) =>
  file === "testing.ts" || file.startsWith("testing/")

const isCloudflare = (file) =>
  file === "cloudflare.ts" ||
  file.startsWith("adapters/cloudflare/") ||
  file.startsWith("cloudflare/")

const isD1 = (file) =>
  file === "d1.ts" ||
  file === "d1-schema.ts" ||
  file.startsWith("storage/d1/")

const isProtocol = (file) =>
  file === "protocol.ts" || file.startsWith("protocol/")

const isClient = (file) =>
  file === "client.ts" || file.startsWith("client/")

const graph = new Map()

for (const file of sourceFiles) {
  const absolute = path.join(sourceRoot, file)
  const parsed = ts.createSourceFile(
    file,
    fs.readFileSync(absolute, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  )
  const edges = []

  for (const statement of parsed.statements) {
    let specifier

    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifier = statement.moduleSpecifier.text
      if (!isRuntimeImport(statement)) {
        continue
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      specifier = statement.moduleSpecifier.text
    } else {
      continue
    }

    const target = resolveRelative(file, specifier)
    if (target !== undefined) {
      edges.push(target)
    }

    if (
      file.startsWith("core/") &&
      (specifier.startsWith("drizzle-orm") ||
        specifier.startsWith("cloudflare:") ||
        specifier.startsWith("@cloudflare/"))
    ) {
      errors.push(`${file} imports infrastructure package ${specifier}`)
    }
  }

  graph.set(file, edges)

  for (const target of edges) {
    if (isTesting(target) && !isTesting(file)) {
      errors.push(`${file} imports test-only production code from ${target}`)
    }

    if (
      file.startsWith("core/") &&
      (target.startsWith("application/") ||
        target.startsWith("adapters/") ||
        target.startsWith("storage/") ||
        isClient(target) ||
        isProtocol(target) ||
        isCloudflare(target) ||
        isD1(target))
    ) {
      errors.push(`${file} crosses the core boundary into ${target}`)
    }

    if (
      file.startsWith("application/") &&
      (isClient(target) ||
        isProtocol(target) ||
        isCloudflare(target) ||
        isD1(target))
    ) {
      errors.push(`${file} crosses the application boundary into ${target}`)
    }

    if (
      isProtocol(file) &&
      (isClient(target) || isCloudflare(target) || isD1(target))
    ) {
      errors.push(`${file} crosses the protocol boundary into ${target}`)
    }

    if (
      isClient(file) &&
      (isCloudflare(target) || isD1(target) || target.startsWith("application/"))
    ) {
      errors.push(`${file} crosses the client boundary into ${target}`)
    }

    if (isD1(file) && (isClient(target) || isCloudflare(target))) {
      errors.push(`${file} crosses the D1 boundary into ${target}`)
    }
  }
}

const indexPath = path.join(sourceRoot, "index.ts")
if (fs.existsSync(indexPath)) {
  const indexSource = ts.createSourceFile(
    "index.ts",
    fs.readFileSync(indexPath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const rootNamespaces = new Set()

  for (const statement of indexSource.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.moduleSpecifier === undefined ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.exportClause === undefined ||
      !ts.isNamespaceExport(statement.exportClause)
    ) {
      errors.push("src/index.ts may contain only named module namespace exports")
      continue
    }

    rootNamespaces.add(statement.exportClause.name.text)
  }

  for (const expected of expectedRootNamespaces) {
    if (!rootNamespaces.has(expected)) {
      errors.push(`src/index.ts is missing namespace ${expected}`)
    }
  }

  for (const actual of rootNamespaces) {
    if (!expectedRootNamespaces.has(actual)) {
      errors.push(`src/index.ts leaks unexpected namespace ${actual}`)
    }
  }
}

const visiting = new Set()
const visited = new Set()
const stack = []

const visit = (file) => {
  if (visiting.has(file)) {
    const start = stack.indexOf(file)
    errors.push(
      `runtime import cycle: ${[...stack.slice(start), file].join(" -> ")}`,
    )
    return
  }
  if (visited.has(file)) {
    return
  }

  visiting.add(file)
  stack.push(file)
  for (const target of graph.get(file) ?? []) {
    visit(target)
  }
  stack.pop()
  visiting.delete(file)
  visited.add(file)
}

for (const file of sourceFiles) {
  visit(file)
}

if (errors.length > 0) {
  for (const error of new Set(errors)) {
    process.stderr.write(`architecture: ${error}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write(
    `architecture: ${sourceFiles.length} modules, intended entry points, no boundary violations or runtime cycles\n`,
  )
}
