import { describe, it, expect } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "heart",
    event: "heart.test_run",
    message: testName,
    meta: { test: true },
  })
}

describe("config-registry", () => {
  describe("CONFIG_REGISTRY", () => {
    it("exports a typed map of all known agent.json keys", async () => {
      emitTestEvent("CONFIG_REGISTRY exports typed map")
      const { CONFIG_REGISTRY } = await import("../../heart/config-registry")
      expect(CONFIG_REGISTRY).toBeInstanceOf(Map)
      expect(CONFIG_REGISTRY.size).toBeGreaterThan(0)
    })

    it("each entry has required fields: path, tier, description, default, effects, topics", async () => {
      emitTestEvent("each entry has required fields")
      const { CONFIG_REGISTRY } = await import("../../heart/config-registry")
      for (const [key, entry] of CONFIG_REGISTRY) {
        expect(entry.path).toBe(key)
        expect(entry.path).toEqual(expect.any(String))
        expect([1, 2, 3]).toContain(entry.tier)
        expect(entry.description).toEqual(expect.any(String))
        expect(entry.description.length).toBeGreaterThan(0)
        expect(entry).toHaveProperty("default")
        expect(entry.effects).toEqual(expect.any(String))
        expect(entry.effects.length).toBeGreaterThan(0)
        expect(Array.isArray(entry.topics)).toBe(true)
      }
    })

    it("tier values are 1, 2, or 3 only", async () => {
      emitTestEvent("tier values are 1, 2, or 3")
      const { CONFIG_REGISTRY } = await import("../../heart/config-registry")
      for (const [, entry] of CONFIG_REGISTRY) {
        expect([1, 2, 3]).toContain(entry.tier)
      }
    })

    it("contains all known agent.json keys from AgentConfig interface", async () => {
      emitTestEvent("contains all known agent.json keys")
      const { CONFIG_REGISTRY } = await import("../../heart/config-registry")
      const expectedKeys = [
        "version",
        "enabled",
        "humanFacing.provider",
        "humanFacing.model",
        "agentFacing.provider",
        "agentFacing.model",
        "context.maxTokens",
        "context.contextMargin",
        "logging.level",
        "logging.sinks",
        "senses.cli",
        "senses.teams",
        "senses.bluebubbles",
        "mcpServers",
        "shell.defaultTimeout",
        "phrases.thinking",
        "phrases.tool",
        "phrases.followup",
        "sync.enabled",
        "sync.remote",
      ]
      for (const key of expectedKeys) {
        expect(CONFIG_REGISTRY.has(key), `missing key: ${key}`).toBe(true)
      }
    })

    it("T1 keys are self-service: contextMargin, phrases, shell.defaultTimeout, logging", async () => {
      emitTestEvent("T1 keys are self-service")
      const { CONFIG_REGISTRY } = await import("../../heart/config-registry")
      const t1Keys = [
        "context.contextMargin",
        "phrases.thinking",
        "phrases.tool",
        "phrases.followup",
        "shell.defaultTimeout",
        "logging.level",
        "logging.sinks",
      ]
      for (const key of t1Keys) {
        const entry = CONFIG_REGISTRY.get(key)
        expect(entry, `missing T1 key: ${key}`).toBeDefined()
        expect(entry!.tier, `${key} should be T1`).toBe(1)
      }
    })

    it("T2 keys are proposal: humanFacing, agentFacing, context.maxTokens, senses, sync", async () => {
      emitTestEvent("T2 keys are proposal")
      const { CONFIG_REGISTRY } = await import("../../heart/config-registry")
      const t2Keys = [
        "humanFacing.provider",
        "humanFacing.model",
        "agentFacing.provider",
        "agentFacing.model",
        "context.maxTokens",
        "senses.cli",
        "senses.teams",
        "senses.bluebubbles",
        "sync.enabled",
        "sync.remote",
      ]
      for (const key of t2Keys) {
        const entry = CONFIG_REGISTRY.get(key)
        expect(entry, `missing T2 key: ${key}`).toBeDefined()
        expect(entry!.tier, `${key} should be T2`).toBe(2)
      }
    })

    it("T3 keys are operator-only: version, enabled, mcpServers", async () => {
      emitTestEvent("T3 keys are operator-only")
      const { CONFIG_REGISTRY } = await import("../../heart/config-registry")
      const t3Keys = ["version", "enabled", "mcpServers"]
      for (const key of t3Keys) {
        const entry = CONFIG_REGISTRY.get(key)
        expect(entry, `missing T3 key: ${key}`).toBeDefined()
        expect(entry!.tier, `${key} should be T3`).toBe(3)
      }
    })
  })

  describe("getRegistryEntries", () => {
    it("returns all entries as an array", async () => {
      emitTestEvent("getRegistryEntries returns all entries")
      const { getRegistryEntries, CONFIG_REGISTRY } = await import("../../heart/config-registry")
      const entries = getRegistryEntries()
      expect(Array.isArray(entries)).toBe(true)
      expect(entries.length).toBe(CONFIG_REGISTRY.size)
    })
  })

  describe("getRegistryEntriesByTier", () => {
    it("filters entries by tier 1", async () => {
      emitTestEvent("getRegistryEntriesByTier filters tier 1")
      const { getRegistryEntriesByTier } = await import("../../heart/config-registry")
      const entries = getRegistryEntriesByTier(1)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry.tier).toBe(1)
      }
    })

    it("filters entries by tier 2", async () => {
      emitTestEvent("getRegistryEntriesByTier filters tier 2")
      const { getRegistryEntriesByTier } = await import("../../heart/config-registry")
      const entries = getRegistryEntriesByTier(2)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry.tier).toBe(2)
      }
    })

    it("filters entries by tier 3", async () => {
      emitTestEvent("getRegistryEntriesByTier filters tier 3")
      const { getRegistryEntriesByTier } = await import("../../heart/config-registry")
      const entries = getRegistryEntriesByTier(3)
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry.tier).toBe(3)
      }
    })
  })

  describe("getRegistryEntriesByTopic", () => {
    it("returns entries whose topics array includes the topic (case-insensitive partial match)", async () => {
      emitTestEvent("getRegistryEntriesByTopic case-insensitive partial match")
      const { getRegistryEntriesByTopic } = await import("../../heart/config-registry")
      // "model" should match entries related to model selection
      const entries = getRegistryEntriesByTopic("model")
      expect(entries.length).toBeGreaterThan(0)
      for (const entry of entries) {
        const hasMatch = entry.topics.some(
          (t: string) => t.toLowerCase().includes("model"),
        )
        expect(hasMatch, `entry ${entry.path} should have a topic matching "model"`).toBe(true)
      }
    })

    it("returns empty array when topic matches nothing", async () => {
      emitTestEvent("getRegistryEntriesByTopic returns empty for no match")
      const { getRegistryEntriesByTopic } = await import("../../heart/config-registry")
      const entries = getRegistryEntriesByTopic("xyznonexistenttopic")
      expect(entries).toEqual([])
    })

    it("handles empty topic string gracefully", async () => {
      emitTestEvent("getRegistryEntriesByTopic handles empty string")
      const { getRegistryEntriesByTopic } = await import("../../heart/config-registry")
      // Empty string matches everything since every string includes ""
      const entries = getRegistryEntriesByTopic("")
      expect(Array.isArray(entries)).toBe(true)
    })
  })

  describe("registry entry validators", () => {
    it("entries with validate function have a callable validator", async () => {
      emitTestEvent("validate functions are callable")
      const { CONFIG_REGISTRY } = await import("../../heart/config-registry")
      for (const [, entry] of CONFIG_REGISTRY) {
        if (entry.validate) {
          expect(typeof entry.validate).toBe("function")
        }
      }
    })

    it("number validators accept numbers and reject non-numbers", async () => {
      emitTestEvent("number validator works")
      const { getRegistryEntry } = await import("../../heart/config-registry")
      const entry = getRegistryEntry("context.contextMargin")
      expect(entry).toBeDefined()
      expect(entry!.validate).toBeDefined()
      expect(entry!.validate!(42)).toBeUndefined()
      expect(entry!.validate!("not a number")).toContain("expected number")
    })

    it("string enum validators accept valid values and reject invalid ones", async () => {
      emitTestEvent("string enum validator works")
      const { getRegistryEntry } = await import("../../heart/config-registry")
      const entry = getRegistryEntry("humanFacing.provider")
      expect(entry).toBeDefined()
      expect(entry!.validate).toBeDefined()
      expect(entry!.validate!("anthropic")).toBeUndefined()
      expect(entry!.validate!("invalid-provider")).toContain("expected one of")
      expect(entry!.validate!(42)).toContain("expected string")
    })

    it("string validators accept strings and reject non-strings", async () => {
      emitTestEvent("string validator works")
      const { getRegistryEntry } = await import("../../heart/config-registry")
      const entry = getRegistryEntry("humanFacing.model")
      expect(entry).toBeDefined()
      expect(entry!.validate).toBeDefined()
      expect(entry!.validate!("claude-opus-4-6")).toBeUndefined()
      expect(entry!.validate!(42)).toContain("expected string")
    })

    it("string array validators accept string arrays and reject non-arrays", async () => {
      emitTestEvent("string array validator works")
      const { getRegistryEntry } = await import("../../heart/config-registry")
      const entry = getRegistryEntry("phrases.thinking")
      expect(entry).toBeDefined()
      expect(entry!.validate).toBeDefined()
      expect(entry!.validate!(["a", "b"])).toBeUndefined()
      expect(entry!.validate!("not an array")).toContain("expected array")
      expect(entry!.validate!(["ok", 42])).toContain("expected string at index")
    })

    it("boolean validators accept booleans and reject non-booleans", async () => {
      emitTestEvent("boolean validator works")
      const { getRegistryEntry } = await import("../../heart/config-registry")
      const entry = getRegistryEntry("sync.enabled")
      expect(entry).toBeDefined()
      expect(entry!.validate).toBeDefined()
      expect(entry!.validate!(true)).toBeUndefined()
      expect(entry!.validate!("true")).toContain("expected boolean")
    })

    it("object validators accept valid objects and reject invalid ones", async () => {
      emitTestEvent("object validator works")
      const { getRegistryEntry } = await import("../../heart/config-registry")
      const entry = getRegistryEntry("senses.cli")
      expect(entry).toBeDefined()
      expect(entry!.validate).toBeDefined()
      expect(entry!.validate!({ enabled: true })).toBeUndefined()
      expect(entry!.validate!({ enabled: "yes" })).toContain('field "enabled"')
      expect(entry!.validate!({ foo: true })).toContain('missing required field "enabled"')
      expect(entry!.validate!("not an object")).toContain("expected object")
      expect(entry!.validate!(null)).toContain("expected object")
      expect(entry!.validate!([true])).toContain("expected object, got array")
    })
  })

  describe("getRegistryEntry", () => {
    it("returns a single entry for a known path", async () => {
      emitTestEvent("getRegistryEntry returns single entry")
      const { getRegistryEntry } = await import("../../heart/config-registry")
      const entry = getRegistryEntry("version")
      expect(entry).toBeDefined()
      expect(entry!.path).toBe("version")
    })

    it("returns undefined for an unknown path", async () => {
      emitTestEvent("getRegistryEntry returns undefined for unknown")
      const { getRegistryEntry } = await import("../../heart/config-registry")
      const entry = getRegistryEntry("nonexistent.path")
      expect(entry).toBeUndefined()
    })
  })
})
