// The command union the ts-parser walker cross-checks.
import type { ToolCommand } from "./cli-tool"

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
