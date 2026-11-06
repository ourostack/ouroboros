/**
 * Unit 2a: tests for loadDriftInputsForAgent — the I/O layer that reads
 * agent.json and state/providers.json off disk and returns the typed inputs
 * the comparator (Unit 1) needs.
 *
 * Behavioral contract pinned by these tests:
 * - Reads `<bundlesRoot>/<agentName>.ouro/agent.json` and parses it as JSON.
 * - Reads `<bundlesRoot>/<agentName>.ouro/state/providers.json` via
 *   readProviderState — maps the `missing` and `invalid` cases to a `null`
 *   providerState (the comparator interprets null as "no observed binding").
 * - `agent.json` missing → throws (caller decides whether to swallow).
 * - `agent.json` malformed JSON → throws.
 * - The returned agentJson preserves both the legacy humanFacing/agentFacing
 *   keys and the new outward/inner keys verbatim — the comparator is the
 *   one that decides precedence; the loader does no normalization.
 * - The function never writes to disk.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { loadDriftInputsForAgent } from "../../../heart/daemon/drift-detection"

let tmpRoot: string

function makeTmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "drift-loader-"))
}

function bundleDir(bundlesRoot: string, agentName: string): string {
  const dir = path.join(bundlesRoot, `${agentName}.ouro`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeAgentJson(bundlesRoot: string, agentName: string, content: string): void {
  const dir = bundleDir(bundlesRoot, agentName)
  fs.writeFileSync(path.join(dir, "agent.json"), content, "utf-8")
}

function writeProviderState(bundlesRoot: string, agentName: string, content: string): void {
  const dir = bundleDir(bundlesRoot, agentName)
  fs.mkdirSync(path.join(dir, "state"), { recursive: true })
  fs.writeFileSync(path.join(dir, "state", "providers.json"), content, "utf-8")
}

const VALID_PROVIDER_STATE = JSON.stringify({
  schemaVersion: 1,
  machineId: "machine_test",
  updatedAt: "2026-04-28T19:30:00.000Z",
  lanes: {
    outward: {
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "bootstrap",
      updatedAt: "2026-04-28T19:30:00.000Z",
    },
    inner: {
      provider: "anthropic",
      model: "claude-opus-4-6",
      source: "bootstrap",
      updatedAt: "2026-04-28T19:30:00.000Z",
    },
  },
  readiness: {},
})

const VALID_AGENT_JSON = JSON.stringify({
  version: 2,
  enabled: true,
  humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
  agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
  phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
})

beforeEach(() => {
  tmpRoot = makeTmpRoot()
})

afterEach(() => {
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
})

describe("loadDriftInputsForAgent", () => {
  describe("happy paths", () => {
    it("returns parsed agentJson and providerState when both files exist and are valid", () => {
      writeAgentJson(tmpRoot, "alpha", VALID_AGENT_JSON)
      writeProviderState(tmpRoot, "alpha", VALID_PROVIDER_STATE)
      const result = loadDriftInputsForAgent(tmpRoot, "alpha")
      expect(result.agentJson.humanFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
      expect(result.agentJson.agentFacing).toEqual({ provider: "anthropic", model: "claude-opus-4-6" })
      expect(result.providerState).not.toBeNull()
      expect(result.providerState?.lanes.outward.provider).toBe("anthropic")
    })

    it("returns providerState=null when state/providers.json is absent (fresh install)", () => {
      writeAgentJson(tmpRoot, "alpha", VALID_AGENT_JSON)
      const result = loadDriftInputsForAgent(tmpRoot, "alpha")
      expect(result.providerState).toBeNull()
      expect(result.agentJson).toBeDefined()
    })

    it("returns providerState=null when state/providers.json is malformed JSON", () => {
      writeAgentJson(tmpRoot, "alpha", VALID_AGENT_JSON)
      writeProviderState(tmpRoot, "alpha", "{ this is not valid json")
      const result = loadDriftInputsForAgent(tmpRoot, "alpha")
      expect(result.providerState).toBeNull()
    })

    it("returns providerState=null when state/providers.json is structurally invalid", () => {
      writeAgentJson(tmpRoot, "alpha", VALID_AGENT_JSON)
      writeProviderState(tmpRoot, "alpha", JSON.stringify({ schemaVersion: 999, junk: true }))
      const result = loadDriftInputsForAgent(tmpRoot, "alpha")
      expect(result.providerState).toBeNull()
    })
  })

  describe("agent.json error paths (these THROW so the caller can decide)", () => {
    it("throws when agent.json is missing", () => {
      // bundle dir exists, but no agent.json file inside
      bundleDir(tmpRoot, "alpha")
      expect(() => loadDriftInputsForAgent(tmpRoot, "alpha")).toThrow(/agent.json/i)
    })

    it("throws when the bundle directory does not exist at all", () => {
      expect(() => loadDriftInputsForAgent(tmpRoot, "missing-agent")).toThrow(/agent.json/i)
    })

    it("throws when agent.json is not valid JSON", () => {
      writeAgentJson(tmpRoot, "alpha", "{ this is not valid json")
      expect(() => loadDriftInputsForAgent(tmpRoot, "alpha")).toThrow(/json/i)
    })
  })

  describe("legacy ↔ new field-name preservation", () => {
    it("preserves legacy humanFacing/agentFacing keys verbatim", () => {
      writeAgentJson(tmpRoot, "alpha", JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "openai", model: "claude-opus-4-7" },
        agentFacing: { provider: "minimax", model: "minimax-m2.5" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
      }))
      writeProviderState(tmpRoot, "alpha", VALID_PROVIDER_STATE)
      const result = loadDriftInputsForAgent(tmpRoot, "alpha")
      expect(result.agentJson.humanFacing).toEqual({ provider: "openai", model: "claude-opus-4-7" })
      expect(result.agentJson.agentFacing).toEqual({ provider: "minimax", model: "minimax-m2.5" })
    })

    it("preserves the new outward/inner keys verbatim when present", () => {
      writeAgentJson(tmpRoot, "alpha", JSON.stringify({
        version: 2,
        enabled: true,
        humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
        outward: { provider: "openai", model: "claude-opus-4-7" },
        inner: { provider: "minimax", model: "minimax-m2.5" },
        phrases: { thinking: ["t"], tool: ["t"], followup: ["t"] },
      }))
      writeProviderState(tmpRoot, "alpha", VALID_PROVIDER_STATE)
      const result = loadDriftInputsForAgent(tmpRoot, "alpha")
      // Loader keeps both — the comparator (Unit 1) decides which wins.
      const augmented = result.agentJson as typeof result.agentJson & {
        outward?: { provider: string; model: string }
        inner?: { provider: string; model: string }
      }
      expect(augmented.outward).toEqual({ provider: "openai", model: "claude-opus-4-7" })
      expect(augmented.inner).toEqual({ provider: "minimax", model: "minimax-m2.5" })
    })
  })

  describe("read-only invariant", () => {
    it("does not write to disk when given a valid agent.json + providerState", () => {
      writeAgentJson(tmpRoot, "alpha", VALID_AGENT_JSON)
      writeProviderState(tmpRoot, "alpha", VALID_PROVIDER_STATE)
      const before = fs.readFileSync(path.join(tmpRoot, "alpha.ouro", "agent.json"), "utf-8")
      const beforeState = fs.readFileSync(path.join(tmpRoot, "alpha.ouro", "state", "providers.json"), "utf-8")
      loadDriftInputsForAgent(tmpRoot, "alpha")
      const after = fs.readFileSync(path.join(tmpRoot, "alpha.ouro", "agent.json"), "utf-8")
      const afterState = fs.readFileSync(path.join(tmpRoot, "alpha.ouro", "state", "providers.json"), "utf-8")
      expect(after).toBe(before)
      expect(afterState).toBe(beforeState)
    })

    it("does not create state/providers.json when it is absent (fresh install path)", () => {
      writeAgentJson(tmpRoot, "alpha", VALID_AGENT_JSON)
      loadDriftInputsForAgent(tmpRoot, "alpha")
      expect(fs.existsSync(path.join(tmpRoot, "alpha.ouro", "state", "providers.json"))).toBe(false)
    })
  })
})
