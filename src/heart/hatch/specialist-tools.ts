import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { baseToolDefinitions, settleTool } from "../../repertoire/tools-base"
import { storeHatchlingProviderCredentials, type HatchCredentialsInput } from "./hatch-flow"
import { playHatchAnimation } from "./hatch-animation"
import { createBundleMeta } from "../../mind/bundle-manifest"
import { resolveVaultConfig, type AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import { createVaultAccount } from "../../repertoire/vault-setup"
import { storeVaultUnlockSecret } from "../../repertoire/vault-unlock"

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
          description: "the PascalCase name for the new agent (e.g. 'Slugger')",
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
  writeReadme(path.join(bundleRoot, "notes"), "Persistent notes store.")
  writeReadme(path.join(bundleRoot, "notes", "daily"), "Daily note entries.")
  writeReadme(path.join(bundleRoot, "notes", "archive"), "Archived notes.")
  writeReadme(path.join(bundleRoot, "friends"), "Known friend records.")
  writeReadme(path.join(bundleRoot, "tasks"), "Task files.")
  writeReadme(path.join(bundleRoot, "tasks", "one-shots"), "One-shot tasks.")
  writeReadme(path.join(bundleRoot, "habits"), "Recurring habits and autonomous rhythms.")
  writeReadme(path.join(bundleRoot, "tasks", "ongoing"), "Ongoing tasks.")
  writeReadme(path.join(bundleRoot, "skills"), "Local skill files.")
  writeReadme(path.join(bundleRoot, "senses"), "Sense-specific config.")
  writeReadme(path.join(bundleRoot, "senses", "teams"), "Teams sense config.")

  // Notes scaffold files
  const notesRoot = path.join(bundleRoot, "notes")
  const factsPath = path.join(notesRoot, "facts.jsonl")
  const entitiesPath = path.join(notesRoot, "entities.json")
  /* v8 ignore next -- defensive: guard against re-scaffold on existing bundle @preserve */
  if (!fs.existsSync(factsPath)) fs.writeFileSync(factsPath, "", "utf-8")
  /* v8 ignore next -- defensive: guard against re-scaffold on existing bundle @preserve */
  if (!fs.existsSync(entitiesPath)) fs.writeFileSync(entitiesPath, "{}\n", "utf-8")

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

async function execCompleteAdoption(
  args: Record<string, string>,
  deps: SpecialistExecToolDeps,
): Promise<string> {
  const name = args.name
  const handoffMessage = args.handoff_message

  if (!name) {
    return "error: missing required 'name' parameter"
  }

  if (!isPascalCase(name)) {
    return `error: name '${name}' must be PascalCase (e.g. 'Slugger', 'MyAgent')`
  }

  // Validate psyche files exist
  const psycheDir = path.join(deps.tempDir, "psyche")
  const missingPsyche = PSYCHE_FILES.filter(
    (f) => !fs.existsSync(path.join(psycheDir, f)),
  )
  if (missingPsyche.length > 0) {
    return `error: missing psyche files in temp directory: ${missingPsyche.join(", ")}. write them first using write_file.`
  }

  // Validate agent.json exists
  const agentJsonPath = path.join(deps.tempDir, "agent.json")
  if (!fs.existsSync(agentJsonPath)) {
    return "error: agent.json not found in temp directory. write it first using write_file."
  }

  // Validate target doesn't exist
  const targetBundle = path.join(deps.bundlesRoot, `${name}.ouro`)
  if (fs.existsSync(targetBundle)) {
    return `error: bundle '${name}.ouro' already exists at ${deps.bundlesRoot}. choose a different name.`
  }

  if (!deps.promptSecret) {
    return "error: complete_adoption requires an interactive vault unlock secret prompt. Re-run `ouro hatch` in a terminal so the human can enter a hatchling vault unlock secret without echoing it."
  }

  const vault = resolveVaultConfig(name)
  let vaultUnlockSecret: string
  try {
    vaultUnlockSecret = (await deps.promptSecret(`Choose Ouro vault unlock secret for ${vault.email}: `)).trim()
  } catch (error) {
    return `error: failed to read hatchling vault unlock secret: ${error instanceof Error ? error.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(error)}`
  }
  if (!vaultUnlockSecret) {
    return "error: hatchling vault creation requires an unlock secret. Re-run `ouro hatch` in an interactive terminal and enter a human-chosen unlock secret."
  }

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
    // Rollback: remove the moved bundle
    try {
      fs.rmSync(targetBundle, { recursive: true, force: true })
    } catch {
      // Best effort cleanup
    }
    return `error: failed to write secrets: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(e)}`
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
        return `error: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive @preserve */ String(e)}`
      }
    }

    return `error: unknown tool '${name}'`
  }
}
