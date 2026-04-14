import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it } from "vitest"

import { agentConfigV2Hook } from "../../../../heart/daemon/hooks/agent-config-v2"
import type { UpdateHookContext } from "../../../../heart/versioning/update-hooks"

const createdDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("agentConfigV2Hook", () => {
  it("migrates v1 config to v2 successfully", async () => {
    const agentRoot = createTempDir("agent-config-v2-hook-migrate-")
    const configPath = path.join(agentRoot, "agent.json")
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        enabled: true,
        provider: "anthropic",
        phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
      }, null, 2) + "\n",
    )

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: "0.0.1",
    }

    const result = await agentConfigV2Hook(ctx)

    expect(result.ok).toBe(true)
    const updated = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
    expect(updated.version).toBe(2)
    expect(updated.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
    expect(updated.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
  })

  it("is idempotent on v2 configs (no-op, files untouched)", async () => {
    const agentRoot = createTempDir("agent-config-v2-hook-noop-")
    const configPath = path.join(agentRoot, "agent.json")
    const v2Config = {
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      phrases: { thinking: ["working"], tool: ["running tool"], followup: ["processing"] },
    }
    const configStr = JSON.stringify(v2Config, null, 2) + "\n"
    fs.writeFileSync(configPath, configStr)
    const mtimeBefore = fs.statSync(configPath).mtimeMs

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: "0.0.1",
    }

    // Small delay to ensure mtime would differ if file is rewritten
    await new Promise((r) => setTimeout(r, 10))
    const result = await agentConfigV2Hook(ctx)

    expect(result.ok).toBe(true)
    // File should not have been modified
    const mtimeAfter = fs.statSync(configPath).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
  })

  it("returns ok: false on malformed config (does not throw)", async () => {
    const agentRoot = createTempDir("agent-config-v2-hook-malformed-")
    const configPath = path.join(agentRoot, "agent.json")
    fs.writeFileSync(configPath, "not-valid-json{{{")

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: undefined,
    }

    const result = await agentConfigV2Hook(ctx)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(typeof result.error).toBe("string")
  })

  it("returns ok: true when no agent.json exists (nothing to migrate)", async () => {
    const agentRoot = createTempDir("agent-config-v2-hook-missing-")
    // No agent.json

    const ctx: UpdateHookContext = {
      agentRoot,
      currentVersion: "0.1.0",
      previousVersion: undefined,
    }

    const result = await agentConfigV2Hook(ctx)

    expect(result.ok).toBe(true)
  })
})

describe("agentConfigV2Hook registration", () => {
  it("is registered alongside bundleMetaHook in daemon.ts", async () => {
    const daemonSource = fs.readFileSync(
      path.join(process.cwd(), "src", "heart", "daemon", "daemon.ts"),
      "utf-8",
    )
    expect(daemonSource).toContain("registerUpdateHook(agentConfigV2Hook)")
  })

  it("is registered alongside bundleMetaHook in cli-exec.ts", async () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), "src", "heart", "daemon", "cli-exec.ts"),
      "utf-8",
    )
    expect(cliSource).toContain("registerUpdateHook(agentConfigV2Hook)")
  })

  it("is registered alongside bundleMetaHook in run-hooks.ts", async () => {
    const runHooksSource = fs.readFileSync(
      path.join(process.cwd(), "src", "heart", "daemon", "run-hooks.ts"),
      "utf-8",
    )
    expect(runHooksSource).toContain("agentConfigV2Hook")
  })

  it("is registered alongside bundleMetaHook in cli.ts", async () => {
    const cliSource = fs.readFileSync(
      path.join(process.cwd(), "src", "senses", "cli.ts"),
      "utf-8",
    )
    expect(cliSource).toContain("registerUpdateHook(agentConfigV2Hook)")
  })
})
