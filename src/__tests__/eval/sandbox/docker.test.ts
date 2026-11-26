import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DECLARED_GAPS } from "../../../eval/sandbox/declared-gaps"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderRuntime } from "../../../heart/core"
import type { Case } from "../../../eval/domain/case"
import { buildSandboxImage, dockerCli, EVAL_LABEL, HOUSEHOLD_IMAGE, INTERVIEW_GUEST_ENTRIES, runSandboxed, SANDBOX_IMAGE, splitTurns, type Docker, type DockerProcess } from "../../../eval/sandbox/docker"
import { agentImageOf, parseSandboxImages } from "../../../eval/sandbox/images"
import { runGuest } from "../../../eval/sandbox/guest"
import type { runTelegramTurn } from "../../../eval/transport/telegram-turn"

const sha = (text: string): string => crypto.createHash("sha256").update(text).digest("hex")
const BUNDLE = "/home/ouro/AgentBundles/sanctuary.ouro"

function testCase(overrides: Partial<Case> = {}): Case {
  const observation = { timeline: [], finalReply: "", library: [], mail: [], created: [], outcome: "settled", steps: 0, oracle: {} }
  return {
    schemaVersion: 1, id: "remove-bad-copy", actionIds: ["books.library.remove"], bundle: { include: ["agent.json", "books"] },
    prefix: [{ role: "user", content: "Which copy is on the shelf?" }, { role: "assistant", content: "Two: 187 and 189." }, { role: "user", content: "take 187 off" }],
    seed: {
      library: [{ id: 187, title: "The Harbour Almanac", sha256: sha("A") }],
      libgen: [],
      labels: [{ sha256: sha("A"), work: "harbour-almanac", edition: "A", readable: false }, { sha256: sha("A0"), work: "harbour-almanac", edition: "A", readable: false }],
      deleteAllowed: true,
      disk: [sha("A0")],
    },
    assertions: [{ name: "mail.none" }],
    fixtures: { pass: observation, fail: { mailed: observation } },
    ...overrides,
  }
}

function hostRuntime(): ProviderRuntime & { requests: number } {
  const runtime = {
    id: "minimax" as const, model: "eval-scripted", client: {}, capabilities: new Set<never>(), requests: 0,
    resetTurnState: () => undefined, appendToolOutput: () => undefined, ping: async () => undefined, classifyError: () => "unknown" as const,
    streamTurn: async () => {
      runtime.requests += 1
      return { content: "", toolCalls: [{ id: "call-1", name: "shell", arguments: "{\"command\":\"books library remove 187\"}" }], outputItems: [] }
    },
  }
  return runtime
}

/** The host folder each container path is mounted from, read from `-v host:container[:ro]`. */
function mounts(args: string[]): Map<string, string> {
  const found = new Map<string, string>()
  args.forEach((arg, index) => {
    if (arg === "-v") {
      const [host, container] = args[index + 1]!.split(":")
      found.set(container!, host!)
    }
  })
  return found
}

type Behaviour = {
  sidecar?: "ready" | "exit" | "silent"
  agent?: "done" | "exit" | "silent" | "throw" | "null-result"
  runTurn?: typeof runTelegramTurn
  failRemovals?: boolean
  failReclaim?: boolean
  /** The agent's `docker run` never ends, even once the container is removed. */
  agentHangs?: boolean
  householdHangs?: boolean
  onNetwork?: () => void
  state?: object
  /** The containers on the host that match the ps filter, as `docker ps --format {{.Names}}` prints them. */
  butler?: string
  failPs?: boolean
  /** Sees the projected bundle as the agent container would mount it. */
  onAgentStart?: (bundle: string) => void
}

/**
 * Docker as the sandbox uses it, in process: helper containers write into their mounts, the household reports ready
 * and writes its state file, and the agent container runs the real guest over a pair of streams.
 */
function fakeDocker(behaviour: Behaviour = {}) {
  const calls: string[][] = []
  const work = { bundle: "", household: "" }
  const ends = new Map<string, (code: number) => void>()
  const docker: Docker = {
    run: async (args) => {
      calls.push(args)
      const at = mounts(args)
      if (args.includes("/opt/eval/fakes/fixtures.py")) {
        fs.writeFileSync(path.join(at.get("/out")!, "A0.epub"), "A0")
        fs.writeFileSync(path.join(at.get("/out")!, "A.epub"), "A")
        return JSON.stringify({ A: sha("A"), A0: sha("A0") })
      }
      if (args.at(-1)?.includes("openssl")) {
        for (const name of ["ca.pem", "server.pem", "server.key"]) fs.writeFileSync(path.join(at.get("/out")!, name), name, { mode: 0o600 })
        return ""
      }
      if (args[0] === "ps") {
        if (behaviour.failPs) throw new Error("Cannot connect to the Docker daemon")
        return behaviour.butler ?? ""
      }
      if (args[0] === "network" && args[1] === "create") behaviour.onNetwork?.()
      if (args[0] === "rm" || args[0] === "network" && args[1] === "rm") {
        const hangs = args[2]!.endsWith("-agent") ? behaviour.agentHangs : behaviour.householdHangs
        if (args[0] === "rm" && !hangs) ends.get(args[2]!)?.(137)
        if (behaviour.failRemovals) throw new Error("no such container")
      }
      if (args.at(-1)?.startsWith("chown -R")) {
        if (behaviour.failReclaim) throw new Error("reclaim failed")
        // The household's user owns its shelf; handing the folder back is what lets the host delete it.
        fs.chmodSync(path.join(at.get("/work")!, "household", "library"), 0o700)
      }
      return ""
    },
    start: (args): DockerProcess => {
      calls.push(args)
      const at = mounts(args)
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      let exit!: (code: number) => void
      const exited = new Promise<number>((resolve) => { exit = resolve })
      const name = args[args.indexOf("--name") + 1]!
      if (name.endsWith("-household")) {
        ends.set(name, exit)
        work.household = at.get("/eval/state")!
        fs.writeFileSync(path.join(work.household, "state.json"), JSON.stringify(behaviour.state ?? {
          library: [{ id: 189, title: "The Harbour Almanac", sha256: sha("C") }], mail: [], events: [{ service: "calibre-web" }],
        }))
        fs.mkdirSync(path.join(work.household, "library"))
        fs.writeFileSync(path.join(work.household, "library", "189.epub"), "C")
        fs.chmodSync(path.join(work.household, "library"), 0o500)
        if (behaviour.sidecar === "exit") setImmediate(() => exit(2))
        else if (behaviour.sidecar !== "silent") setImmediate(() => { stdout.write("starting\n"); stdout.write("{\"ready\": true, \"ports\": {}}\n") })
        return { stdin, stdout, exited, stderr: () => "address in use" }
      }
      if (behaviour.agent === "throw") throw new Error("docker is not installed")
      work.bundle = at.get(BUNDLE)!
      behaviour.onAgentStart?.(work.bundle)
      ends.set(name, exit)
      if (behaviour.agent === "exit") setImmediate(() => exit(1))
      else if (behaviour.agent === "null-result") stdout.write(`${JSON.stringify({ type: "done", outcome: { ok: true, result: null } })}\n`)
      else if (behaviour.agent !== "silent") {
        const runTurn: typeof runTelegramTurn = behaviour.runTurn ?? (async (turn) => {
          const reply = await turn.providerRuntime.streamTurn({ messages: [], activeTools: [], callbacks: {} } as never)
          turn.providerRuntime.appendToolOutput(reply.toolCalls[0]!.id, "{\"ok\":true}")
          fs.writeFileSync(path.join(at.get(`${BUNDLE}/books/removed`)!, "187-the-harbour-almanac.epub"), "A")
          return {
            timeline: [{ kind: "call", name: "shell", args: reply.toolCalls[0]!.arguments, result: "{\"ok\":true}" }, { kind: "reply", text: "Done, 189 is on the shelf." }],
            finalReply: "Done, 189 is on the shelf.", outcome: "settled", steps: 1,
          }
        })
        void runGuest({ stdin, stdout, turnFile: at.get("/eval/turn.json")!, runTurn }).then(() => { if (!behaviour.agentHangs) setImmediate(() => exit(0)) })
      }
      return { stdin, stdout, exited, stderr: () => "guest stderr" }
    },
  }
  return { docker, calls, work }
}

const named = (calls: string[][], suffix: string): string[] => calls.find((args) => args[0] === "run" && args[args.indexOf("--name") + 1]?.endsWith(suffix))!

describe("runSandboxed", () => {
  let root: string
  let bundleDir: string
  let seedBundleDir: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-docker-"))
    bundleDir = path.join(root, "bundle")
    seedBundleDir = path.join(root, "seed")
    fs.mkdirSync(path.join(bundleDir, "books"), { recursive: true })
    fs.writeFileSync(path.join(bundleDir, "agent.json"), "{}")
    fs.writeFileSync(path.join(bundleDir, "books", "books"), "#!/bin/sh\n", { mode: 0o755 })
    fs.mkdirSync(path.join(seedBundleDir, "psyche"), { recursive: true })
    fs.writeFileSync(path.join(seedBundleDir, "psyche", "TACIT.md"), "public")
    fs.writeFileSync(path.join(seedBundleDir, "tool-profiles.json"), "{}")
  })

  afterEach(() => {
    fs.chmodSync(root, 0o700)
    fs.rmSync(root, { recursive: true, force: true })
  })

  const input = (docker: Docker, extra: Partial<Parameters<typeof runSandboxed>[0]> = {}) =>
    ({ case: testCase(), bundleDir, seedBundleDir, host: hostRuntime(), budget: { take: () => true }, docker, workRoot: root, ...extra })

  it("runs the turn in the agent container against the household and reads the observation back on the host", async () => {
    const { docker, calls, work } = fakeDocker()
    const host = hostRuntime()
    const seenPaths: string[] = []
    const obs = await runSandboxed(input(docker, { host, oracle: async (file) => { seenPaths.push(file); return true } }))

    expect(obs.outcome).toBe("settled")
    expect(obs.steps).toBe(1)
    expect(host.requests).toBe(1)
    expect(obs.timeline).toEqual([
      { kind: "call", name: "shell", args: "{\"command\":\"books library remove 187\"}", result: "{\"ok\":true}" },
      { kind: "reply", text: "Done, 189 is on the shelf." },
    ])
    expect(obs.finalReply).toBe("Done, 189 is on the shelf.")
    expect(obs.library).toEqual([{ id: 189, title: "The Harbour Almanac", sha256: sha("C") }])
    expect(obs.created).toContainEqual({ path: "books/removed/187-the-harbour-almanac.epub", sha256: sha("A") })
    // The seeded download was on disk before the turn, so it is not something the turn made.
    expect(obs.created.map((file) => file.path).filter((file) => file.startsWith("books/work"))).toEqual([])
    // C is unlabelled in this case, so the oracle grades the household's shelved copy.
    expect(obs.oracle).toEqual({ [sha("C")]: true })
    expect(seenPaths).toEqual([path.join(work.household, "library", "189.epub")])
    expect(obs.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/TACIT\.md/), expect.stringMatching(/^friends/), expect.stringMatching(/^state/)]))
    // What the sandbox itself fakes or leaves out is declared, so every report lists it beside the projection's gaps.
    expect(obs.gaps).toEqual(expect.arrayContaining([...DECLARED_GAPS]))

    const network = calls.find((args) => args[0] === "network" && args[1] === "create")!
    // Its own name space, outside the `ouro-` names the Butler's tooling owns, and labelled as eval's and as this run's.
    const runId = network.at(-1)!
    expect(runId).toMatch(/^eval-sandbox-[0-9a-f]{8}$/)
    expect(network).toEqual(["network", "create", "--internal", "--label", "ouro.eval=1", "--label", `ouro.eval.run=${runId}`, runId])
    for (const container of calls.filter((args) => args[0] === "run")) {
      expect(container).toEqual(expect.arrayContaining(["--label", "ouro.eval=1", "--label", `ouro.eval.run=${runId}`]))
    }
    // Nothing the run creates, container, network or folder, uses the old shared `ouro-eval-` names.
    expect(calls.flat().filter((arg) => /(^|[/:])ouro-eval-(?!sandbox:|household:)/.test(arg))).toEqual([])

    const sidecar = named(calls, "-household")
    const limits = ["--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--pids-limit", "512", "--ulimit", `fsize=${256 * 1024 * 1024}`]
    expect(sidecar).toEqual(expect.arrayContaining(["--rm", "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--user", "10002:10002", "--network", runId, ...limits]))
    expect(sidecar).toContain(HOUSEHOLD_IMAGE)
    for (const alias of ["calibre-web", "smtp", "libgen.li", "libgen.bz", "libgen.gl", "libgen.la", "libgen.vg"]) expect(sidecar.join(" ")).toContain(`--network-alias ${alias}`)

    const agent = named(calls, "-agent")
    expect(agent).toEqual(expect.arrayContaining(["-i", "--rm", "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--user", "10001:10001", "--env", "HOME=/home/ouro", "--network", runId, ...limits]))
    expect(agent).toEqual(expect.arrayContaining(["--tmpfs", "/tmp:rw,mode=1777,size=256m", "--tmpfs", "/home/ouro:rw,uid=10001,gid=10001,mode=0700,size=256m"]))
    // The helpers that build the fixtures and the test authority, and hand the folder back, use the household's image.
    for (const helper of calls.filter((args) => args[0] === "run" && !args.includes("--name"))) expect(helper).toContain(HOUSEHOLD_IMAGE)
    expect(agent.slice(-5)).toEqual([SANDBOX_IMAGE, "node", "/opt/ouro/dist/eval/guest-entry.js", "--agent", "sanctuary"])
    const agentMounts = agent.flatMap((arg, index) => agent[index - 1] === "-v" ? [arg] : [])
    expect(agentMounts).toContainEqual(expect.stringMatching(new RegExp(`:${BUNDLE}:ro$`)))
    for (const writable of ["books/work", "books/removed", "books/ledger.ndjson", "state", "friends", "arc"]) {
      expect(agentMounts).toContainEqual(expect.stringMatching(new RegExp(`/bundle/${writable}:${BUNDLE}/${writable}$`)))
    }
    expect(agentMounts).toContainEqual(expect.stringMatching(/\/tls\/ca\.pem:\/etc\/ssl\/certs\/ca-certificates\.crt:ro$/))
    // The household's state, the TLS key and the seed never reach the agent container.
    expect(agentMounts.join(" ")).not.toMatch(/household|server\.key|seed\.json|fixtures/)

    // The agent goes first, then the household, both before the folder is handed back and read; then the network,
    // and the run's folder is gone.
    const steps = calls.filter((args) => args[0] === "rm" || (args[0] === "network" && args[1] === "rm") || args.at(-1)?.startsWith("chown -R"))
      .map((args) => args[0] === "run" ? "reclaim" : args.at(-1)!)
    expect(steps).toEqual([`${runId}-agent`, `${runId}-household`, "reclaim", `${runId}-agent`, `${runId}-household`, runId])
    expect(fs.readdirSync(root).filter((name) => name.startsWith("eval-sandbox-"))).toEqual([])
  })

  it("writes the books CLI's synthetic settings and the turn file, and opens the writable mounts to the containers", async () => {
    let seen: { settings: unknown; turn: unknown; modes: Record<string, number>; seeded: string } | undefined
    const { docker } = fakeDocker({
      runTurn: async () => {
        const work = fs.readdirSync(root).find((name) => name.startsWith("eval-sandbox-"))!
        const bundle = path.join(root, work, "bundle")
        seen = {
          settings: JSON.parse(fs.readFileSync(path.join(bundle, "books/credentials.json"), "utf8")),
          turn: JSON.parse(fs.readFileSync(path.join(root, work, "turn.json"), "utf8")),
          modes: Object.fromEntries(["books/work", "books/ledger.ndjson", "state", "friends", "arc", "agent.json"].map((entry) => [entry, fs.statSync(path.join(bundle, entry)).mode & 0o777])),
          seeded: fs.readdirSync(path.join(bundle, "books/work"), { recursive: true }).map(String).sort().join(" "),
        }
        return { timeline: [], finalReply: "", outcome: "settled", steps: 0 }
      },
    })
    await runSandboxed(input(docker))
    expect(seen!.settings).toEqual({
      calibre_web: { url: "http://calibre-web:8083", username: "butler", password: "eval-password" },
      smtp: { host: "smtp", port: 2525, user: "eval", password: "eval-password" },
      pocketbook: { from: "butler@example.invalid", to: "pocketbook@example.invalid" },
      libgen: { mirrors: ["https://libgen.li", "https://libgen.bz", "https://libgen.gl", "https://libgen.la", "https://libgen.vg"] },
    })
    expect(seen!.turn).toEqual({ prefix: testCase().prefix.slice(0, 2), userText: "take 187 off" })
    expect(seen!.modes).toEqual({ "books/work": 0o777, "books/ledger.ndjson": 0o666, state: 0o777, friends: 0o777, arc: 0o777, "agent.json": 0o644 })
    // Where an earlier `books get` would have left it: a time-and-id folder, named for the work.
    expect(seen!.seeded).toMatch(/^(\d{10}-[0-9a-f]{8}) \1\/harbour-almanac\.epub$/)
  })

  it("names a seeded file that no label covers for no work in particular", async () => {
    let seeded = ""
    const { docker } = fakeDocker({
      runTurn: async () => {
        const work = fs.readdirSync(root).find((name) => name.startsWith("eval-sandbox-"))!
        seeded = fs.readdirSync(path.join(root, work, "bundle/books/work"), { recursive: true }).map(String).sort().join(" ")
        return { timeline: [], finalReply: "", outcome: "settled", steps: 0 }
      },
    })
    const c = testCase()
    c.seed.labels = c.seed.labels.filter((label) => label.sha256 !== sha("A0"))
    await runSandboxed({ ...input(docker), case: c })
    expect(seeded).toMatch(/\/book\.epub$/)
  })

  it("refuses a case whose prefix does not end with the owner's message, before touching Docker", async () => {
    const { docker, calls } = fakeDocker()
    const c = testCase({ prefix: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] })
    await expect(runSandboxed({ ...input(docker), case: c })).rejects.toThrow(/must end with the owner's message/)
    await expect(runSandboxed({ case: testCase({ prefix: [] }), bundleDir, seedBundleDir, host: hostRuntime(), budget: { take: () => true } })).rejects.toThrow(/must end/)
    expect(calls).toEqual([])
  })

  // 2026-11-23: an eval run's vanishing container broke the live Butler's upgrade on the host they shared (#1760).
  for (const name of ["ouro-butler", "ouro-butler-staging", "ouro-butler-rollback"]) {
    it(`refuses a host with the Butler's ${name} container and no host lock, before creating anything`, async () => {
      const { docker, calls } = fakeDocker({ butler: `${name}\n` })
      await expect(runSandboxed(input(docker))).rejects.toThrow(new RegExp(`live Butler \\(${name}\\).*host lock`))
      expect(calls).toEqual([["ps", "--all", "--filter", "name=^/?ouro-butler(-staging|-rollback)?$", "--format", "{{.Names}}"]])
      expect(fs.readdirSync(root).filter((entry) => entry.startsWith("eval-sandbox-"))).toEqual([])
    })
  }

  it("refuses the Butler's host when the host lock is not held, or cannot be read", async () => {
    const unlocked = fakeDocker({ butler: "ouro-butler\n" })
    await expect(runSandboxed(input(unlocked.docker, { hostLock: { held: async () => false } }))).rejects.toThrow(/host lock/)
    const broken = fakeDocker({ butler: "ouro-butler\n" })
    await expect(runSandboxed(input(broken.docker, { hostLock: { held: async () => { throw new Error("lock file unreadable") } } }))).rejects.toThrow(/lock file unreadable/)
    expect(broken.calls.filter((args) => args[0] !== "ps")).toEqual([])
  })

  it("runs on the Butler's host while the host lock is held", async () => {
    const { docker } = fakeDocker({ butler: "ouro-butler\n" })
    const obs = await runSandboxed(input(docker, { hostLock: { held: async () => true } }))
    expect(obs.outcome).toBe("settled")
  })

  it("creates nothing when Docker cannot list the host's containers", async () => {
    const { docker, calls } = fakeDocker({ failPs: true })
    await expect(runSandboxed(input(docker))).rejects.toThrow(/Docker daemon/)
    expect(calls).toHaveLength(1)
    expect(fs.readdirSync(root).filter((entry) => entry.startsWith("eval-sandbox-"))).toEqual([])
  })

  it("refuses a seeded file that is no fixture, and cleans up without a network to remove", async () => {
    const { docker, calls } = fakeDocker()
    const c = testCase()
    c.seed.disk = [sha("unknown")]
    await expect(runSandboxed({ ...input(docker), case: c, workRoot: undefined })).rejects.toThrow(/which is no fixture/)
    expect(calls.some((args) => args[0] === "network")).toBe(false)
  })

  it.each([
    ["exits", "exit" as const, /household exited \(2\) before it was ready: address in use/],
    ["never says it is ready", "silent" as const, /not ready within 50 ms/],
  ])("fails when the household %s, and still removes what it made", async (_what, sidecar, error) => {
    const { docker, calls } = fakeDocker({ sidecar })
    await expect(runSandboxed(input(docker, { readyTimeoutMs: 50 }))).rejects.toThrow(error)
    const removals = calls.filter((args) => args[0] === "rm" || args[0] === "network" && args[1] === "rm").map((args) => args.at(-1)!)
    expect(removals).toHaveLength(2)
    expect(removals[0]).toMatch(/-household$/)
    // The household had shelved its books as its own user; the folder is handed back and removed all the same.
    expect(fs.readdirSync(root).filter((name) => name.startsWith("eval-sandbox-"))).toEqual([])
  })

  it("reports an agent container that exits before its turn is done as a sandbox error, not a pass", async () => {
    const { docker } = fakeDocker({ agent: "exit" })
    const obs = await runSandboxed(input(docker))
    expect(obs.outcome).toBe("sandbox-error: the agent container exited (1) before the turn finished: guest stderr")
    expect(obs.timeline).toEqual([])
  })

  it("stops a turn that runs past its deadline", async () => {
    const { docker } = fakeDocker({ agent: "silent" })
    const obs = await runSandboxed(input(docker, { turnTimeoutMs: 50 }))
    expect(obs.outcome).toBe("sandbox-error: the turn did not finish within 50 ms")
  })

  it.each([
    ["a turn that failed in the guest", async () => { throw new Error("pipeline exploded") }, "sandbox-error: pipeline exploded"],
    ["a malformed result", async () => ({ timeline: "nope" }) as never, "sandbox-error: the guest's result is malformed"],
  ])("reports %s as a sandbox error", async (_what, runTurn, outcome) => {
    const { docker } = fakeDocker({ runTurn })
    expect((await runSandboxed(input(docker))).outcome).toBe(outcome)
  })

  it("reports a done message without a result as a sandbox error", async () => {
    const { docker } = fakeDocker({ agent: "null-result" })
    expect((await runSandboxed(input(docker, { turnTimeoutMs: 2000 }))).outcome).toBe("sandbox-error: the guest's result is malformed")
  })

  it("runs another guest with its own turn file, scores its first turn and returns the later turns", async () => {
    const turn = { prefix: [], userText: "job", followUps: ["debrief"] }
    let written: unknown
    const { docker, calls } = fakeDocker({
      runTurn: async (t) => {
        written = { prefix: t.prefix, userText: t.userText }
        const first = await t.providerRuntime.streamTurn({ messages: [], activeTools: [], callbacks: {} } as never)
        const second = await t.providerRuntime.streamTurn({ messages: [], activeTools: [], callbacks: {} } as never)
        const call = (id: string, args: string) => ({ kind: "call" as const, name: "shell", args, result: id })
        return {
          timeline: [call("a", first.toolCalls[0]!.arguments), { kind: "reply", text: "Done." }, call("b", second.toolCalls[0]!.arguments), { kind: "reply", text: "6\nfine" }],
          finalReply: "Done.", outcome: "settled", steps: 2,
          turns: [{ start: 0, finalReply: "Done.", outcome: "settled", calls: 2 }, { start: 2, finalReply: "6\nfine", outcome: "settled", calls: 1 }],
        } as never
      },
    })
    const obs = await runSandboxed(input(docker, { guest: { entry: "interview-guest-entry.js", turn } }))
    expect(calls.find((args) => args.includes("--name") && args[args.indexOf("--name") + 1]!.endsWith("-agent"))!.slice(-3)).toEqual([SANDBOX_IMAGE, "node", "/opt/ouro/dist/eval/interview-guest-entry.js"])
    expect(written).toEqual({ prefix: [], userText: "job" })
    expect(obs.outcome).toBe("settled")
    expect(obs.finalReply).toBe("Done.")
    expect(obs.timeline).toHaveLength(2)
    expect(obs.followUps).toEqual([{ finalReply: "6\nfine", outcome: "settled", calls: 1, toolCalls: 1 }])
    expect(obs.gaps).not.toEqual(expect.arrayContaining([...DECLARED_GAPS]))
  })

  describe("an interview's bundle", () => {
    const vendorAgent = {
      version: 2, humanFacing: { provider: "anthropic", model: "claude-opus-5-5" }, agentFacing: { provider: "anthropic", model: "claude-sonnet-5-5" },
      providerFallback: [{ provider: "minimax", model: "MiniMax-M3" }], senses: { telegram: { enabled: true } },
    }
    const vendorReadiness = { version: 1, selectionPolicy: "explicit-same-lane-only", providers: [{ provider: "minimax", model: "MiniMax-M3", vaultItem: "providers/minimax" }] }
    const reply = { timeline: [], finalReply: "", outcome: "settled", steps: 0, turns: [{ start: 0, finalReply: "", outcome: "settled", calls: 0 }] }
    const guest = { entry: "h-guest-entry.js" as const, turn: { prefix: [], userText: "x" } }
    const json = (dir: string, file: string): unknown => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))

    beforeEach(() => {
      fs.writeFileSync(path.join(bundleDir, "agent.json"), JSON.stringify(vendorAgent))
      fs.writeFileSync(path.join(seedBundleDir, "provider-readiness.json"), JSON.stringify(vendorReadiness))
    })

    it("names a neutral provider in both files, and every report lists each rewritten file", async () => {
      const seen: Record<string, unknown> = {}
      const { docker } = fakeDocker({ runTurn: async () => reply as never, onAgentStart: (bundle) => {
        seen.agent = json(bundle, "agent.json")
        seen.readiness = json(bundle, "provider-readiness.json")
      } })
      const obs = await runSandboxed(input(docker, { guest }))
      expect(obs.outcome).toBe("settled")
      expect(seen.agent).toEqual({
        version: 2, humanFacing: { provider: "github-copilot", model: "model" }, agentFacing: { provider: "github-copilot", model: "model" }, senses: { telegram: { enabled: true } },
      })
      expect(seen.readiness).toEqual({ version: 1, selectionPolicy: "explicit-same-lane-only", providers: [] })
      expect(obs.gaps).toEqual(expect.arrayContaining([expect.stringMatching(/^agent\.json: .*github-copilot/), expect.stringMatching(/^provider-readiness\.json: /)]))
    })

    it("leaves the replay eval's bundle as it is projected today", async () => {
      const seen: Record<string, unknown> = {}
      const { docker } = fakeDocker({ onAgentStart: (bundle) => {
        seen.agent = json(bundle, "agent.json")
        seen.readiness = json(bundle, "provider-readiness.json")
      } })
      const obs = await runSandboxed(input(docker))
      expect(obs.outcome).toBe("settled")
      expect(seen).toEqual({ agent: vendorAgent, readiness: vendorReadiness })
      expect(obs.gaps.filter((gap) => /^(agent|provider-readiness)\.json: .*(github-copilot|empty)/.test(gap))).toEqual([])
    })

    it("refuses a bundle that still names a vendor before any Docker call, naming the file and its count", async () => {
      fs.mkdirSync(path.join(bundleDir, "psyche"), { recursive: true })
      fs.writeFileSync(path.join(bundleDir, "psyche", "SOUL.md"), "I am Claude, a helpful butler.")
      const { docker, calls } = fakeDocker({ runTurn: async () => reply as never })
      const c = testCase({ bundle: { include: ["agent.json", "books", "psyche"] } })
      const refusal = runSandboxed({ ...input(docker, { guest }), case: c })
      await expect(refusal).rejects.toThrow(/psyche\/SOUL\.md \(1\)/)
      await expect(refusal).rejects.not.toThrow(/helpful butler/)
      // Not a container, and not even the Butler check.
      expect(calls).toEqual([])
      expect(fs.readdirSync(root).filter((entry) => entry.startsWith("eval-sandbox-"))).toEqual([])
    })
  })

  it("reads --images as the agent's and household's tags, then any named agent images as name=tag", () => {
    expect(parseSandboxImages("ouro-eval-a:1,ouro-eval-h:1")).toEqual({ agent: "ouro-eval-a:1", household: "ouro-eval-h:1" })
    expect(parseSandboxImages("ouro-eval-a:1,ouro-eval-h:1,arm-a=ouro-eval-arm-a:1,arm-b=ouro-eval-arm-b:1")).toEqual({
      agent: "ouro-eval-a:1", household: "ouro-eval-h:1", named: { "arm-a": "ouro-eval-arm-a:1", "arm-b": "ouro-eval-arm-b:1" },
    })
    const usage = "--images must be <agent image>,<household image>, then any <name>=<agent image>"
    for (const bad of ["ouro-eval-a:1", "ouro-eval-a:1,", "a,h,arm-a", "a,h,=t", "a,h,arm-a=", "a,h,x=t,x=u", "a,h,arm-a=t,plain", "a,h,__proto__=t", "a,h,a b=t"]) expect(() => parseSandboxImages(bad)).toThrow(usage)
    expect(parseSandboxImages(" a , h , constructor=t ")).toEqual({ agent: "a", household: "h", named: { constructor: "t" } })
    expect(() => agentImageOf({ agent: "a", household: "h", named: { x: "t" } }, "toString")).toThrow("no agent image named toString: the run's images name x")
  })

  it("runs a guest that names an image in the agent image the run's images give that name, and refuses a name it lacks", async () => {
    const reply = { timeline: [], finalReply: "", outcome: "settled", steps: 0, turns: [{ start: 0, finalReply: "", outcome: "settled", calls: 0 }] }
    const named = fakeDocker({ runTurn: async () => reply as never })
    const images = { agent: SANDBOX_IMAGE, household: HOUSEHOLD_IMAGE, named: { "arm-a": "ouro-eval-arm-a:1" } }
    const guest = { entry: "interview-guest-entry.js" as const, turn: { prefix: [], userText: "x" }, image: "arm-a" }
    expect((await runSandboxed(input(named.docker, { images, guest }))).outcome).toBe("settled")
    const agentRun = named.calls.find((args) => args.includes("--name") && args[args.indexOf("--name") + 1]!.endsWith("-agent"))!
    expect(agentRun.slice(-3)).toEqual(["ouro-eval-arm-a:1", "node", "/opt/ouro/dist/eval/interview-guest-entry.js"])
    // The household still runs from its own image.
    expect(named.calls.some((args) => args.includes(HOUSEHOLD_IMAGE))).toBe(true)
    const missing = fakeDocker({ runTurn: async () => reply as never })
    await expect(runSandboxed(input(missing.docker, { images, guest: { ...guest, image: "arm-b" } }))).rejects.toThrow("no agent image named arm-b")
    // Nothing ran for a refused guest, not even the Butler check that comes first.
    expect(missing.calls).toEqual([])
    expect(() => agentImageOf({ agent: SANDBOX_IMAGE, household: HOUSEHOLD_IMAGE }, "arm-a")).toThrow("no agent image named arm-a: the run's images name none")
    expect(agentImageOf(images, undefined)).toBe(SANDBOX_IMAGE)
  })

  it("gives the agent container the memory a guest names, 2g otherwise, and refuses a malformed amount before any run", async () => {
    const reply = { timeline: [], finalReply: "", outcome: "settled", steps: 0, turns: [{ start: 0, finalReply: "", outcome: "settled", calls: 0 }] }
    const memoryOf = (args: string[]): string[] => [args[args.indexOf("--memory") + 1]!, args[args.indexOf("--memory-swap") + 1]!]
    const agentOf = (calls: string[][]): string[] => calls.find((args) => args.includes("--name") && args[args.indexOf("--name") + 1]!.endsWith("-agent"))!
    const guest = { entry: "interview-guest-entry.js" as const, turn: { prefix: [], userText: "x" } }
    const big = fakeDocker({ runTurn: async () => reply as never })
    expect((await runSandboxed(input(big.docker, { guest: { ...guest, memory: "4g" } }))).outcome).toBe("settled")
    expect(memoryOf(agentOf(big.calls))).toEqual(["4g", "4g"])
    // Only the agent container takes the guest's memory; the household and the helpers keep 2g.
    for (const args of big.calls.filter((call) => call.includes("--memory") && call !== agentOf(big.calls))) expect(memoryOf(args)).toEqual(["2g", "2g"])
    const plain = fakeDocker({ runTurn: async () => reply as never })
    await runSandboxed(input(plain.docker, { guest }))
    expect(memoryOf(agentOf(plain.calls))).toEqual(["2g", "2g"])
    for (const bad of ["4", "0g", "4 g", "4g --privileged", "4k", "-1g"]) {
      const refused = fakeDocker({ runTurn: async () => reply as never })
      await expect(runSandboxed(input(refused.docker, { guest: { ...guest, memory: bad } }))).rejects.toThrow(`a guest's memory is a whole number of m or g, such as 4g, not ${bad}`)
      expect(refused.calls).toEqual([])
    }
  })

  it("reports another guest's malformed turns as a sandbox error, and a single turn as no follow-ups", async () => {
    const reply = { timeline: [], finalReply: "", outcome: "settled", steps: 0 }
    const bad = fakeDocker({ runTurn: async () => ({ ...reply, turns: [{ start: "0" }] }) as never })
    expect((await runSandboxed(input(bad.docker, { guest: { entry: "interview-guest-entry.js", turn: { prefix: [], userText: "x" } } }))).outcome).toBe("sandbox-error: the guest's result is malformed")
    const one = fakeDocker({ runTurn: async () => ({ ...reply, turns: [{ start: 0, finalReply: "", outcome: "settled", calls: 0 }] }) as never })
    expect((await runSandboxed(input(one.docker, { guest: { entry: "interview-guest-entry.js", turn: { prefix: [], userText: "x" } } }))).followUps).toEqual([])
  })

  it("passes another guest's own grade back as it came, and nothing of the kind from the Telegram turn", async () => {
    const reply = { timeline: [], finalReply: "", outcome: "settled", steps: 0, grade: { typecheck: true, axe: 0 } }
    const guest = { entry: "interview-guest-entry.js" as const, turn: { prefix: [], userText: "x" } }
    const graded = fakeDocker({ runTurn: async () => reply as never })
    expect((await runSandboxed(input(graded.docker, { guest }))).grade).toEqual({ typecheck: true, axe: 0 })
    const plain = fakeDocker({ runTurn: async () => ({ ...reply, grade: undefined }) as never })
    expect(await runSandboxed(input(plain.docker, { guest }))).not.toHaveProperty("grade")
    const telegram = fakeDocker({ runTurn: async () => reply as never })
    expect(await runSandboxed(input(telegram.docker))).not.toHaveProperty("grade")
  })

  it("splits a job that ended on a turn-ending call, with no reply of its own, from its debrief", () => {
    const call = (name: string) => ({ kind: "call" as const, name, args: "{}", result: "r" })
    const observation = { timeline: [call("write_file"), call("finish"), call("read_file"), { kind: "reply" as const, text: "6\nok" }], finalReply: "Finished", outcome: "settled", steps: 4 }
    const turns = [{ start: 0, finalReply: "Finished", outcome: "settled", calls: 2 }, { start: 2, finalReply: "6\nok", outcome: "settled", calls: 2 }]
    expect(splitTurns(observation, turns)).toEqual({
      observation: { ...observation, timeline: [call("write_file"), call("finish")] },
      followUps: [{ finalReply: "6\nok", outcome: "settled", calls: 2, toolCalls: 1 }],
    })
  })

  it("splits no follow-ups out of a timeline the guest's turn starts no longer index", () => {
    const observation = { timeline: [{ kind: "reply" as const, text: "a" }], finalReply: "a", outcome: "trace-mismatch", steps: 1 }
    const turns = [{ start: 0, finalReply: "a", outcome: "settled", calls: 1 }, { start: 1, finalReply: "b", outcome: "settled", calls: 1 }]
    expect(splitTurns(observation, turns)).toEqual({ observation, followUps: [] })
  })

  it("keeps the host's calls when the guest's trace disagrees with them", async () => {
    const { docker } = fakeDocker({
      runTurn: async () => ({ timeline: [{ kind: "call", name: "shell", args: "{\"command\":\"books check x\"}", result: "" }], finalReply: "", outcome: "settled", steps: 1 }),
    })
    expect((await runSandboxed(input(docker))).outcome).toBe("trace-mismatch")
  })

  it("ends a run whose agent container outlives its removal without reading anything back", async () => {
    const { docker, calls } = fakeDocker({ agentHangs: true })
    const obs = await runSandboxed(input(docker, { exitGraceMs: 20 }))
    expect(obs.outcome).toMatch(/^sandbox-error: the agent container did not stop within 20 ms of its removal/)
    // Nothing the agent might still be changing is read: no created files and none of the household's state.
    expect({ created: obs.created, library: obs.library, oracle: obs.oracle }).toEqual({ created: [], library: [], oracle: {} })
    expect(obs.timeline).toEqual([{ kind: "call", name: "shell", args: "{\"command\":\"books library remove 187\"}", result: "{\"ok\":true}" }])
    // The folder is still handed back and removed.
    expect(calls.some((args) => args.at(-1)?.startsWith("chown -R"))).toBe(true)
    expect(fs.readdirSync(root).filter((name) => name.startsWith("eval-sandbox-"))).toEqual([])
  })

  it("ends a run whose household outlives its removal without reading its state", async () => {
    const { docker } = fakeDocker({ householdHangs: true })
    const obs = await runSandboxed(input(docker, { exitGraceMs: 20 }))
    expect(obs.outcome).toMatch(/^sandbox-error: the household did not stop within 20 ms of its removal/)
    expect(obs.library).toEqual([])
  })

  it("fails a run that leaves more in its writable places than can be read back", async () => {
    const { docker } = fakeDocker({
      runTurn: async () => {
        const work = fs.readdirSync(root).find((name) => name.startsWith("eval-sandbox-"))!
        fs.mkdirSync(path.join(root, work, "bundle/books/work", ...Array.from({ length: 40 }, () => "d")), { recursive: true })
        return { timeline: [], finalReply: "", outcome: "settled", steps: 0 }
      },
    })
    const obs = await runSandboxed(input(docker))
    expect(obs.outcome).toMatch(/^sandbox-error: the turn left folders more than 32 deep at books\/work\/d/)
    expect(obs.created).toEqual([])
  })

  it("hands the folder back and still cleans up when the agent container cannot start or the removals fail", async () => {
    const { docker, calls } = fakeDocker({ agent: "throw", failRemovals: true, failReclaim: true })
    await expect(runSandboxed(input(docker))).rejects.toThrow(/docker is not installed/)
    expect(calls.some((args) => args.at(-1)?.startsWith("chown -R"))).toBe(true)
    // With the hand-back failing too, the household's shelf stays where the host cannot delete it, and is reported.
    const [left] = fs.readdirSync(root).filter((name) => name.startsWith("eval-sandbox-"))
    fs.chmodSync(path.join(root, left!, "household", "library"), 0o700)
  })

  it("finishes a run whose containers were already gone when it removed them", async () => {
    const { docker } = fakeDocker({ failRemovals: true })
    expect((await runSandboxed(input(docker))).outcome).toBe("settled")
  })

  it("fails when the household's state cannot be read back", async () => {
    const { docker } = fakeDocker({ state: { library: "none" } })
    await expect(runSandboxed(input(docker))).rejects.toThrow(/household state: no library/)
  })

  it("reports a run folder it cannot remove instead of failing the run", async () => {
    const { docker } = fakeDocker({ onNetwork: () => fs.chmodSync(root, 0o500) })
    const obs = await runSandboxed(input(docker))
    expect(obs.outcome).toBe("settled")
    fs.chmodSync(root, 0o700)
    expect(fs.readdirSync(root).filter((name) => name.startsWith("eval-sandbox-"))).toHaveLength(1)
  })
})

describe("dockerCli", () => {
  let dir: string
  let fake: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-docker-cli-"))
    fake = path.join(dir, "docker")
    fs.writeFileSync(fake, "#!/bin/sh\nif [ \"$1\" = fail ]; then echo \"no such image\" >&2; exit 3; fi\nif [ \"$1\" = cat ]; then cat; echo \"bye\" >&2; exit 0; fi\nif [ \"$1\" = die ]; then kill -9 $$; fi\necho \"args: $*\"\n", { mode: 0o755 })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("resolves with a command's output and rejects with its error output when it fails", async () => {
    const docker = dockerCli(fake)
    expect(await docker.run(["network", "ls"])).toBe("args: network ls\n")
    await expect(docker.run(["fail"])).rejects.toThrow("docker fail exited 3: no such image")
    await expect(dockerCli(path.join(dir, "missing")).run(["ps"])).rejects.toThrow(/ENOENT/)
  })

  it("starts a long-running command with its stdin, stdout, error output and exit code", async () => {
    const child = dockerCli(fake).start(["cat"])
    let out = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk })
    child.stdin.end("hello\n")
    expect(await child.exited).toBe(0)
    expect(out).toBe("hello\n")
    expect(child.stderr()).toBe("bye\n")
    expect(await dockerCli(path.join(dir, "missing")).start(["ps"]).exited).toBe(-1)
    expect(await dockerCli(fake).start(["die"]).exited).toBe(-1)
  })

  it("builds the agent's and the household's images from the checkout's eval Dockerfile", async () => {
    const calls: string[][] = []
    const docker: Docker = { run: async (args) => { calls.push(args); return "" }, start: () => { throw new Error("unused") } }
    await buildSandboxImage({ repoRoot: "/repo", docker })
    await buildSandboxImage({ repoRoot: "/repo", images: { agent: "ouro-eval-a:1", household: "ouro-eval-h:1" }, docker })
    const build = (target: string, tag: string) => ["build", "--file", "/repo/deploy/eval/Dockerfile", "--target", target, "--tag", tag, "/repo"]
    expect(calls).toEqual([build("agent", SANDBOX_IMAGE), build("household", HOUSEHOLD_IMAGE), build("agent", "ouro-eval-a:1"), build("household", "ouro-eval-h:1")])
  })

  it("retries a build the registry failed with a server error, and only that", async () => {
    let failures = 1
    const calls: string[][] = []
    const hiccup = new Error("docker build exited 1: failed to resolve source metadata for docker.io/library/node:22-bookworm-slim: unexpected status from HEAD request: 500 Internal Server Error")
    const flaky: Docker = { run: async (args) => { calls.push(args); if (failures-- > 0) throw hiccup; return "" }, start: () => { throw new Error("unused") } }
    await buildSandboxImage({ repoRoot: "/repo", docker: flaky, retryDelayMs: 0 })
    expect(calls.map((c) => c[4])).toEqual(["agent", "agent", "household"])

    const broken: Docker = { run: async () => { throw new Error("docker build exited 1: npm ERR! missing script") }, start: () => { throw new Error("unused") } }
    await expect(buildSandboxImage({ repoRoot: "/repo", docker: broken, retryDelayMs: 0 })).rejects.toThrow("missing script")

    let attempts = 0
    const down: Docker = { run: async () => { attempts++; throw hiccup }, start: () => { throw new Error("unused") } }
    await expect(buildSandboxImage({ repoRoot: "/repo", docker: down, retryDelayMs: 0 })).rejects.toThrow("500 Internal Server Error")
    expect(attempts).toBe(3)

    vi.useFakeTimers()
    try {
      let once = 1
      const slow: Docker = { run: async () => { if (once-- > 0) throw hiccup; return "" }, start: () => { throw new Error("unused") } }
      const built = buildSandboxImage({ repoRoot: "/repo", docker: slow })
      await vi.advanceTimersByTimeAsync(5000)
      await built
    } finally {
      vi.useRealTimers()
    }
  })

  it("labels both images ouro.eval=1, so eval:stop can find and remove them", () => {
    const dockerfile = fs.readFileSync(path.resolve(__dirname, "../../../../deploy/eval/Dockerfile"), "utf8")
    const stages = dockerfile.split(/^FROM /m).slice(1)
    expect(stages.map((stage) => stage.split("\n")[0])).toEqual(["node:22-bookworm-slim AS agent", "debian:bookworm-slim AS household"])
    for (const stage of stages) expect(stage).toMatch(new RegExp(`^LABEL ${EVAL_LABEL}$`, "m"))
  })

  it("keeps every interview guest entry, and the folders their code is in, in the agent image", () => {
    // The image removes every file of dist/eval it does not name, so an entry missing here fails in the container
    // with "Cannot find module" and never in a unit test; the scripted sandbox runs check what each entry loads.
    const dockerfile = fs.readFileSync(path.resolve(__dirname, "../../../../deploy/eval/Dockerfile"), "utf8")
    expect(INTERVIEW_GUEST_ENTRIES).toEqual(["interview-guest-entry.js", "h-guest-entry.js"])
    for (const entry of ["guest-entry.js", ...INTERVIEW_GUEST_ENTRIES]) expect(dockerfile).toContain(`! -name ${entry} `)
    expect(dockerfile).toMatch(/find dist\/eval\/interviews -mindepth 1 -maxdepth 1 ! -name guest /)
  })
})
