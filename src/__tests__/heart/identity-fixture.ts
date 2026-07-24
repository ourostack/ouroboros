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
    a2a: { enabled: false },
    workbench: { enabled: true },
  },
  mcpServers: {
    "test-server": {
      command: "/usr/local/bin/test-mcp",
      args: ["--flag", "value"],
      env: { FOO: "bar" },
      cwd: "/tmp",
      visibility: "internal",
    },
  },
  habitExecutors: [
    {
      version: 1,
      id: "fixture-executor",
      serverId: "test-server",
      toolName: "fixture_run",
      habitInputSchema: { root: "bundle", ref: "schemas/habit-input.json", sha256: `sha256:${"a".repeat(64)}` },
      toolInputSchema: { root: "package", ref: "mcp/tool-input.json", sha256: `sha256:${"b".repeat(64)}` },
      resultSchema: { root: "bundle", ref: "schemas/result.json", sha256: `sha256:${"c".repeat(64)}` },
      timeoutMs: 30_000,
      idempotencyField: "ouroOccurrence",
      credentialBindings: [
        {
          name: "fixture-token",
          source: { scope: "agent-runtime-config", jsonPointer: "/fixture/token" },
        },
      ],
      reconciliation: null,
    },
  ],
  mcpHealthProfiles: [
    {
      schemaVersion: 1,
      profileId: "fixture-health",
      serverId: "test-server",
      registryRevision: `sha256:${"d".repeat(64)}`,
      expectedTools: [
        {
          name: "fixture_status",
          inputSchema: { root: "bundle", ref: "schemas/status-input.json", sha256: `sha256:${"e".repeat(64)}` },
          outputSchema: null,
        },
      ],
      credentialBindingNames: ["fixture-token"],
      mode: "inventory-schema-credential-readiness",
      readOnlyProbe: null,
      timeoutMs: 5_000,
      freshnessMs: 300_000,
    },
  ],
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
  // W5.1 plugin support — added 2026-05-18 (worker-generalization wave).
  // Bundles may declare which installed plugins they have enabled.
  plugins: [
    {
      id: "desk",
      enabled: true,
      source: "github:ourostack/ouroboros-skills:plugins/desk",
      version: "0.1.0",
    },
  ],
} as const satisfies DeepRequired<AgentConfig>
