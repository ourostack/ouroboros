import { describe, expect, it } from "vitest"

describe("no-live-side-effects CI fuse", () => {
  it("blocks known live side-effect APIs in replay and shadow test files", async () => {
    const { assertNoLiveSideEffects } = await import("../../../scripts/no-live-side-effects.cjs")

    expect(() => assertNoLiveSideEffects({
      files: [{
        path: "src/__tests__/rsvp/replay.test.ts",
        text: "await createBlueBubblesClient().sendMessage({ text: 'oops' })",
      }],
    })).toThrow(/BlueBubbles send/i)
  })

  it("blocks launchctl, vault writes, daemon restarts, AislePlanner fetches, and legacy RSVP state writes", async () => {
    const { assertNoLiveSideEffects } = await import("../../../scripts/no-live-side-effects.cjs")

    const blockedSamples = [
      "await fetchAislePlannerLive()",
      "await writeVaultItem('runtime/config')",
      "spawnSync('launchctl', ['unload', plist])",
      "await restartDaemon()",
      "legacy.save_snapshot(snapshot)",
      "legacy.write_sent_state(state)",
      "legacy.run_report_pipeline()",
    ]

    for (const sample of blockedSamples) {
      expect(() => assertNoLiveSideEffects({
        files: [{ path: "src/__tests__/rsvp/replay.test.ts", text: sample }],
      }), sample).toThrow()
    }
  })
})
