import { describe, expect, it } from "vitest"

describe("progress story", () => {
  it("renders queued and completed inner work with truthful phases while preserving authored outcome text", async () => {
    const { buildProgressStory, renderProgressStory } = await import("../../heart/progress-story")

    expect(renderProgressStory(buildProgressStory({
      scope: "inner-delegation",
      phase: "queued",
      objective: "queued to inner/dialog",
      outcomeText: "wake: awaiting inner session",
    }))).toBe([
      "inner work: queued",
      "queued to inner/dialog",
      "wake: awaiting inner session",
    ].join("\n"))

    expect(renderProgressStory(buildProgressStory({
      scope: "inner-delegation",
      phase: "completed",
      outcomeText: "formal little blokes",
    }))).toBe([
      "inner work: completed",
      "formal little blokes",
    ].join("\n"))
  })

  it("renders shared work with bridge/task detail lines without hiding the live objective text", async () => {
    const { buildProgressStory, renderProgressStory } = await import("../../heart/progress-story")

    expect(renderProgressStory(buildProgressStory({
      scope: "shared-work",
      phase: "processing",
      objective: "running read_file (path=package.json)...",
      bridgeId: "bridge-1",
      taskName: "shared-relay",
    }))).toBe([
      "shared work: processing",
      "running read_file (path=package.json)...",
      "bridge: bridge-1",
      "task: shared-relay",
    ].join("\n"))
  })

  it("distinguishes blocked and errored states for shared work", async () => {
    const { buildProgressStory, renderProgressStory } = await import("../../heart/progress-story")

    expect(renderProgressStory(buildProgressStory({
      scope: "shared-work",
      phase: "blocked",
      outcomeText: "waiting on confirmation",
    }))).toBe([
      "shared work: blocked",
      "waiting on confirmation",
    ].join("\n"))

    expect(renderProgressStory(buildProgressStory({
      scope: "shared-work",
      phase: "errored",
      outcomeText: "Error: boom",
    }))).toBe([
      "shared work: errored",
      "Error: boom",
    ].join("\n"))
  })

  it("drops blank detail strings instead of rendering empty lines", async () => {
    const { buildProgressStory, renderProgressStory } = await import("../../heart/progress-story")

    expect(renderProgressStory(buildProgressStory({
      scope: "inner-delegation",
      phase: "processing",
      objective: "   ",
      outcomeText: "\n  ",
    }))).toBe("inner work: processing")
  })
})
