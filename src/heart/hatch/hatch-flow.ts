import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { buildDefaultAgentTemplate, PROVIDER_CREDENTIALS, resolveVaultConfig, type AgentProvider } from "../identity"
import { slugify } from "../config"
import { emitNervesEvent } from "../../nerves/runtime"
import { storeProviderCredentials } from "../auth/auth-flow"
import { getDefaultModelForProvider } from "../provider-models"
import { renderHabitFile } from "../habits/habit-parser"
import { createBundleMeta } from "../../mind/bundle-manifest"
import { resolveDeskRecordPaths } from "../../mind/record-paths"
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
  specialistIdentitySourceDir?: string
  specialistIdentityTargetDir?: string
  now?: () => Date
  random?: () => number
}

export interface HatchFlowResult {
  bundleRoot: string
  selectedIdentity: string
  credentialPath: string
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

export async function storeHatchlingProviderCredentials(
  agentName: string,
  provider: AgentProvider,
  credentials: HatchCredentialsInput,
): Promise<string> {
  return (await storeProviderCredentials(agentName, provider, credentials)).credentialPath
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
      created: now.toISOString(),
    },
    "Run a lightweight heartbeat cycle. Review task board and inbox.\nCheck on pending obligations. Write important durable outputs to Arc or Desk record.",
  )
  fs.writeFileSync(filePath, content, "utf-8")
}

function writeFriendImprint(bundleRoot: string, humanName: string, now: Date): void {
  const friendsDir = path.join(bundleRoot, "friends")
  fs.mkdirSync(friendsDir, { recursive: true })
  const nowIso = now.toISOString()
  const id = `friend-${slugify(humanName) || "friend"}`
  const localExternalId = os.userInfo().username
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

function writeRecordScaffold(bundleRoot: string): void {
  const recordPaths = resolveDeskRecordPaths(bundleRoot)
  fs.mkdirSync(recordPaths.diaryDailyDir, { recursive: true })
  fs.mkdirSync(recordPaths.notesRoot, { recursive: true })
  fs.writeFileSync(recordPaths.factsPath, "", "utf-8")
  fs.writeFileSync(recordPaths.entitiesPath, "{}\n", "utf-8")
  fs.mkdirSync(path.join(bundleRoot, "arc", "flight-recorder", "events"), { recursive: true })
  fs.mkdirSync(path.join(bundleRoot, "arc", "flight-recorder", "habit-receipts"), { recursive: true })
  fs.mkdirSync(path.join(bundleRoot, "arc", "flight-recorder", "context-loss-sentinel", "history"), { recursive: true })
  fs.mkdirSync(path.join(bundleRoot, "arc", "flight-recorder", "context-loss-sentinel", "receipts"), { recursive: true })
  fs.mkdirSync(path.join(bundleRoot, "arc", "claims"), { recursive: true })
}

function writeHatchlingAgentConfig(bundleRoot: string, input: HatchFlowInput): void {
  const template = buildDefaultAgentTemplate(input.agentName)
  const model = getDefaultModelForProvider(input.provider)
  template.provider = input.provider
  template.humanFacing = { provider: input.provider, model }
  template.agentFacing = { provider: input.provider, model }
  template.vault = resolveVaultConfig(input.agentName)
  template.enabled = false
  fs.writeFileSync(path.join(bundleRoot, "agent.json"), `${JSON.stringify(template, null, 2)}\n`, "utf-8")
}

function setHatchlingEnabled(bundleRoot: string, enabled: boolean): void {
  const agentJsonPath = path.join(bundleRoot, "agent.json")
  const parsed = JSON.parse(fs.readFileSync(agentJsonPath, "utf-8")) as Record<string, unknown>
  parsed.enabled = enabled
  fs.writeFileSync(agentJsonPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf-8")
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

  const bundleRoot = path.join(bundlesRoot, `${input.agentName}.ouro`)
  fs.mkdirSync(bundleRoot, { recursive: true })

  writeReadme(bundleRoot, "Root of this agent bundle.")
  writeReadme(path.join(bundleRoot, "psyche"), "Identity and behavior files.")
  writeReadme(path.join(bundleRoot, "arc"), "Live continuity, claims, obligations, and resume state.")
  writeReadme(path.join(bundleRoot, "desk"), "Durable work and maintained record.")
  writeReadme(path.join(bundleRoot, "desk", "_record"), "Desk record: diary facts and maintained reference notes.")
  writeReadme(path.join(bundleRoot, "friends"), "Known friend records.")
  writeReadme(path.join(bundleRoot, "tasks"), "Task files.")
  writeReadme(path.join(bundleRoot, "tasks", "one-shots"), "One-shot tasks.")
  writeReadme(path.join(bundleRoot, "tasks", "ongoing"), "Ongoing tasks.")
  writeReadme(path.join(bundleRoot, "habits"), "Recurring habits and autonomous rhythms.")
  writeReadme(path.join(bundleRoot, "skills"), "Local skill files.")
  writeReadme(path.join(bundleRoot, "senses"), "Sense-specific config.")
  writeReadme(path.join(bundleRoot, "senses", "teams"), "Teams sense config.")

  writeHatchlingAgentConfig(bundleRoot, input)
  fs.writeFileSync(path.join(bundleRoot, "bundle-meta.json"), `${JSON.stringify(createBundleMeta(), null, 2)}\n`, "utf-8")
  const credentialPath = await storeHatchlingProviderCredentials(input.agentName, input.provider, input.credentials)
  writeRecordScaffold(bundleRoot)
  writeFriendImprint(bundleRoot, input.humanName, now)
  writeHeartbeatHabit(bundleRoot, now)
  setHatchlingEnabled(bundleRoot, true)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.hatch_flow_end",
    message: "completed hatch flow",
    meta: { bundleRoot, identity: selected.fileName },
  })

  return {
    bundleRoot,
    selectedIdentity: selected.fileName,
    credentialPath,
  }
}
