import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { baseToolDefinitions, finalAnswerTool } from "../../repertoire/tools-base"
import { writeSecretsFile, type HatchCredentialsInput } from "./hatch-flow"
import { playHatchAnimation } from "./hatch-animation"
import { createBundleMeta } from "../../mind/bundle-manifest"
import type { AgentProvider } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

const completeAdoptionTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "complete_adoption",
    description:
      "finalize the agent bundle and hatch the new agent. call this only when you have written all 5 psyche files and agent.json to the temp directory, and the human has approved the bundle.",
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
      },
      required: ["name", "handoff_message"],
    },
  },
}

const readFileTool = baseToolDefinitions.find((d) => d.tool.function.name === "read_file")!
const writeFileTool = baseToolDefinitions.find((d) => d.tool.function.name === "write_file")!
const listDirTool = baseToolDefinitions.find((d) => d.tool.function.name === "list_directory")!

/**
 * Returns the specialist's tool schema array.
 */
export function getSpecialistTools(): OpenAI.ChatCompletionFunctionTool[] {
  return [completeAdoptionTool, finalAnswerTool, readFileTool.tool, writeFileTool.tool, listDirTool.tool]
}

export interface SpecialistExecToolDeps {
  tempDir: string
  credentials: HatchCredentialsInput
  provider: AgentProvider
  bundlesRoot: string
  secretsRoot: string
  animationWriter?: (text: string) => void
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
  writeReadme(path.join(bundleRoot, "memory"), "Persistent memory store.")
  writeReadme(path.join(bundleRoot, "memory", "daily"), "Daily memory entries.")
  writeReadme(path.join(bundleRoot, "memory", "archive"), "Archived memory.")
  writeReadme(path.join(bundleRoot, "friends"), "Known friend records.")
  writeReadme(path.join(bundleRoot, "tasks"), "Task files.")
  writeReadme(path.join(bundleRoot, "tasks", "habits"), "Recurring tasks.")
  writeReadme(path.join(bundleRoot, "tasks", "one-shots"), "One-shot tasks.")
  writeReadme(path.join(bundleRoot, "tasks", "ongoing"), "Ongoing tasks.")
  writeReadme(path.join(bundleRoot, "skills"), "Local skill files.")
  writeReadme(path.join(bundleRoot, "senses"), "Sense-specific config.")
  writeReadme(path.join(bundleRoot, "senses", "teams"), "Teams sense config.")

  // Memory scaffold files
  const memoryRoot = path.join(bundleRoot, "memory")
  const factsPath = path.join(memoryRoot, "facts.jsonl")
  const entitiesPath = path.join(memoryRoot, "entities.json")
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

  // Scaffold structural dirs into tempDir
  scaffoldBundle(deps.tempDir)

  // Move tempDir -> final bundle location
  moveDir(deps.tempDir, targetBundle)

  // Write secrets
  try {
    writeSecretsFile(name, deps.provider, deps.credentials, deps.secretsRoot)
  } catch (e) {
    // Rollback: remove the moved bundle
    try {
      fs.rmSync(targetBundle, { recursive: true, force: true })
    } catch {
      // Best effort cleanup
    }
    return `error: failed to write secrets: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(e)}`
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
        fs.writeFileSync(args.path, args.content, "utf-8")
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
