/**
 * Structural contract test for `readAgentConfigForAgent()` in
 * `src/heart/auth/auth-flow.ts` — the entry point that takes `bundlesRoot`
 * as a parameter and is directly testable with a tmpdir bundle.
 *
 * Previously this function did `parsed as unknown as AgentConfig` with no
 * per-field validation, which let arbitrary garbage in agent.json through
 * unfiltered. The spread-with-validation refactor (same pattern as
 * `loadAgentConfig`) guarantees that senses are normalized and the config
 * round-trips every AgentConfig field.
 *
 * The compile-time regression guard is the `DeepRequired<AgentConfig>`
 * satisfies check on FULL_AGENT_JSON — if any field is added to
 * `AgentConfig`, the fixture must gain a value or this file won't compile.
 *
 * (The sibling `identity-load-contract.test.ts` covers `loadAgentConfig`
 * via an fs mock since `loadAgentConfig` reads from `getAgentRoot()` with
 * no parameter override.)
 */
import { describe, expect, it } from "vitest"

import { readAgentConfigForAgent } from "../../heart/auth/auth-flow"
import { createTmpBundle } from "../test-helpers/tmpdir-bundle"
import { FULL_AGENT_JSON } from "./identity-fixture"

describe("readAgentConfigForAgent structural contract", () => {
  it("round-trips every top-level AgentConfig field when agent.json is fully populated", () => {
    const tmp = createTmpBundle({
      agentName: "identity-contract-read",
      agentJson: FULL_AGENT_JSON as unknown as Record<string, unknown>,
    })
    try {
      const { config } = readAgentConfigForAgent(tmp.agentName, tmp.bundlesRoot)

      expect(config.version).toBe(FULL_AGENT_JSON.version)
      expect(config.enabled).toBe(FULL_AGENT_JSON.enabled)
      expect(config.provider).toBe(FULL_AGENT_JSON.provider)
      expect(config.humanFacing).toEqual(FULL_AGENT_JSON.humanFacing)
      expect(config.agentFacing).toEqual(FULL_AGENT_JSON.agentFacing)
      expect(config.context).toEqual(FULL_AGENT_JSON.context)
      expect(config.logging).toEqual(FULL_AGENT_JSON.logging)
      expect(config.senses).toEqual(FULL_AGENT_JSON.senses)
      expect(config.mcpServers).toEqual(FULL_AGENT_JSON.mcpServers)
      expect(config.shell).toEqual(FULL_AGENT_JSON.shell)
      expect(config.phrases).toEqual(FULL_AGENT_JSON.phrases)
      expect(config.vault).toEqual(FULL_AGENT_JSON.vault)
      expect(config.sync).toEqual(FULL_AGENT_JSON.sync)
    } finally {
      tmp.cleanup()
    }
  })

  it("preserves the sync block (regression for #349)", () => {
    const tmp = createTmpBundle({
      agentName: "identity-contract-sync",
      agentJson: {
        ...FULL_AGENT_JSON,
        sync: { enabled: true, remote: "from-fixture" },
      } as unknown as Record<string, unknown>,
    })
    try {
      const { config } = readAgentConfigForAgent(tmp.agentName, tmp.bundlesRoot)
      expect(config.sync).toEqual({ enabled: true, remote: "from-fixture" })
    } finally {
      tmp.cleanup()
    }
  })

  it("preserves the shell block", () => {
    const tmp = createTmpBundle({
      agentName: "identity-contract-shell",
      agentJson: {
        ...FULL_AGENT_JSON,
        shell: { defaultTimeout: 99_000 },
      } as unknown as Record<string, unknown>,
    })
    try {
      const { config } = readAgentConfigForAgent(tmp.agentName, tmp.bundlesRoot)
      expect(config.shell).toEqual({ defaultTimeout: 99_000 })
    } finally {
      tmp.cleanup()
    }
  })

  it("normalizes senses to defaults when senses omitted from agent.json", () => {
    const noSenses: Record<string, unknown> = { ...FULL_AGENT_JSON }
    delete noSenses.senses
    const tmp = createTmpBundle({
      agentName: "identity-contract-no-senses",
      agentJson: noSenses,
    })
    try {
      const { config } = readAgentConfigForAgent(tmp.agentName, tmp.bundlesRoot)
      expect(config.senses).toEqual({
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: false },
        mail: { enabled: false },
      })
    } finally {
      tmp.cleanup()
    }
  })
})
