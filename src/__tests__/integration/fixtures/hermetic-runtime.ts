import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { bootstrapProviderStateFromAgentConfig, writeProviderState } from "../../../heart/provider-state"

export type HermeticProviderMode = "ok" | "fail-live-check"

export interface CliRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface HermeticRuntimeHarness {
  agentName: string
  homeDir: string
  bundlesRoot: string
  agentRoot: string
  fakeBinDir: string
  socketPath: string
  providerBaseUrl: string
  runCli: (args: string[]) => Promise<CliRunResult>
  cleanup: () => Promise<void>
}

interface FakeVaultItem {
  id: string
  name: string
  login: {
    username: string
    password: string
    uris: Array<{ uri: string }>
  }
  notes: string
  revisionDate: string
}

interface FakeBwState {
  status: "unauthenticated" | "unlocked"
  serverUrl: string
  email: string
  masterPassword: string
  sessionToken: string
  items: FakeVaultItem[]
}

const AGENT_NAME = "slugger"
const VAULT_SERVER_URL = "https://vault.integration.test"
const VAULT_EMAIL = "slugger@ouro.bot"
const VAULT_UNLOCK_SECRET = "Harness1!"
const PROVIDER_MODEL = "claude-sonnet-4.6"
const RUNNER_PATH = path.resolve(__dirname, "run-built-cli.cjs")
const REPO_ROOT = process.cwd()

function buildProviderCredentialPayload(baseUrl: string, updatedAt: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    kind: "provider-credential",
    provider: "github-copilot",
    updatedAt,
    credentials: {
      githubToken: "integration-token",
    },
    config: {
      baseUrl,
    },
    provenance: {
      source: "manual",
      updatedAt,
    },
  })
}

function writeExecutable(targetPath: string, contents: string): void {
  fs.writeFileSync(targetPath, contents, { mode: 0o755 })
}

function writeUnlockStoreScripts(binDir: string, unlockStatePath: string): void {
  const unlockStateLiteral = JSON.stringify(unlockStatePath)
  writeExecutable(
    path.join(binDir, "security"),
    `#!/usr/bin/env node
const fs = require("fs")
const statePath = ${unlockStateLiteral}
const args = process.argv.slice(2)
function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"))
}
if (args[0] === "find-generic-password") {
  const service = args[args.indexOf("-s") + 1]
  const account = args[args.indexOf("-a") + 1]
  const state = readState()
  const key = service + ":" + account
  const secret = state[key]
  if (typeof secret !== "string" || secret.length === 0) process.exit(44)
  process.stdout.write(secret + "\\n")
  process.exit(0)
}
if (args[0] === "add-generic-password") {
  const service = args[args.indexOf("-s") + 1]
  const account = args[args.indexOf("-a") + 1]
  const secret = args[args.indexOf("-w") + 1]
  const state = readState()
  state[service + ":" + account] = secret
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8")
  process.exit(0)
}
process.stderr.write("unexpected fake security args: " + JSON.stringify(args) + "\\n")
process.exit(1)
`,
  )

  writeExecutable(
    path.join(binDir, "secret-tool"),
    `#!/usr/bin/env node
const fs = require("fs")
const statePath = ${unlockStateLiteral}
const args = process.argv.slice(2)
function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"))
}
if (args[0] === "--version") {
  process.stdout.write("fake-secret-tool 1.0\\n")
  process.exit(0)
}
if (args[0] === "lookup") {
  const service = args[args.indexOf("service") + 1]
  const account = args[args.indexOf("account") + 1]
  const state = readState()
  const secret = state[service + ":" + account]
  if (typeof secret !== "string" || secret.length === 0) process.exit(1)
  process.stdout.write(secret + "\\n")
  process.exit(0)
}
if (args[0] === "store") {
  const service = args[args.indexOf("service") + 1]
  const account = args[args.indexOf("account") + 1]
  const secret = fs.readFileSync(0, "utf8").trim()
  const state = readState()
  state[service + ":" + account] = secret
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8")
  process.exit(0)
}
process.stderr.write("unexpected fake secret-tool args: " + JSON.stringify(args) + "\\n")
process.exit(1)
`,
  )
}

function writeFakeBw(binDir: string, bwStatePath: string): void {
  const bwStateLiteral = JSON.stringify(bwStatePath)
  writeExecutable(
    path.join(binDir, "bw"),
    `#!/usr/bin/env node
const fs = require("fs")
const statePath = ${bwStateLiteral}
const args = process.argv.slice(2)
function readState() {
  return JSON.parse(fs.readFileSync(statePath, "utf8"))
}
function writeState(state) {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\\n", "utf8")
}
function requireSession() {
  if (!process.env.BW_SESSION) {
    process.stderr.write("local bitwarden session missing\\n")
    process.exit(1)
  }
}
function itemMatches(item, search) {
  if (item.name === search) return true
  return Array.isArray(item.login?.uris) && item.login.uris.some((entry) => entry && entry.uri && String(entry.uri).includes(search))
}
if (args[0] === "status") {
  const state = readState()
  process.stdout.write(JSON.stringify({
    status: state.status,
    serverUrl: state.serverUrl || undefined,
    userEmail: state.status === "unlocked" ? state.email : undefined,
  }))
  process.exit(0)
}
if (args[0] === "config" && args[1] === "server") {
  const state = readState()
  state.serverUrl = args[2]
  writeState(state)
  process.exit(0)
}
if (args[0] === "login") {
  const state = readState()
  const email = args[1]
  const password = args[2]
  if (email !== state.email || password !== state.masterPassword) {
    process.stderr.write("invalid master password\\n")
    process.exit(1)
  }
  state.status = "unlocked"
  writeState(state)
  process.stdout.write(state.sessionToken + "\\n")
  process.exit(0)
}
if (args[0] === "unlock") {
  const state = readState()
  const password = args[1]
  if (password !== state.masterPassword) {
    process.stderr.write("invalid master password\\n")
    process.exit(1)
  }
  state.status = "unlocked"
  writeState(state)
  process.stdout.write(state.sessionToken + "\\n")
  process.exit(0)
}
if (args[0] === "sync") {
  requireSession()
  process.exit(0)
}
if (args[0] === "list" && args[1] === "items") {
  requireSession()
  const state = readState()
  const searchIndex = args.indexOf("--search")
  const items = searchIndex === -1
    ? state.items
    : state.items.filter((item) => itemMatches(item, args[searchIndex + 1]))
  process.stdout.write(JSON.stringify(items))
  process.exit(0)
}
if (args[0] === "get" && args[1] === "item") {
  requireSession()
  const state = readState()
  const item = state.items.find((entry) => entry.id === args[2] || entry.name === args[2])
  if (!item) {
    process.stderr.write("item not found\\n")
    process.exit(1)
  }
  process.stdout.write(JSON.stringify(item))
  process.exit(0)
}
if (args[0] === "create" && args[1] === "item") {
  requireSession()
  const state = readState()
  const payload = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"))
  const item = {
    ...payload,
    id: "item-" + String(state.items.length + 1),
    revisionDate: payload.revisionDate || new Date().toISOString(),
  }
  state.items.push(item)
  writeState(state)
  process.stdout.write(JSON.stringify({ id: item.id }))
  process.exit(0)
}
if (args[0] === "edit" && args[1] === "item") {
  requireSession()
  const state = readState()
  const payload = JSON.parse(Buffer.from(fs.readFileSync(0, "utf8").trim(), "base64").toString("utf8"))
  const index = state.items.findIndex((entry) => entry.id === args[2])
  if (index === -1) {
    process.stderr.write("item not found\\n")
    process.exit(1)
  }
  state.items[index] = {
    ...state.items[index],
    ...payload,
    id: state.items[index].id,
    revisionDate: new Date().toISOString(),
  }
  writeState(state)
  process.stdout.write(JSON.stringify({ id: state.items[index].id }))
  process.exit(0)
}
if (args[0] === "delete" && args[1] === "item") {
  requireSession()
  const state = readState()
  state.items = state.items.filter((entry) => entry.id !== args[2])
  writeState(state)
  process.exit(0)
}
process.stderr.write("unexpected fake bw args: " + JSON.stringify(args) + "\\n")
process.exit(1)
`,
  )
}

async function startFakeProviderServer(mode: HermeticProviderMode): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "not found" } }))
      return
    }

    let body = ""
    req.setEncoding("utf8")
    req.on("data", (chunk) => {
      body += chunk
    })
    req.on("end", () => {
      try {
        JSON.parse(body)
      } catch {
        res.writeHead(400, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "invalid json" } }))
        return
      }

      if (mode === "fail-live-check") {
        res.writeHead(401, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "integration test rejected this credential" } }))
        return
      }

      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1,
        model: PROVIDER_MODEL,
        choices: [{
          index: 0,
          message: { role: "assistant", content: "pong" },
          finish_reason: "stop",
        }],
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
      }))
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("fake provider server did not expose a TCP port")
  }

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  }
}

function createAgentJson(): Record<string, unknown> {
  return {
    version: 2,
    enabled: true,
    humanFacing: { provider: "github-copilot", model: PROVIDER_MODEL },
    agentFacing: { provider: "github-copilot", model: PROVIDER_MODEL },
    senses: {
      cli: { enabled: false },
      teams: { enabled: false },
      bluebubbles: { enabled: false },
    },
    sync: { enabled: false },
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
    vault: {
      email: VAULT_EMAIL,
      serverUrl: VAULT_SERVER_URL,
    },
  }
}

function ensureBuildExists(): void {
  const cliPath = path.join(REPO_ROOT, "dist", "heart", "daemon", "daemon-cli.js")
  if (!fs.existsSync(cliPath)) {
    throw new Error("dist/heart/daemon/daemon-cli.js is missing. Run `npm run build` before `npm run test:integration`.")
  }
}

function runSpawnedProcess(command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd: string }): Promise<CliRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.once("error", reject)
    child.once("close", (code) => {
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}

export async function createHermeticRuntimeHarness(
  options: { providerMode?: HermeticProviderMode } = {},
): Promise<HermeticRuntimeHarness> {
  ensureBuildExists()
  const providerMode = options.providerMode ?? "ok"
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-hermetic-runtime-"))
  const homeDir = path.join(tempRoot, "home")
  const bundlesRoot = path.join(homeDir, "AgentBundles")
  const agentRoot = path.join(bundlesRoot, `${AGENT_NAME}.ouro`)
  const fakeBinDir = path.join(tempRoot, "bin")
  const socketPath = path.join(tempRoot, "daemon.sock")
  const bwStatePath = path.join(tempRoot, "fake-bw-state.json")
  const unlockStatePath = path.join(tempRoot, "fake-unlock-state.json")

  fs.mkdirSync(fakeBinDir, { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "state"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "friends"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "inbox"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "journal"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "tasks"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify(createAgentJson(), null, 2)}\n`, "utf8")

  const providerServer = await startFakeProviderServer(providerMode)
  const updatedAt = new Date().toISOString()

  const unlockKey = `ouro.vault:${VAULT_SERVER_URL}:${VAULT_EMAIL}`
  fs.writeFileSync(unlockStatePath, JSON.stringify({ [unlockKey]: VAULT_UNLOCK_SECRET }, null, 2) + "\n", "utf8")
  writeUnlockStoreScripts(fakeBinDir, unlockStatePath)

  const bwState: FakeBwState = {
    status: "unauthenticated",
    serverUrl: "",
    email: VAULT_EMAIL,
    masterPassword: VAULT_UNLOCK_SECRET,
    sessionToken: "bw-session-token",
    items: [{
      id: "provider-github-copilot",
      name: "providers/github-copilot",
      login: {
        username: "github-copilot",
        password: buildProviderCredentialPayload(providerServer.baseUrl, updatedAt),
        uris: [{ uri: "https://providers/github-copilot" }],
      },
      notes: "Ouro provider credentials. The vault item password is a versioned JSON payload.",
      revisionDate: updatedAt,
    }],
  }
  fs.writeFileSync(bwStatePath, JSON.stringify(bwState, null, 2) + "\n", "utf8")
  writeFakeBw(fakeBinDir, bwStatePath)

  const state = bootstrapProviderStateFromAgentConfig({
    machineId: "test-machine",
    now: new Date(updatedAt),
    agentConfig: {
      humanFacing: { provider: "github-copilot", model: PROVIDER_MODEL },
      agentFacing: { provider: "github-copilot", model: PROVIDER_MODEL },
    },
  })
  writeProviderState(agentRoot, state)

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
  }

  let cleaned = false

  return {
    agentName: AGENT_NAME,
    homeDir,
    bundlesRoot,
    agentRoot,
    fakeBinDir,
    socketPath,
    providerBaseUrl: providerServer.baseUrl,
    runCli: async (args: string[]) => {
      return runSpawnedProcess(
        process.execPath,
        [RUNNER_PATH, socketPath, bundlesRoot, homeDir, JSON.stringify(args)],
        { env: baseEnv, cwd: REPO_ROOT },
      )
    },
    cleanup: async () => {
      if (cleaned) return
      cleaned = true
      try {
        await runSpawnedProcess(
          process.execPath,
          [RUNNER_PATH, socketPath, bundlesRoot, homeDir, JSON.stringify(["stop"])],
          { env: baseEnv, cwd: REPO_ROOT },
        )
      } catch {
        // best effort
      }
      await new Promise<void>((resolve) => providerServer.server.close(() => resolve()))
      fs.rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}
