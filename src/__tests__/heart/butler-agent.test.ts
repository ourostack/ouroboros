import { describe, expect, it } from "vitest"

import { butlerContainerPaths, butlerNameFromEntrypoint, butlerOnDisk, managedButlerAgent } from "../../heart/butler-agent"

describe("the Butler's container paths", () => {
  it("derives every path and name from the bundle's name", () => {
    expect(butlerContainerPaths("butler")).toEqual({
      agentRoot: "/home/ouro/AgentBundles/butler.ouro",
      trustRoot: "/etc/ouro/trust/butler",
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

  it("reads the Butler's name from an image's entrypoint, and sanctuary from any image that names no Butler", () => {
    const daemon = ["node", "/opt/ouro/dist/heart/daemon/daemon-entry.js", "--package-managed-agent"]
    expect(butlerNameFromEntrypoint([...daemon, "butler"])).toBe("butler")
    expect(butlerNameFromEntrypoint([...daemon, "sanctuary"])).toBe("sanctuary")
    expect(butlerNameFromEntrypoint([...daemon, "slugger"])).toBe("sanctuary")
    expect(butlerNameFromEntrypoint(daemon)).toBe("sanctuary")
    expect(butlerNameFromEntrypoint(["node", "/opt/ouro/dist/heart/daemon/daemon-entry.js"])).toBe("sanctuary")
    expect(butlerNameFromEntrypoint(null)).toBe("sanctuary")
    expect(butlerContainerPaths("sanctuary").trustRoot).toBe("/etc/ouro/trust/sanctuary")
  })

  it("finds the one Butler among the managed agents, and none when there are two", () => {
    expect(managedButlerAgent(["slugger", "butler"])).toBe("butler")
    expect(managedButlerAgent(["sanctuary"])).toBe("sanctuary")
    expect(managedButlerAgent(["slugger"])).toBeNull()
    expect(managedButlerAgent(["butler", "sanctuary"])).toBeNull()
  })

  it("names the Butler after the one bundle on disk, and none with both or neither", () => {
    const disk = (...present: string[]) => (bundlePath: string) => present.includes(bundlePath)
    expect(butlerOnDisk("/b", disk("/b/butler.ouro"))).toBe("butler")
    expect(butlerOnDisk("/b", disk("/b/sanctuary.ouro", "/b/slugger.ouro"))).toBe("sanctuary")
    expect(butlerOnDisk("/b", disk("/b/butler.ouro", "/b/sanctuary.ouro"))).toBeNull()
    expect(butlerOnDisk("/b", disk("/b/slugger.ouro"))).toBeNull()
  })
})
