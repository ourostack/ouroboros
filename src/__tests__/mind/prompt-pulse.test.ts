import { describe, expect, it, vi, beforeEach } from "vitest"
import type { PulseState } from "../../heart/daemon/pulse"

// We mock readPulse so each test can drive the pulse content directly.
const mockReadPulse = vi.hoisted(() => vi.fn<[], PulseState | null>(() => null))

vi.mock("../../heart/daemon/pulse", async () => {
  const actual = await vi.importActual<typeof import("../../heart/daemon/pulse")>("../../heart/daemon/pulse")
  return {
    ...actual,
    readPulse: mockReadPulse,
  }
})

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: vi.fn(() => "slugger"),
  }
})

beforeEach(() => {
  mockReadPulse.mockReset()
})

describe("pulseSection", () => {
  it("renders empty when there's no pulse file", async () => {
    mockReadPulse.mockReturnValue(null)
    const { pulseSection } = await import("../../mind/prompt")
    expect(pulseSection()).toBe("")
  })

  it("renders empty when the agent has no siblings (single-agent machine)", async () => {
    mockReadPulse.mockReturnValue({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/Users/test/AgentBundles/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
      ],
    })
    const { pulseSection } = await import("../../mind/prompt")
    expect(pulseSection()).toBe("")
  })

  it("renders a section with a healthy reachable sibling", async () => {
    mockReadPulse.mockReturnValue({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/Users/test/AgentBundles/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
        {
          name: "ouroboros",
          bundlePath: "/Users/test/AgentBundles/ouroboros.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T21:55:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
      ],
    })
    const { pulseSection } = await import("../../mind/prompt")
    const result = pulseSection()
    expect(result).toContain("## the pulse")
    expect(result).toContain("ouroboros")
    expect(result).toContain("reachable siblings")
    expect(result).toContain("send_message")
    expect(result).not.toContain("broken siblings")
  })

  it("renders a broken sibling without a fix hint (still shows the reason)", async () => {
    mockReadPulse.mockReturnValue({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/x/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
        {
          name: "ouroboros",
          bundlePath: "/x/ouroboros.ouro",
          status: "crashed",
          lastSeenAt: null,
          errorReason: "something broke",
          fixHint: null, // No fix hint available
          alertId: "ouroboros:abc",
        },
      ],
    })
    const { pulseSection } = await import("../../mind/prompt")
    const result = pulseSection()
    expect(result).toContain("ouroboros")
    expect(result).toContain("something broke")
    // The "fix:" line should NOT appear for an agent without a fix hint
    expect(result).not.toContain("  fix: ")
  })

  it("highlights broken siblings with reason and fix hint", async () => {
    mockReadPulse.mockReturnValue({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/Users/test/AgentBundles/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
        {
          name: "ouroboros",
          bundlePath: "/Users/test/AgentBundles/ouroboros.ouro",
          status: "crashed",
          lastSeenAt: null,
          errorReason: "secrets.json for 'ouroboros' is missing providers.github-copilot section",
          fixHint: "Run 'ouro auth ouroboros' to configure github-copilot credentials.",
          alertId: "ouroboros:abc123",
        },
      ],
    })
    const { pulseSection } = await import("../../mind/prompt")
    const result = pulseSection()
    expect(result).toContain("## the pulse")
    expect(result).toContain("broken siblings")
    expect(result).toContain("ouroboros")
    expect(result).toContain("github-copilot")
    expect(result).toContain("ouro auth ouroboros")
    expect(result).toContain("/Users/test/AgentBundles/ouroboros.ouro")
    // Should NOT have a reachable-siblings section since the only sibling is broken
    expect(result).not.toContain("reachable siblings")
  })

  it("groups siblings into broken / reachable / idle buckets", async () => {
    mockReadPulse.mockReturnValue({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/x/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
        {
          name: "alpha",
          bundlePath: "/x/alpha.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
        {
          name: "bravo",
          bundlePath: "/x/bravo.ouro",
          status: "stopped",
          lastSeenAt: null,
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
        {
          name: "charlie",
          bundlePath: "/x/charlie.ouro",
          status: "crashed",
          lastSeenAt: null,
          errorReason: "config error",
          fixHint: "fix the config",
          alertId: "charlie:abc",
        },
      ],
    })
    const { pulseSection } = await import("../../mind/prompt")
    const result = pulseSection()
    expect(result).toContain("broken siblings")
    expect(result).toContain("reachable siblings")
    expect(result).toContain("idle siblings")
    expect(result).toContain("alpha")
    expect(result).toContain("bravo")
    expect(result).toContain("charlie")
  })

  it("excludes the agent itself from the rendered list", async () => {
    mockReadPulse.mockReturnValue({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/x/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
        {
          name: "ouroboros",
          bundlePath: "/x/ouroboros.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
      ],
    })
    const { pulseSection } = await import("../../mind/prompt")
    const result = pulseSection()
    // The section should mention ouroboros but NOT mention slugger as a sibling
    // (slugger is the current agent — it's not a sibling of itself).
    expect(result).toContain("ouroboros")
    // The slugger bundle path should not appear because slugger is filtered out
    expect(result).not.toContain("/x/slugger.ouro")
  })

  it("renders currentActivity for healthy siblings when present", async () => {
    mockReadPulse.mockReturnValue({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/x/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
          currentActivity: null,
        },
        {
          name: "ouroboros",
          bundlePath: "/x/ouroboros.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
          currentActivity: "running (instinct since 22:00)",
        },
      ],
    })
    const { pulseSection } = await import("../../mind/prompt")
    const result = pulseSection()
    expect(result).toContain("ouroboros")
    expect(result).toContain("running (instinct since 22:00)")
  })

  it("uses first-person voice ('i' / 'my', not 'you')", async () => {
    mockReadPulse.mockReturnValue({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/x/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
        {
          name: "ouroboros",
          bundlePath: "/x/ouroboros.ouro",
          status: "crashed",
          lastSeenAt: null,
          errorReason: "broken",
          fixHint: "fix it",
          alertId: "ouroboros:abc",
        },
      ],
    })
    const { pulseSection } = await import("../../mind/prompt")
    const result = pulseSection()
    // Body-text first-person markers
    expect(result).toContain("i ")
    // Should not have second-person directives like "you should"
    expect(result).not.toMatch(/\byou should\b/i)
  })
})

describe("bodyMapSection peers subsection", () => {
  it("includes the peers framing in the body map", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("slugger")
    expect(result).toContain("### peers")
    expect(result).toContain("PEERS")
    expect(result).toContain("scales horizontally")
    expect(result).toContain("send_message")
    // Whitespace-flexible: line wrap may split "teamwork makes the dream work"
    // across "dream\nwork".
    expect(result).toMatch(/teamwork makes the dream\s+work/i)
  })

  it("references the pulse so agents know where to find current state", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("slugger")
    expect(result).toContain("the pulse")
    expect(result).toContain("dynamic state")
  })

  it("encodes the talk-first norm explicitly", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("slugger")
    // The norm: talk first, only snoop if necessary. Direct declarative voice — no
    // hedging like "i prefer" or "i should", because system prompt copy must read
    // as the agent's stable behavior, not a soft preference.
    expect(result).toContain("i talk first")
    // Whitespace-flexible: the prompt body wraps with newlines.
    expect(result).toMatch(/only\s+open a sibling's bundle/i)
  })

  it("describes peers as full agents, not subagents", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("slugger")
    expect(result).toContain("not subagents")
  })

  it("opens the body section with home/bones/peers framing", async () => {
    const { bodyMapSection } = await import("../../mind/prompt")
    const result = bodyMapSection("slugger")
    // The opening line should mention all three. Declarative — peers presence
    // is conditional on the machine, not on the agent ("on a machine where
    // another agent lives, i have peers"), but the body map ALWAYS introduces
    // the concept.
    expect(result).toContain("i have a home")
    expect(result).toContain("i have bones")
    expect(result).toContain("i have peers")
  })
})
