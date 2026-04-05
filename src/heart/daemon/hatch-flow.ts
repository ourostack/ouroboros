import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { buildDefaultAgentTemplate, PROVIDER_CREDENTIALS, type AgentProvider } from "../identity"
import { slugify } from "../config"
import { emitNervesEvent } from "../../nerves/runtime"
import { writeProviderCredentials } from "./auth-flow"
import { renderHabitFile } from "../habits/habit-parser"
import {
  getRepoSpecialistIdentitiesDir,
  getSpecialistIdentitySourceDir,
  pickRandomSpecialistIdentity,
  syncSpecialistIdentities,
} from "./hatch-specialist"

export interface HatchCredentialsInput {
  setupToken?: string
  refreshToken?: string
  expiresAt?: number
  oauthAccessToken?: string
  apiKey?: string
  endpoint?: string
  deployment?: string
  githubToken?: string
  baseUrl?: string
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
  return PROVIDER_CREDENTIALS[provider].required
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

export function writeSecretsFile(
  agentName: string,
  provider: AgentProvider,
  credentials: HatchCredentialsInput,
  secretsRoot: string,
): string {
  return writeProviderCredentials(agentName, provider, credentials, { secretsRoot }).secretsPath
}

function writeReadme(dir: string, purpose: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const readmePath = path.join(dir, "README.md")
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# ${path.basename(dir)}\n\n${purpose}\n`, "utf-8")
  }
}

function writeHeartbeatHabit(bundleRoot: string, now: Date): void {
  const habitsDir = path.join(bundleRoot, "habits")
  fs.mkdirSync(habitsDir, { recursive: true })
  const filePath = path.join(habitsDir, "heartbeat.md")
  const content = renderHabitFile(
    {
      title: "Heartbeat check-in",
      cadence: "30m",
      status: "active",
      lastRun: "null",
      created: now.toISOString(),
    },
    "Run a lightweight heartbeat cycle. Review task board and inbox.\nCheck on pending obligations. Journal anything important.",
  )
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

function writeDiaryScaffold(bundleRoot: string): void {
  const diaryRoot = path.join(bundleRoot, "diary")
  fs.mkdirSync(path.join(diaryRoot, "daily"), { recursive: true })
  fs.mkdirSync(path.join(diaryRoot, "archive"), { recursive: true })
  fs.writeFileSync(path.join(diaryRoot, "facts.jsonl"), "", "utf-8")
  fs.writeFileSync(path.join(diaryRoot, "entities.json"), "{}\n", "utf-8")
}

function writeHatchlingAgentConfig(bundleRoot: string, input: HatchFlowInput): void {
  const template = buildDefaultAgentTemplate(input.agentName)
  template.provider = input.provider
  template.humanFacing = { provider: input.provider, model: template.humanFacing.model }
  template.agentFacing = { provider: input.provider, model: template.agentFacing.model }
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

  const specialistSecretsPath = writeSecretsFile("SerpentGuide", input.provider, input.credentials, secretsRoot)
  const hatchlingSecretsPath = writeSecretsFile(input.agentName, input.provider, input.credentials, secretsRoot)

  const bundleRoot = path.join(bundlesRoot, `${input.agentName}.ouro`)
  fs.mkdirSync(bundleRoot, { recursive: true })

  writeReadme(bundleRoot, "Root of this agent bundle.")
  writeReadme(path.join(bundleRoot, "psyche"), "Identity and behavior files.")
  writeReadme(path.join(bundleRoot, "diary"), "Persistent diary — things I've learned and remember.")
  writeReadme(path.join(bundleRoot, "friends"), "Known friend records.")
  writeReadme(path.join(bundleRoot, "tasks"), "Task files.")
  writeReadme(path.join(bundleRoot, "tasks", "one-shots"), "One-shot tasks.")
  writeReadme(path.join(bundleRoot, "tasks", "ongoing"), "Ongoing tasks.")
  writeReadme(path.join(bundleRoot, "habits"), "Recurring habits and autonomous rhythms.")
  writeReadme(path.join(bundleRoot, "skills"), "Local skill files.")
  writeReadme(path.join(bundleRoot, "senses"), "Sense-specific config.")
  writeReadme(path.join(bundleRoot, "senses", "teams"), "Teams sense config.")

  writeHatchlingAgentConfig(bundleRoot, input)
  writeDiaryScaffold(bundleRoot)
  writeFriendImprint(bundleRoot, input.humanName, now)
  writeHeartbeatHabit(bundleRoot, now)

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
