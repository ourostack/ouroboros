import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { buildDefaultAgentTemplate, type AgentProvider } from "../identity"
import { slugify } from "../config"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  getRepoSpecialistIdentitiesDir,
  getSpecialistIdentitySourceDir,
  pickRandomSpecialistIdentity,
  syncSpecialistIdentities,
} from "./hatch-specialist"

export interface HatchCredentialsInput {
  setupToken?: string
  oauthAccessToken?: string
  apiKey?: string
  endpoint?: string
  deployment?: string
}

export interface HatchFlowInput {
  agentName: string
  humanName: string
  provider: AgentProvider
  credentials: HatchCredentialsInput
  migrationPath?: string
}

export interface HatchFlowDeps {
  bundlesRoot?: string
  secretsRoot?: string
  specialistIdentitySourceDir?: string
  specialistIdentityTargetDir?: string
  now?: () => Date
  random?: () => number
}

export interface HatchFlowResult {
  bundleRoot: string
  selectedIdentity: string
  specialistSecretsPath: string
  hatchlingSecretsPath: string
}

function requiredCredentialKeys(provider: AgentProvider): string[] {
  if (provider === "anthropic") return ["setupToken"]
  if (provider === "openai-codex") return ["oauthAccessToken"]
  if (provider === "minimax") return ["apiKey"]
  return ["apiKey", "endpoint", "deployment"]
}

function validateCredentials(provider: AgentProvider, credentials: HatchCredentialsInput): void {
  const missing = requiredCredentialKeys(provider).filter((key) => {
    const value = credentials[key as keyof HatchCredentialsInput]
    return typeof value !== "string" || value.trim().length === 0
  })
  if (missing.length > 0) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.hatch_credentials_error",
      message: "hatch flow credentials validation failed",
      meta: { provider, missing },
    })
    throw new Error(`Missing required credentials for ${provider}: ${missing.join(", ")}`)
  }
}

function buildSecretsTemplate(): Record<string, unknown> {
  return {
    providers: {
      azure: {
        modelName: "gpt-4o-mini",
        apiKey: "",
        endpoint: "",
        deployment: "",
        apiVersion: "2025-04-01-preview",
      },
      minimax: {
        model: "minimax-text-01",
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
      githubConnectionName: "",
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
}

export function writeSecretsFile(
  agentName: string,
  provider: AgentProvider,
  credentials: HatchCredentialsInput,
  secretsRoot: string,
): string {
  const secrets = buildSecretsTemplate() as {
    providers: {
      azure: { apiKey: string; endpoint: string; deployment: string }
      minimax: { apiKey: string }
      anthropic: { setupToken: string }
      "openai-codex": { oauthAccessToken: string }
    }
  }

  if (provider === "anthropic") {
    secrets.providers.anthropic.setupToken = credentials.setupToken!.trim()
  } else if (provider === "openai-codex") {
    secrets.providers["openai-codex"].oauthAccessToken = credentials.oauthAccessToken!.trim()
  } else if (provider === "minimax") {
    secrets.providers.minimax.apiKey = credentials.apiKey!.trim()
  } else {
    secrets.providers.azure.apiKey = credentials.apiKey!.trim()
    secrets.providers.azure.endpoint = credentials.endpoint!.trim()
    secrets.providers.azure.deployment = credentials.deployment!.trim()
  }

  const secretsDir = path.join(secretsRoot, agentName)
  fs.mkdirSync(secretsDir, { recursive: true })
  const secretsPath = path.join(secretsDir, "secrets.json")
  fs.writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf-8")
  return secretsPath
}

function writeReadme(dir: string, purpose: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const readmePath = path.join(dir, "README.md")
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# ${path.basename(dir)}\n\n${purpose}\n`, "utf-8")
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

function formatTaskStem(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
}

function writeHeartbeatTask(bundleRoot: string, now: Date): void {
  const habitsDir = path.join(bundleRoot, "tasks", "habits")
  fs.mkdirSync(habitsDir, { recursive: true })
  const stem = formatTaskStem(now)
  const filePath = path.join(habitsDir, `${stem}-heartbeat.md`)
  const iso = now.toISOString()
  const content = [
    "---",
    "type: habit",
    "category: runtime",
    "title: Heartbeat check-in",
    "status: processing",
    `created: ${iso}`,
    `updated: ${iso}`,
    "requester: system",
    "validator: null",
    "cadence: \"30m\"",
    "scheduledAt: null",
    "lastRun: null",
    "---",
    "",
    "Run a lightweight heartbeat cycle. Review task board and inbox.",
    "",
  ].join("\n")
  fs.writeFileSync(filePath, content, "utf-8")
}

function writeFriendImprint(bundleRoot: string, humanName: string, now: Date): void {
  const friendsDir = path.join(bundleRoot, "friends")
  fs.mkdirSync(friendsDir, { recursive: true })
  const nowIso = now.toISOString()
  const id = `friend-${slugify(humanName) || "friend"}`
  const localExternalId = `${os.userInfo().username}@${os.hostname()}`
  const record = {
    id,
    name: humanName,
    role: "primary",
    trustLevel: "family",
    connections: [],
    externalIds: [
      {
        provider: "local",
        externalId: localExternalId,
        linkedAt: nowIso,
      },
    ],
    tenantMemberships: [],
    toolPreferences: {},
    notes: {},
    totalTokens: 0,
    createdAt: nowIso,
    updatedAt: nowIso,
    schemaVersion: 1,
  }
  fs.writeFileSync(path.join(friendsDir, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf-8")
}

function writeMemoryScaffold(bundleRoot: string): void {
  const memoryRoot = path.join(bundleRoot, "psyche", "memory")
  fs.mkdirSync(path.join(memoryRoot, "daily"), { recursive: true })
  fs.mkdirSync(path.join(memoryRoot, "archive"), { recursive: true })
  fs.writeFileSync(path.join(memoryRoot, "facts.jsonl"), "", "utf-8")
  fs.writeFileSync(path.join(memoryRoot, "entities.json"), "{}\n", "utf-8")
}

function writeHatchlingAgentConfig(bundleRoot: string, input: HatchFlowInput): void {
  const template = buildDefaultAgentTemplate(input.agentName)
  template.provider = input.provider
  template.enabled = true
  fs.writeFileSync(path.join(bundleRoot, "agent.json"), `${JSON.stringify(template, null, 2)}\n`, "utf-8")
}

export async function runHatchFlow(input: HatchFlowInput, deps: HatchFlowDeps = {}): Promise<HatchFlowResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.hatch_flow_start",
    message: "starting hatch flow",
    meta: { agentName: input.agentName, provider: input.provider },
  })

  validateCredentials(input.provider, input.credentials)

  const bundlesRoot = deps.bundlesRoot ?? path.join(os.homedir(), "AgentBundles")
  const secretsRoot = deps.secretsRoot ?? path.join(os.homedir(), ".agentsecrets")
  const sourceIdentities = deps.specialistIdentitySourceDir ?? getSpecialistIdentitySourceDir()
  const targetIdentities = deps.specialistIdentityTargetDir ?? getRepoSpecialistIdentitiesDir()
  const now = deps.now ? deps.now() : new Date()
  const random = deps.random ?? Math.random

  syncSpecialistIdentities({
    sourceDir: sourceIdentities,
    targetDir: targetIdentities,
  })
  const selected = pickRandomSpecialistIdentity({
    identitiesDir: targetIdentities,
    random,
  })

  const specialistSecretsPath = writeSecretsFile("AdoptionSpecialist", input.provider, input.credentials, secretsRoot)
  const hatchlingSecretsPath = writeSecretsFile(input.agentName, input.provider, input.credentials, secretsRoot)

  const bundleRoot = path.join(bundlesRoot, `${input.agentName}.ouro`)
  fs.mkdirSync(bundleRoot, { recursive: true })

  writeReadme(bundleRoot, "Root of this agent bundle.")
  writeReadme(path.join(bundleRoot, "psyche"), "Identity and behavior files.")
  writeReadme(path.join(bundleRoot, "psyche", "memory"), "Persistent memory store.")
  writeReadme(path.join(bundleRoot, "friends"), "Known friend records.")
  writeReadme(path.join(bundleRoot, "tasks"), "Task files.")
  writeReadme(path.join(bundleRoot, "tasks", "habits"), "Recurring tasks.")
  writeReadme(path.join(bundleRoot, "tasks", "one-shots"), "One-shot tasks.")
  writeReadme(path.join(bundleRoot, "tasks", "ongoing"), "Ongoing tasks.")
  writeReadme(path.join(bundleRoot, "skills"), "Local skill files.")
  writeReadme(path.join(bundleRoot, "senses"), "Sense-specific config.")
  writeReadme(path.join(bundleRoot, "senses", "teams"), "Teams sense config.")

  writeHatchlingAgentConfig(bundleRoot, input)
  writeMemoryScaffold(bundleRoot)
  writeFriendImprint(bundleRoot, input.humanName, now)
  writeHeartbeatTask(bundleRoot, now)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.hatch_flow_end",
    message: "completed hatch flow",
    meta: { bundleRoot, identity: selected.fileName },
  })

  return {
    bundleRoot,
    selectedIdentity: selected.fileName,
    specialistSecretsPath,
    hatchlingSecretsPath,
  }
}
