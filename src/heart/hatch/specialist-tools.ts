import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { baseToolDefinitions, settleTool, withCode, type ToolDefinition } from "../../repertoire/tools-base"
import { storeHatchlingProviderCredentials, type HatchCredentialsInput } from "./hatch-flow"
import { playHatchAnimation } from "./hatch-animation"
import { createBundleMeta } from "../../mind/bundle-manifest"
import { resolveDeskRecordPaths } from "../../mind/record-paths"
import { resolveVaultConfig, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { createVaultAccount } from "../../repertoire/vault-setup"
import { promptConfirmedVaultUnlockSecret, resolveVaultUnlockStore, storeVaultUnlockSecret } from "../../repertoire/vault-unlock"

const completeAdoptionTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "complete_adoption",
    description:
      "finalize the agent bundle and hatch the new agent. call this only when you have written all 5 psyche files and agent.json to the temp directory, and the human has approved the bundle. tool execution asks the human for the hatchling vault unlock secret through a hidden terminal prompt; do not ask for or include vault unlock secrets in chat or tool args.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "the PascalCase name for the new agent (e.g. 'MyAgent')",
        },
        handoff_message: {
          type: "string",
          description: "a warm handoff message to display to the human after the agent is hatched",
        },
        phone: {
          type: "string",
          description: "the human's phone number (optional, for iMessage contact recognition)",
        },
        teams_handle: {
          type: "string",
          description: "the human's Teams email/handle (optional, for Teams contact recognition)",
        },
      },
      required: ["name", "handoff_message"],
    },
  },
}

const readFileTool = baseToolDefinitions.find((d) => d.tool.function.name === "read_file")!
const writeFileTool = baseToolDefinitions.find((d) => d.tool.function.name === "write_file")!

const listDirToolSchema: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "list_directory",
    description: "list directory contents",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
}

/**
 * The Ouro AX cards and risk profiles of the two tools only the hatch specialist has; read_file, write_file and settle
 * carry their own. The specialist's executor below runs them, not the dispatcher.
 */
export const specialistToolDefinitions: Array<Required<Pick<ToolDefinition, "tool" | "ax" | "riskProfile">>> = [
  {
    tool: completeAdoptionTool,
    riskProfile: { mutates: ["durable_state_write", "external_side_effect"], risk: "high", reason: "creates the agent bundle, its vault account and its stored credentials" },
    ax: { id: "tool:complete_adoption", group: "hatch", when: "Pick this last, once the five psyche files and agent.json are written and the human approved the bundle, to hatch the new agent.", effect: "write", errors: [
      { code: "missing-name", means: "No name was given for the new agent.", fix: "Call complete_adoption again with name set to the agent's PascalCase name." },
      { code: "invalid-name", means: "The name is not PascalCase, like MyAgent.", fix: "Pick a PascalCase name with the human and call again." },
      { code: "psyche-files-missing", means: "Some of the five psyche files aren't in the temp folder yet.", fix: "Write the listed files with write_file, then call again." },
      { code: "agent-json-missing", means: "agent.json isn't in the temp folder yet.", fix: "Write agent.json with write_file, then call again." },
      { code: "bundle-exists", means: "An agent bundle with this name already exists.", fix: "Choose a different name with the human and call again." },
      { code: "no-secret-prompt", means: "This hatch isn't running in a terminal that can ask for the vault unlock secret.", fix: "Tell the human to run ouro hatch in an interactive terminal." },
      { code: "no-unlock-store", means: "This machine has no local store for the vault unlock secret, so no vault was created.", fix: "Tell the human what the error says this machine is missing; nothing needs undoing." },
      { code: "secret-not-read", means: "The vault unlock secret prompt failed, or the secret was empty, too weak, or typed differently the second time.", fix: "Tell the human the rule in the error, then call complete_adoption again so they can enter the secret twice." },
      { code: "vault-not-created", means: "The vault account couldn't be created, so the files went back to the temp folder.", fix: "Tell the human the error, fix its cause together, then call complete_adoption again." },
      { code: "secrets-not-stored", means: "The vault account exists, but the unlock secret or provider credentials couldn't be saved; the files went back to the temp folder.", fix: "Tell the human the error: a retry under this name can't register the vault again, so pick a new name or recover that vault first." },
    ] },
  },
  {
    tool: listDirToolSchema,
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:list_directory", group: "hatch", when: "Pick this while hatching to see which files a folder holds, such as the temp bundle, before you read or write one.", effect: "read", idempotent: true, errors: [
      { code: "list-failed", means: "The folder couldn't be read, often because the path doesn't exist.", fix: "Check the path, or list its parent folder to find the right one." },
    ] },
  },
]

/**
 * Returns the specialist's tool schema array.
 */
export function getSpecialistTools(): OpenAI.ChatCompletionFunctionTool[] {
  return [completeAdoptionTool, settleTool, readFileTool.tool, writeFileTool.tool, listDirToolSchema]
}

export interface SpecialistExecToolDeps {
  tempDir: string
  credentials: HatchCredentialsInput
  provider: AgentProvider
  bundlesRoot: string
  animationWriter?: (text: string) => void
  humanName?: string
  promptSecret?: (question: string) => Promise<string>
}

const PSYCHE_FILES = ["SOUL.md", "IDENTITY.md", "LORE.md", "TACIT.md", "ASPIRATIONS.md"]

function isPascalCase(name: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(name)
}

function writeReadme(dir: string, purpose: string): void {
  fs.mkdirSync(dir, { recursive: true })
  const readmePath = path.join(dir, "README.md")
  /* v8 ignore next -- defensive: guard against re-scaffold on existing bundle @preserve */
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, `# ${path.basename(dir)}\n\n${purpose}\n`, "utf-8")
  }
}

function scaffoldBundle(bundleRoot: string): void {
  writeReadme(path.join(bundleRoot, "arc"), "Live continuity, claims, obligations, and resume state.")
  writeReadme(path.join(bundleRoot, "arc", "flight-recorder"), "Flight recorder resume and event receipts.")
  writeReadme(path.join(bundleRoot, "desk"), "Durable work and maintained record.")
  writeReadme(path.join(bundleRoot, "desk", "_record"), "Desk record: diary facts and maintained reference notes.")
  writeReadme(path.join(bundleRoot, "friends"), "Known friend records.")
  writeReadme(path.join(bundleRoot, "tasks"), "Task files.")
  writeReadme(path.join(bundleRoot, "tasks", "one-shots"), "One-shot tasks.")
  writeReadme(path.join(bundleRoot, "habits"), "Recurring habits and autonomous rhythms.")
  writeReadme(path.join(bundleRoot, "tasks", "ongoing"), "Ongoing tasks.")
  writeReadme(path.join(bundleRoot, "skills"), "Local skill files.")
  writeReadme(path.join(bundleRoot, "senses"), "Sense-specific config.")
  writeReadme(path.join(bundleRoot, "senses", "teams"), "Teams sense config.")

  const recordPaths = resolveDeskRecordPaths(bundleRoot)
  fs.mkdirSync(recordPaths.diaryDailyDir, { recursive: true })
  fs.mkdirSync(recordPaths.notesRoot, { recursive: true })
  /* v8 ignore next -- defensive: guard against re-scaffold on existing bundle @preserve */
  if (!fs.existsSync(recordPaths.factsPath)) fs.writeFileSync(recordPaths.factsPath, "", "utf-8")
  /* v8 ignore next -- defensive: guard against re-scaffold on existing bundle @preserve */
  if (!fs.existsSync(recordPaths.entitiesPath)) fs.writeFileSync(recordPaths.entitiesPath, "{}\n", "utf-8")
  fs.mkdirSync(path.join(bundleRoot, "arc", "flight-recorder", "events"), { recursive: true })
  fs.mkdirSync(path.join(bundleRoot, "arc", "flight-recorder", "habit-receipts"), { recursive: true })
  fs.mkdirSync(path.join(bundleRoot, "arc", "claims"), { recursive: true })

  // bundle-meta.json
  const meta = createBundleMeta()
  fs.writeFileSync(path.join(bundleRoot, "bundle-meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8")
}

function moveDir(src: string, dest: string): void {
  try {
    fs.renameSync(src, dest)
  } catch {
    /* v8 ignore start -- cross-device fallback: only triggers on EXDEV (e.g. /tmp → different mount), untestable in CI @preserve */
    fs.cpSync(src, dest, { recursive: true })
    fs.rmSync(src, { recursive: true, force: true })
    /* v8 ignore stop */
  }
}

function updateAgentConfig(bundleRoot: string, updates: Record<string, unknown>): void {
  const agentJsonPath = path.join(bundleRoot, "agent.json")
  const parsed = JSON.parse(fs.readFileSync(agentJsonPath, "utf-8")) as Record<string, unknown>
  fs.writeFileSync(agentJsonPath, `${JSON.stringify({ ...parsed, ...updates }, null, 2)}\n`, "utf-8")
}

async function execCompleteAdoption(
  args: Record<string, string>,
  deps: SpecialistExecToolDeps,
): Promise<string> {
  const name = args.name
  const handoffMessage = args.handoff_message

  if (!name) {
    return withCode("error: missing required 'name' parameter", "missing-name")
  }

  if (!isPascalCase(name)) {
    return withCode(`error: name '${name}' must be PascalCase (e.g. 'MyAgent', 'Hatchling')`, "invalid-name")
  }

  // Validate psyche files exist
  const psycheDir = path.join(deps.tempDir, "psyche")
  const missingPsyche = PSYCHE_FILES.filter(
    (f) => !fs.existsSync(path.join(psycheDir, f)),
  )
  if (missingPsyche.length > 0) {
    return withCode(`error: missing psyche files in temp directory: ${missingPsyche.join(", ")}. write them first using write_file.`, "psyche-files-missing")
  }

  // Validate agent.json exists
  const agentJsonPath = path.join(deps.tempDir, "agent.json")
  if (!fs.existsSync(agentJsonPath)) {
    return withCode("error: agent.json not found in temp directory. write it first using write_file.", "agent-json-missing")
  }

  // Validate target doesn't exist
  const targetBundle = path.join(deps.bundlesRoot, `${name}.ouro`)
  if (fs.existsSync(targetBundle)) {
    return withCode(`error: bundle '${name}.ouro' already exists at ${deps.bundlesRoot}. choose a different name.`, "bundle-exists")
  }

  if (!deps.promptSecret) {
    return withCode("error: complete_adoption requires an interactive vault unlock secret prompt. Re-run `ouro hatch` in a terminal so the human can enter a hatchling vault unlock secret without echoing it.", "no-secret-prompt")
  }

  const vault = resolveVaultConfig(name)
  // Resolve the local unlock store before creating the vault account, so a machine without one
  // fails here instead of leaving an orphaned account that a re-run can't register again.
  try {
    resolveVaultUnlockStore({ agentName: name, email: vault.email, serverUrl: vault.serverUrl })
  } catch (error) {
    return withCode(`error: no local store for the vault unlock secret, so no vault was created. ${error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error)}`, "no-unlock-store")
  }

  let vaultUnlockSecret: string
  try {
    vaultUnlockSecret = await promptConfirmedVaultUnlockSecret({
      promptSecret: deps.promptSecret,
      question: `Choose Ouro vault unlock secret for ${vault.email}: `,
      confirmQuestion: `Confirm Ouro vault unlock secret for ${vault.email}: `,
      emptyError: "hatchling vault creation requires an unlock secret. Re-run `ouro hatch` in an interactive terminal and enter a human-chosen unlock secret.",
    })
  } catch (error) {
    return withCode(`error: failed to read hatchling vault unlock secret: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error)}`, "secret-not-read")
  }

  // Keep the bundle inert until vault/provider credentials are durably stored.
  updateAgentConfig(deps.tempDir, { enabled: false, vault })

  // Scaffold structural dirs into tempDir
  scaffoldBundle(deps.tempDir)

  // Move tempDir -> final bundle location
  moveDir(deps.tempDir, targetBundle)

  // Write secrets
  try {
    const vaultResult = await createVaultAccount(name, vault.serverUrl, vault.email, vaultUnlockSecret)
    if (!vaultResult.success) {
      throw new Error(`failed to create vault: ${vaultResult.error}`)
    }
    storeVaultUnlockSecret({ agentName: name, email: vault.email, serverUrl: vault.serverUrl }, vaultUnlockSecret)
    await storeHatchlingProviderCredentials(name, deps.provider, deps.credentials)
  } catch (e) {
    // Rollback: put the files back in the temp directory so the guide can retry after a fix
    try {
      moveDir(targetBundle, deps.tempDir)
    } catch {
      // Best effort cleanup
    }
    const detail = e instanceof Error ? e.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(e)
    // A vault account that was created stays on the server, so a retry under the same name can't register it again.
    return withCode(`error: failed to write secrets: ${detail}`, detail.startsWith("failed to create vault") ? "vault-not-created" : "secrets-not-stored")
  }

  // Create initial friend record if contact info provided
  const phone = args.phone
  const teamsHandle = args.teams_handle
  if (phone || teamsHandle) {
    const friendId = crypto.randomUUID()
    const now = new Date().toISOString()
    const externalIds: Array<{ provider: string; externalId: string; linkedAt: string }> = []
    if (phone) externalIds.push({ provider: "imessage-handle", externalId: phone, linkedAt: now })
    if (teamsHandle) externalIds.push({ provider: "aad", externalId: teamsHandle, linkedAt: now })

    const friendRecord = {
      id: friendId,
      name: deps.humanName ?? "primary",
      trustLevel: "family",
      externalIds,
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    }

    const friendPath = path.join(targetBundle, "friends", `${friendId}.json`)
    fs.writeFileSync(friendPath, JSON.stringify(friendRecord, null, 2), "utf-8")
  }

  updateAgentConfig(targetBundle, { enabled: true })

  // Play hatch animation
  await playHatchAnimation(name, deps.animationWriter)

  // Display handoff message
  /* v8 ignore next -- UI-only: handoff message display, covered by integration @preserve */
  if (handoffMessage && deps.animationWriter) {
    deps.animationWriter(`\n${handoffMessage}\n`)
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.adoption_complete",
    message: "adoption completed successfully",
    meta: { agentName: name, bundlePath: targetBundle },
  })

  return JSON.stringify({ success: true, agentName: name, bundlePath: targetBundle })
}

export type AdoptionOutcome = { ok: true; agentName: string } | { ok: false; error: string }

/**
 * Read a complete_adoption result. Success is JSON; failures are plain `error: ...` text,
 * which must reach the human as a failed adoption rather than a JSON parse crash.
 */
export function parseAdoptionResult(toolResult: unknown): AdoptionOutcome {
  let parsed: unknown = toolResult
  if (typeof toolResult === "string") {
    try {
      parsed = JSON.parse(toolResult)
    } catch {
      const error = toolResult.trim().replace(/^error:\s*/i, "") || "complete_adoption returned nothing"
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.adoption_failed",
        message: "complete_adoption reported a failure",
        meta: { error },
      })
      return { ok: false, error }
    }
  }
  const record = (parsed && typeof parsed === "object" ? parsed : {}) as { success?: unknown; agentName?: unknown; error?: unknown }
  if (record.success === true && typeof record.agentName === "string" && record.agentName) {
    return { ok: true, agentName: record.agentName }
  }
  const error = typeof record.error === "string" && record.error ? record.error : "complete_adoption did not report success"
  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.adoption_failed",
    message: "complete_adoption reported a failure",
    meta: { error },
  })
  return { ok: false, error }
}

/**
 * Create a specialist tool executor with the given dependencies captured in closure.
 */
export function createSpecialistExecTool(
  deps: SpecialistExecToolDeps,
): (name: string, args: Record<string, string>) => Promise<string> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.specialist_exec_tool_created",
    message: "specialist exec tool created",
    meta: { tempDir: deps.tempDir },
  })

  return async (name: string, args: Record<string, string>): Promise<string> => {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.specialist_tool_exec",
      message: "executing specialist tool",
      meta: { tool: name },
    })

    if (name === "complete_adoption") {
      return execCompleteAdoption(args, deps)
    }

    if (name === "read_file") {
      try {
        return fs.readFileSync(args.path, "utf-8")
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive @preserve */ String(e)}`
      }
    }

    if (name === "write_file") {
      try {
        const dir = path.dirname(args.path)
        fs.mkdirSync(dir, { recursive: true })
        const content = typeof args.content === "string"
          ? args.content
          : JSON.stringify(args.content, null, 2)
        fs.writeFileSync(args.path, content, "utf-8")
        return `wrote ${args.path}`
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive @preserve */ String(e)}`
      }
    }

    if (name === "list_directory") {
      try {
        return fs
          .readdirSync(args.path, { withFileTypes: true })
          .map((e) => `${e.isDirectory() ? "d" : "-"}  ${e.name}`)
          .join("\n")
      } catch (e) {
        return withCode(`error: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive @preserve */ String(e)}`, "list-failed")
      }
    }

    return `error: unknown tool '${name}'`
  }
}
