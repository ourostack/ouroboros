const fs = require("fs")
const os = require("os")
const path = require("path")

const DEFAULT_SECRETS_TEMPLATE = {
  providers: {
    // Keep provider field ordering consistent: model first, then auth credentials,
    // then provider-specific transport fields.
    azure: {
      modelName: "",
      apiKey: "",
      endpoint: "",
      deployment: "",
      apiVersion: "2025-04-01-preview",
    },
    minimax: {
      model: "",
      apiKey: "",
    },
    anthropic: {
      model: "claude-opus-4-6",
      setupToken: "",
    },
    "openai-codex": {
      model: "gpt-5.4",
      oauthAccessToken: "",
    },
  },
  teams: {
    clientId: "",
    clientSecret: "",
    tenantId: "",
  },
  oauth: {
    graphConnectionName: "graph",
    adoConnectionName: "ado",
  },
  teamsChannel: {
    skipConfirmation: true,
    port: 3978,
  },
  integrations: {
    perplexityApiKey: "",
    openaiEmbeddingsApiKey: "",
  },
}

function deepMerge(defaults, partial) {
  const result = { ...defaults }
  for (const key of Object.keys(partial)) {
    const left = defaults[key]
    const right = partial[key]
    if (
      right !== null &&
      typeof right === "object" &&
      !Array.isArray(right) &&
      left !== null &&
      typeof left === "object" &&
      !Array.isArray(left)
    ) {
      result[key] = deepMerge(left, right)
      continue
    }
    result[key] = right
  }
  return result
}

function readJsonFile(filePath, label) {
  try {
    const raw = fs.readFileSync(filePath, "utf8")
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function loadAgentSecrets(agent) {
  const agentConfigPath = path.join(process.cwd(), agent, "agent.json")
  readJsonFile(agentConfigPath, "agent config")
  const secretsPath = path.join(os.homedir(), ".agentsecrets", agent, "secrets.json")
  const secretsDir = path.dirname(secretsPath)
  fs.mkdirSync(secretsDir, { recursive: true })

  let onDisk = {}
  try {
    onDisk = readJsonFile(secretsPath, "secrets config")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes("ENOENT")) throw error
  }
  const secrets = deepMerge(DEFAULT_SECRETS_TEMPLATE, onDisk)
  return { secretsPath, secrets }
}

function writeSecrets(secretsPath, secrets) {
  fs.writeFileSync(secretsPath, JSON.stringify(secrets, null, 2) + "\n", "utf8")
}

function setNestedValue(target, pathParts, value) {
  let cursor = target
  for (let i = 0; i < pathParts.length - 1; i += 1) {
    const key = pathParts[i]
    if (
      !(key in cursor) ||
      cursor[key] === null ||
      typeof cursor[key] !== "object" ||
      Array.isArray(cursor[key])
    ) {
      cursor[key] = {}
    }
    cursor = cursor[key]
  }
  cursor[pathParts[pathParts.length - 1]] = value
}

function maskSecret(value) {
  if (!value) return "<empty>"
  if (value.length <= 8) return "*".repeat(value.length)
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

module.exports = {
  loadAgentSecrets,
  maskSecret,
  setNestedValue,
  writeSecrets,
}
