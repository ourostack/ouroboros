#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

function parseArgs(argv) {
  let secretsFile = null

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--secrets-file") {
      secretsFile = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }

  if (!secretsFile) {
    throw new Error("usage: node scripts/nightly-real-smoke.cjs --secrets-file <path>")
  }

  return {
    secretsFile: path.resolve(secretsFile),
  }
}

function requireObject(value, fieldPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${fieldPath} must be an object`)
  }
  return value
}

function requireNonEmptyString(value, fieldPath) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldPath} must be a non-empty string`)
  }
  return value.trim()
}

function normalizeRealSmokeInput(raw) {
  const root = requireObject(raw, "root")
  const providerCheck = requireObject(root.providerCheck, "providerCheck")
  const portableChecks = requireObject(root.portableChecks, "portableChecks")

  return {
    providerCheck: {
      provider: requireNonEmptyString(providerCheck.provider, "providerCheck.provider"),
      model: requireNonEmptyString(providerCheck.model, "providerCheck.model"),
      config: requireObject(providerCheck.config, "providerCheck.config"),
    },
    portableChecks: {
      perplexityApiKey: requireNonEmptyString(portableChecks.perplexityApiKey, "portableChecks.perplexityApiKey"),
      openaiEmbeddingsApiKey: requireNonEmptyString(portableChecks.openaiEmbeddingsApiKey, "portableChecks.openaiEmbeddingsApiKey"),
    },
  }
}

function readRealSmokeInput(secretsFile, deps = defaultDeps()) {
  let rawText = ""
  try {
    rawText = deps.readFileSync(secretsFile, "utf8")
  } catch (error) {
    throw new Error(`could not read real smoke secrets file at ${secretsFile}: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    return normalizeRealSmokeInput(JSON.parse(rawText))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`real smoke secrets file at ${secretsFile} is not valid JSON`)
    }
    throw error
  }
}

function redactKnownSecrets(text, secrets) {
  let redacted = String(text)
  const uniqueSecrets = [...new Set(secrets.filter((secret) => typeof secret === "string" && secret.length > 0))]
    .sort((left, right) => right.length - left.length)

  for (const secret of uniqueSecrets) {
    redacted = redacted.split(secret).join("[redacted]")
  }
  return redacted
}

function collectSecretStrings(value) {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap((entry) => collectSecretStrings(entry))
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((entry) => collectSecretStrings(entry))
  }
  return []
}

async function runProviderSmoke(input, deps, knownSecrets) {
  const result = await deps.pingProvider(input.provider, input.config, { model: input.model })
  return {
    ok: result.ok,
    label: `provider ${input.provider} / ${input.model}`,
    message: redactKnownSecrets(result.ok ? "live check passed" : result.message, knownSecrets),
  }
}

async function runCapabilitySmoke(label, verifier, apiKey, knownSecrets) {
  const result = await verifier(apiKey)
  return {
    ok: result.ok,
    label,
    message: redactKnownSecrets(result.summary, knownSecrets),
  }
}

async function runRealSmokeSuite(input, deps = defaultDeps()) {
  const knownSecrets = collectSecretStrings(input)
  return [
    await runProviderSmoke(input.providerCheck, deps, knownSecrets),
    await runCapabilitySmoke("Perplexity search", deps.verifyPerplexityCapability, input.portableChecks.perplexityApiKey, knownSecrets),
    await runCapabilitySmoke("embeddings", deps.verifyEmbeddingsCapability, input.portableChecks.openaiEmbeddingsApiKey, knownSecrets),
  ]
}

function summarizeRealSmokeSuite(results) {
  const ok = results.every((result) => result.ok)
  return {
    ok,
    lines: results.map((result) => `${result.ok ? "PASS" : "FAIL"} ${result.label}: ${result.message}`),
  }
}

function defaultDeps() {
  const { pingProvider } = require(path.resolve(__dirname, "../dist/heart/provider-ping.js"))
  const {
    verifyPerplexityCapability,
    verifyEmbeddingsCapability,
  } = require(path.resolve(__dirname, "../dist/heart/runtime-capability-check.js"))

  return {
    readFileSync: fs.readFileSync,
    pingProvider,
    verifyPerplexityCapability,
    verifyEmbeddingsCapability,
  }
}

async function main(argv = process.argv.slice(2), deps = defaultDeps()) {
  const args = parseArgs(argv)
  const input = readRealSmokeInput(args.secretsFile, deps)
  const results = await runRealSmokeSuite(input, deps)
  const summary = summarizeRealSmokeSuite(results)

  for (const line of summary.lines) {
    const stream = line.startsWith("PASS") ? process.stdout : process.stderr
    stream.write(`real smoke: ${line}\n`)
  }

  if (!summary.ok) {
    process.exitCode = 1
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`real smoke: FAIL: ${message}\n`)
    process.exit(1)
  })
}

module.exports = {
  collectSecretStrings,
  normalizeRealSmokeInput,
  parseArgs,
  readRealSmokeInput,
  redactKnownSecrets,
  runRealSmokeSuite,
  summarizeRealSmokeSuite,
}
