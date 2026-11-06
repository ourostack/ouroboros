/**
 * Shared fixture for the identity-loader structural contract tests.
 *
 * `FULL_AGENT_JSON` is a fully-populated agent.json value that satisfies
 * `DeepRequired<AgentConfig>`. The `satisfies` check is the compile-time
 * regression guard: if any field is added to `AgentConfig`, this fixture
 * must gain a value or TypeScript won't compile.
 *
 * Used by:
 *   - src/__tests__/heart/identity-contract.test.ts (readAgentConfigForAgent)
 *   - src/__tests__/heart/identity-load-contract.test.ts (loadAgentConfig)
 *
 * Lives in a non-.test.ts file so `vi.mock("fs")` in the loadContract test
 * does not leak into the readContract test (which needs real fs for the
 * `createTmpBundle` helper).
 */
import type { AgentConfig } from "../../heart/identity"

// Make every property (including nested) required. If a new optional field
// is added to `AgentConfig`, `FULL_AGENT_JSON` must gain a non-undefined
// value for it or the `satisfies` check below fails to compile.
export type DeepRequired<T> = T extends (...args: unknown[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<NonNullable<T[K]>> }
    : T

export const FULL_AGENT_JSON = {
  version: 2,
  enabled: true,
  // Deprecated legacy field — still part of AgentConfig as `provider?`.
  // Included so the DeepRequired<AgentConfig> satisfies check passes.
  provider: "anthropic",
  humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
  agentFacing: { provider: "minimax", model: "minimax-text-01" },
  context: {
    maxTokens: 12345,
    contextMargin: 15,
  },
  logging: {
    level: "warn",
    sinks: ["ndjson"],
  },
  senses: {
    cli: { enabled: true },
    teams: { enabled: false },
    bluebubbles: { enabled: true },
    mail: { enabled: false },
    voice: { enabled: false },
  },
  mcpServers: {
    "test-server": {
      command: "/usr/local/bin/test-mcp",
      args: ["--flag", "value"],
      env: { FOO: "bar" },
      cwd: "/tmp",
    },
  },
  shell: {
    defaultTimeout: 60_000,
  },
  phrases: {
    thinking: ["deep in thought"],
    tool: ["using tool"],
    followup: ["considering"],
  },
  vault: {
    email: "fixture@ouro.bot",
    serverUrl: "https://vault.example.test",
  },
  sync: {
    enabled: true,
    remote: "fixture-origin",
  },
} as const satisfies DeepRequired<AgentConfig>
