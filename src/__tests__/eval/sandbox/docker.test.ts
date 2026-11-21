import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ProviderRuntime } from "../../../heart/core"
import type { Case } from "../../../eval/domain/case"
import { buildSandboxImage, dockerCli, HOUSEHOLD_IMAGE, runSandboxed, SANDBOX_IMAGE, type Docker, type DockerProcess } from "../../../eval/sandbox/docker"
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

    const network = calls.find((args) => args[0] === "network" && args[1] === "create")!
    expect(network).toEqual(["network", "create", "--internal", "--label", "ouro-eval", expect.stringMatching(/^ouro-eval-[0-9a-f]{8}$/)])
    const runId = network.at(-1)!

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
    expect(fs.readdirSync(root).filter((name) => name.startsWith("ouro-eval-"))).toEqual([])
  })

  it("writes the books CLI's synthetic settings and the turn file, and opens the writable mounts to the containers", async () => {
    let seen: { settings: unknown; turn: unknown; modes: Record<string, number>; seeded: string } | undefined
    const { docker } = fakeDocker({
      runTurn: async () => {
        const work = fs.readdirSync(root).find((name) => name.startsWith("ouro-eval-"))!
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
        const work = fs.readdirSync(root).find((name) => name.startsWith("ouro-eval-"))!
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
    expect(fs.readdirSync(root).filter((name) => name.startsWith("ouro-eval-"))).toEqual([])
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
    expect(fs.readdirSync(root).filter((name) => name.startsWith("ouro-eval-"))).toEqual([])
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
        const work = fs.readdirSync(root).find((name) => name.startsWith("ouro-eval-"))!
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
    const [left] = fs.readdirSync(root).filter((name) => name.startsWith("ouro-eval-"))
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
    expect(fs.readdirSync(root).filter((name) => name.startsWith("ouro-eval-"))).toHaveLength(1)
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
})
