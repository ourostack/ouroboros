import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export interface RuntimeModeDeps {
  existsSync?: (p: string) => boolean
}

export function detectRuntimeMode(
  rootPath: string,
  deps: RuntimeModeDeps = {},
): "dev" | "production" {
  const checkExists = deps.existsSync ?? fs.existsSync

  // 1. Production: installed via npm
  if (
    rootPath.includes("node_modules/@ouro.bot/cli") ||
    rootPath.includes("node_modules/ouro.bot")
  ) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.runtime_mode_detected",
      message: "detected runtime mode",
      meta: { rootPath, mode: "production" },
    })
    return "production"
  }

  // 2-4. Everything else is dev: worktrees, git repos, unknown paths
  // (conservative default: assume dev unless proven production)
  const reason = rootPath.includes(".claude/worktrees/")
    ? "worktree"
    : checkExists(path.join(rootPath, ".git"))
      ? "git-repo"
      : "unknown"

  emitNervesEvent({
    component: "daemon",
    event: "daemon.runtime_mode_detected",
    message: "detected runtime mode",
    meta: { rootPath, mode: "dev", reason },
  })

  return "dev"
}
