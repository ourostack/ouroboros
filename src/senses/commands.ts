import type { Channel } from "../mind/prompt"
import { getAgentName } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

export interface CommandContext {
  channel: Channel
}

export interface CommandResult {
  action: "exit" | "new" | "response"
  message?: string
}

export interface Command {
  name: string
  description: string
  channels: Channel[]
  handler: (ctx: CommandContext) => CommandResult
}

export interface DispatchResult {
  handled: boolean
  result?: CommandResult
}

export interface CommandRegistry {
  register(cmd: Command): void
  get(name: string): Command | undefined
  list(channel: Channel): Command[]
  dispatch(name: string, ctx: CommandContext): DispatchResult
}

export function createCommandRegistry(): CommandRegistry {
  const commands = new Map<string, Command>()

  return {
    register(cmd: Command): void {
      commands.set(cmd.name, cmd)
    },
    get(name: string): Command | undefined {
      return commands.get(name)
    },
    list(channel: Channel): Command[] {
      return [...commands.values()].filter((c) => c.channels.includes(channel))
    },
    dispatch(name: string, ctx: CommandContext): DispatchResult {
      const cmd = commands.get(name)
      if (!cmd) return { handled: false }
      return { handled: true, result: cmd.handler(ctx) }
    },
  }
}

// Module-level toggle for tool-required mode
let _toolChoiceRequired = false

export function getToolChoiceRequired(): boolean {
  return _toolChoiceRequired
}

export function resetToolChoiceRequired(): void {
  _toolChoiceRequired = false
}

// Module-level toggle for debug mode
let _debugMode = false

export function getDebugMode(): boolean {
  return _debugMode
}

export function resetDebugMode(): void {
  _debugMode = false
}

export function registerDefaultCommands(registry: CommandRegistry): void {
  emitNervesEvent({
    event: "repertoire.load_start",
    component: "repertoire",
    message: "registering default commands",
    meta: {},
  })

  registry.register({
    name: "exit",
    description: `quit ${getAgentName()}`,
    channels: ["cli"],
    handler: () => ({ action: "exit" }),
  })

  registry.register({
    name: "new",
    description: "start a new conversation",
    channels: ["cli", "teams"],
    handler: () => ({ action: "new" }),
  })

  registry.register({
    name: "commands",
    description: "list available commands",
    channels: ["cli", "teams"],
    handler: (ctx) => {
      const cmds = registry.list(ctx.channel)
      const lines = cmds.map((c) => `/${c.name} - ${c.description}`)
      return { action: "response", message: lines.join("\n") }
    },
  })

  registry.register({
    name: "tool-required",
    description: "toggle tool_choice required mode (forces tool calls)",
    channels: ["cli"],
    handler: () => {
      _toolChoiceRequired = !_toolChoiceRequired
      return { action: "response", message: `tool-required mode: ${_toolChoiceRequired ? "ON" : "OFF"}` }
    },
  })

  registry.register({
    name: "debug",
    description: "toggle debug mode (verbose tool output)",
    channels: ["cli", "teams", "bluebubbles"],
    handler: () => {
      _debugMode = !_debugMode
      return { action: "response", message: `debug mode: ${_debugMode ? "ON" : "OFF"}` }
    },
  })

  emitNervesEvent({
    event: "repertoire.load_end",
    component: "repertoire",
    message: "registered default commands",
    meta: {},
  })
}

let _sharedRegistry: CommandRegistry | null = null

export function getSharedCommandRegistry(): CommandRegistry {
  if (!_sharedRegistry) {
    _sharedRegistry = createCommandRegistry()
    registerDefaultCommands(_sharedRegistry)
  }
  return _sharedRegistry
}

export function resetSharedCommandRegistry(): void {
  _sharedRegistry = null
}

export function parseSlashCommand(input: string): { command: string; args: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith("/")) return null
  // Reject // (double slash)
  if (trimmed.startsWith("//")) return null
  const rest = trimmed.slice(1)
  if (!rest) return null
  const spaceIdx = rest.indexOf(" ")
  if (spaceIdx === -1) {
    return { command: rest.toLowerCase(), args: "" }
  }
  return { command: rest.slice(0, spaceIdx).toLowerCase(), args: rest.slice(spaceIdx + 1) }
}
