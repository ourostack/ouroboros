import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  bundleMounts,
  checkProfile,
  containerBundle,
  mountedAgentRoot,
  SANCTUARY_WRITABLE,
  sanctuaryProfile,
} from "../../../eval/sandbox/agent-profile"

describe("agent profiles for the eval sandbox", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-profile-"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("keeps the Butler's name, writable paths and projection as the default profile", () => {
    const bundleDir = path.join(root, "bundle")
    const seedBundleDir = path.join(root, "seed")
    fs.mkdirSync(path.join(bundleDir, "books"), { recursive: true })
    fs.writeFileSync(path.join(bundleDir, "agent.json"), "{}")
    fs.mkdirSync(path.join(seedBundleDir, "psyche"), { recursive: true })
    fs.writeFileSync(path.join(seedBundleDir, "psyche", "TACIT.md"), "public")
    const profile = sanctuaryProfile({ bundleDir, seedBundleDir })
    expect(profile.agent).toBe("sanctuary")
    expect([...profile.writable]).toEqual(["books/work", "books/removed", "books/ledger.ndjson", "state", "friends", "arc", "desk/_record"])
    expect(profile.writable).toBe(SANCTUARY_WRITABLE)
    expect(containerBundle(profile)).toBe("/home/ouro/AgentBundles/sanctuary.ouro")
    const out = path.join(root, "out")
    const { gaps } = profile.bundleSource({ include: ["agent.json", "books"], out })
    expect(fs.readFileSync(path.join(out, "agent.json"), "utf8")).toBe("{}")
    expect(gaps).toEqual(expect.arrayContaining([expect.stringMatching(/TACIT\.md/)]))
    expect(() => checkProfile(profile)).not.toThrow()
  })

  it("mounts the bundle read-only at the agent's own path, then each writable path over it", () => {
    expect(bundleMounts({ agent: "slugger", writable: ["state", "arc/notes"] }, "/run/bundle")).toEqual([
      "-v", "/run/bundle:/home/ouro/AgentBundles/slugger.ouro:ro",
      "-v", "/run/bundle/state:/home/ouro/AgentBundles/slugger.ouro/state",
      "-v", "/run/bundle/arc/notes:/home/ouro/AgentBundles/slugger.ouro/arc/notes",
    ])
  })

  it("mounts the Butler's bundle exactly as the sandbox always has", () => {
    const profile = sanctuaryProfile({ bundleDir: "/b", seedBundleDir: "/s" })
    const target = "/home/ouro/AgentBundles/sanctuary.ouro"
    expect(bundleMounts(profile, "/w/bundle")).toEqual([
      "-v", `/w/bundle:${target}:ro`,
      ...SANCTUARY_WRITABLE.flatMap((entry) => ["-v", `${path.join("/w/bundle", entry)}:${target}/${entry}`]),
    ])
  })

  it.each([
    ["a name with a capital", { agent: "Slugger", writable: ["state"] }, /lowercase/],
    ["a name with a slash", { agent: "../sanctuary", writable: ["state"] }, /lowercase/],
    ["no writable path", { agent: "slugger", writable: [] }, /no writable/],
    ["an absolute path", { agent: "slugger", writable: ["/etc"] }, /inside the bundle/],
    ["a path that climbs out", { agent: "slugger", writable: ["state/../../x"] }, /inside the bundle/],
    ["a path that isn't normal", { agent: "slugger", writable: ["state//x"] }, /inside the bundle/],
    ["the whole bundle", { agent: "slugger", writable: ["."] }, /inside the bundle/],
    ["a trailing slash", { agent: "slugger", writable: ["state/"] }, /inside the bundle/],
    ["a path twice", { agent: "slugger", writable: ["state", "state"] }, /twice/],
    ["a colon, which Docker splits a mount on", { agent: "slugger", writable: ["x:/etc"] }, /inside the bundle/],
    ["a comma, which Docker splits mount options on", { agent: "slugger", writable: ["x,ro"] }, /inside the bundle/],
  ])("refuses a profile with %s", (_name, profile, message) => {
    expect(() => checkProfile(profile)).toThrow(message)
    expect(() => bundleMounts(profile, "/run/bundle")).toThrow(message)
  })

  it("finds the one bundle mounted in the agent container", () => {
    fs.mkdirSync(path.join(root, "slugger.ouro"), { recursive: true })
    fs.writeFileSync(path.join(root, "notes.txt"), "")
    expect(mountedAgentRoot(root)).toBe(path.join(root, "slugger.ouro"))
    expect(() => mountedAgentRoot(root, () => [])).toThrow(/found 0/)
    expect(() => mountedAgentRoot(root, () => ["a.ouro", "b.ouro"])).toThrow(/found 2/)
  })
})
