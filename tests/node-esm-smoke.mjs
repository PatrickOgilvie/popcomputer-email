const entrypoints = await Promise.all([
  import("@popcomputer/email"),
  import("@popcomputer/email/adapter"),
  import("@popcomputer/email/client"),
  import("@popcomputer/email/protocol"),
  import("@popcomputer/email/cloudflare"),
  import("@popcomputer/email/d1"),
  import("@popcomputer/email/d1/schema"),
  import("@popcomputer/email/testing"),
])

const [
  root,
  adapter,
  client,
  protocol,
  cloudflare,
  d1,
  d1Schema,
  testing,
] = entrypoints

const expectedRootNamespaces = [
  "Address",
  "Email",
  "Inbound",
  "Maintenance",
  "Message",
  "Route",
  "Scope",
  "TestRecipient",
  "Workflow",
]

for (const namespace of expectedRootNamespaces) {
  if (!(namespace in root)) {
    throw new Error(`Root entry point is missing ${namespace}`)
  }
}

if (root.Email.Service === undefined) {
  throw new Error("Email.Service is not available from the package root")
}

for (const [name, module] of [
  ["adapter", adapter],
  ["client", client],
  ["protocol", protocol],
  ["cloudflare", cloudflare],
  ["d1", d1],
  ["d1/schema", d1Schema],
  ["testing", testing],
]) {
  if (Object.keys(module).length === 0) {
    throw new Error(`The ${name} entry point is empty`)
  }
}

const migration = import.meta.resolve(
  "@popcomputer/email/migrations/d1/0001_email.sql",
)
if (!migration.endsWith("/migrations/d1/0001_email.sql")) {
  throw new Error("The package-owned D1 migration is not resolvable")
}
