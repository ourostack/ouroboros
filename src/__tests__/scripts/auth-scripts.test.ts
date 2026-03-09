import { spawnSync } from "child_process"
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs"
import os from "os"
import path from "path"

import { afterEach, describe, expect, it } from "vitest"

const OPENAI_SCRIPT = path.join(process.cwd(), "scripts", "auth-openai-codex.cjs")
const CLAUDE_SCRIPT = path.join(process.cwd(), "scripts", "auth-claude-setup-token.cjs")

const createdDirs: string[] = []

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}

function writeExecutable(filePath: string, body: string): void {
  writeFileSync(filePath, body, "utf8")
  chmodSync(filePath, 0o755)
}

function createAgentWorkspace(agent: string): { workspaceDir: string; homeDir: string; binDir: string } {
  const workspaceDir = createTempDir("ouro-auth-workspace-")
  const homeDir = createTempDir("ouro-auth-home-")
  const binDir = path.join(workspaceDir, "bin")

  mkdirSync(binDir, { recursive: true })
  mkdirSync(path.join(workspaceDir, agent), { recursive: true })

  writeFileSync(
    path.join(workspaceDir, agent, "agent.json"),
    JSON.stringify(
      {
        version: 1,
        enabled: true,
        provider: "anthropic",
        context: {
          maxTokens: 80000,
          contextMargin: 20,
        },
        phrases: {
          thinking: ["working"],
          tool: ["running tool"],
          followup: ["processing"],
        },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  )

  return { workspaceDir, homeDir, binDir }
}

function runNodeScript(
  scriptPath: string,
  args: string[],
  options: { cwd: string; homeDir: string; binDir: string; input?: string },
): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: options.homeDir,
      PATH: `${options.binDir}:${process.env.PATH ?? ""}`,
    },
    input: options.input,
    encoding: "utf8",
  })
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("auth bootstrap scripts", () => {
  it("bootstraps Codex login on first run and persists oauthAccessToken", () => {
    const agent = "testagent"
    const { workspaceDir, homeDir, binDir } = createAgentWorkspace(agent)
    writeExecutable(
      path.join(binDir, "codex"),
      `#!/bin/sh
set -eu
if [ "\${1-}" = "login" ]; then
  mkdir -p "$HOME/.codex"
  cat > "$HOME/.codex/auth.json" <<'JSON'
{"tokens":{"access_token":"oauth-token-first-run"}}
JSON
  exit 0
fi
echo "unexpected codex invocation: $*" >&2
exit 97
`,
    )

    const result = runNodeScript(
      OPENAI_SCRIPT,
      ["--agent", agent],
      { cwd: workspaceDir, homeDir, binDir },
    )
    expect(result.status).toBe(0)

    const secrets = JSON.parse(
      readFileSync(path.join(homeDir, ".agentsecrets", agent, "secrets.json"), "utf8"),
    ) as Record<string, any>
    expect(secrets.providers["openai-codex"].oauthAccessToken).toBe("oauth-token-first-run")
    expect(secrets.providers["openai-codex"].model).toBe("gpt-5.4")
  })

  it("uses existing Codex auth token without invoking codex login", () => {
    const agent = "testagent"
    const { workspaceDir, homeDir, binDir } = createAgentWorkspace(agent)
    mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    writeFileSync(
      path.join(homeDir, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "oauth-token-existing" } }, null, 2) + "\n",
      "utf8",
    )

    writeExecutable(
      path.join(binDir, "codex"),
      `#!/bin/sh
set -eu
echo "$*" > "$HOME/codex-should-not-run.log"
exit 99
`,
    )

    const result = runNodeScript(
      OPENAI_SCRIPT,
      ["--agent", agent],
      { cwd: workspaceDir, homeDir, binDir },
    )
    expect(result.status).toBe(0)

    const secrets = JSON.parse(
      readFileSync(path.join(homeDir, ".agentsecrets", agent, "secrets.json"), "utf8"),
    ) as Record<string, any>
    expect(secrets.providers["openai-codex"].oauthAccessToken).toBe("oauth-token-existing")
  })

  it("runs claude setup-token flow and writes setupToken from prompt input", () => {
    const agent = "testagent"
    const { workspaceDir, homeDir, binDir } = createAgentWorkspace(agent)
    writeExecutable(
      path.join(binDir, "claude"),
      `#!/bin/sh
set -eu
if [ "\${1-}" = "setup-token" ]; then
  echo "mock setup-token complete"
  exit 0
fi
echo "unexpected claude invocation: $*" >&2
exit 98
`,
    )

    const setupToken = `sk-ant-oat01-${"a".repeat(90)}`
    const result = runNodeScript(
      CLAUDE_SCRIPT,
      ["--agent", agent],
      {
        cwd: workspaceDir,
        homeDir,
        binDir,
        input: `${setupToken}\n`,
      },
    )
    expect(result.status).toBe(0)

    const secrets = JSON.parse(
      readFileSync(path.join(homeDir, ".agentsecrets", agent, "secrets.json"), "utf8"),
    ) as Record<string, any>
    expect(secrets.providers.anthropic.setupToken).toBe(setupToken)
    expect(secrets.providers.anthropic.model).toBe("claude-opus-4-6")
  })

  it("fails fast for invalid claude setup-token format", () => {
    const agent = "testagent"
    const { workspaceDir, homeDir, binDir } = createAgentWorkspace(agent)
    writeExecutable(
      path.join(binDir, "claude"),
      `#!/bin/sh
set -eu
if [ "\${1-}" = "setup-token" ]; then
  exit 0
fi
exit 1
`,
    )

    const result = runNodeScript(
      CLAUDE_SCRIPT,
      ["--agent", agent],
      {
        cwd: workspaceDir,
        homeDir,
        binDir,
        input: "not-a-setup-token\n",
      },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("sk-ant-oat01-")
  })
})
