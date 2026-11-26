import { describe, expect, it } from "vitest"

import { butlerContainerPaths, managedButlerAgent } from "../../heart/butler-agent"

describe("the Butler's container paths", () => {
  it("derives every path and name from the bundle's name", () => {
    expect(butlerContainerPaths("butler")).toEqual({
      agentRoot: "/home/ouro/AgentBundles/butler.ouro",
      crontabPath: "/home/ouro/.ouro-cli/scheduler/butler.crontab",
      habitNamespace: "habit:butler",
      healthJobId: "butler:sanctuary-health",
      healthTaskPath: "/home/ouro/AgentBundles/butler.ouro/habits/sanctuary-health.md",
      healthCommand: "/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke butler --habit sanctuary-health --trigger cron",
      healthCronMarker: "# ouro:habit:butler:butler:sanctuary-health",
    })
    // The live install's paths before the rename, exactly as the attestations pinned them.
    expect(butlerContainerPaths("sanctuary")).toMatchObject({
      crontabPath: "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab",
      healthTaskPath: "/home/ouro/AgentBundles/sanctuary.ouro/habits/sanctuary-health.md",
      healthCronMarker: "# ouro:habit:sanctuary:sanctuary:sanctuary-health",
    })
  })

  it("finds the one Butler among the managed agents, and none when there are two", () => {
    expect(managedButlerAgent(["slugger", "butler"])).toBe("butler")
    expect(managedButlerAgent(["sanctuary"])).toBe("sanctuary")
    expect(managedButlerAgent(["slugger"])).toBeNull()
    expect(managedButlerAgent(["butler", "sanctuary"])).toBeNull()
  })
})
