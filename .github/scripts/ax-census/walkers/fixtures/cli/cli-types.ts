// The command union the ts-parser walker cross-checks.
import type { ToolCommand } from "./cli-tool"

// An interface member, and one that inherits its kind.
interface PauseCommand {
  kind: "pause"
}
interface ResumeBase {
  kind: "resume" | "resume.all"
}
interface ResumeCommand extends ResumeBase {
  all?: boolean
}

export type Command =
  | { kind: "up" }
  | { kind: "stop" }
  | { kind: "friend.list" }
  | { kind: "friend.show"; id?: string }
  | { kind: "connect"; target?: string }
  | { kind: "work.card" }
  | { kind: "work.gauntlet" }
  | { kind: "mode.shadow" }
  | { kind: "mode.live" }
  | { kind: "vault.lock" }
  | { kind: "vault.unlock" }
  | ToolCommand
  | ({ kind: "secret.rotate" } & { id?: string })
  | { kind: "hidden" }
  | import("./cli-extra").Extra
  | PauseCommand
  | ResumeCommand
  // Kinds the cross-check can't read as literals: each is an unwalked gap.
  | { kind: `plug.${string}` }
  | Partial<{ kind: "partial" }>
