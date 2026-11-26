/**
 * Runs one case in the two-container sandbox and reads back what happened.
 *
 * Each run makes a fresh `docker network create --internal` network (no route off the host) and two containers on
 * it, both `--rm --log-driver none --read-only --cap-drop ALL` with capped memory, CPU, processes and file size, each
 * from its own image (deploy/eval/Dockerfile) so the agent's holds none of the eval's grading code:
 * - the household sidecar (`household.py`, uid 10002), answering as `calibre-web`, `smtp` and the libgen mirror
 *   names over TLS signed by a test authority made for the run, whose key is deleted once it has signed. Its state
 *   folder is a host folder the agent container never mounts, and its admin port listens on its own loopback only.
 * - the agent container (uid 10001, `HOME=/home/ouro`, `--agent <agent>`), running the real Telegram turn
 *   (`guest-entry.js`) on the profile's bundle at the production path, `$HOME/AgentBundles/<agent>.ouro`. The bundle is
 *   mounted read-only except the profile's writable paths. The Butler is the default profile; its writable paths are
 *   where the turn and the books CLI write: `books/work`, `books/removed`, `books/ledger.ndjson`, `state`, `friends`,
 *   `arc` and `desk/_record`. The test authority replaces the system trust store, and `books/credentials.json` is
 *   synthetic. Its provider is the host's runtime, served over the container's stdin and stdout, so no credential
 *   enters the container. Its `node` is execute-only, which leaves the guest undumpable: the shell the model runs
 *   cannot reach the guest's stdio, memory or trace, so it cannot speak on that channel.
 *
 * When the guest reports its turn done (or the deadline passes, or it exits), the host removes the agent container,
 * which ends every process the turn started, then the household, and only then reads the household's state file and
 * hashes the files that appeared in the writable mounts. A run whose files cannot be read back within the limits ends
 * as a sandbox error, which fails it. The containers, the network and the run's folder are removed afterwards,
 * whatever happened. Every name the run creates starts with `eval-sandbox-`, outside the `ouro-` names the Butler's
 * tooling owns, and every container and network it creates carries the labels `ouro.eval=1` and `ouro.eval.run=<run>`.
 *
 * It refuses to run on a host that has any of the live Butler's containers unless the caller holds a host lock
 * that the Butler's lifecycle honours: on 2026-11-23 an eval container vanishing mid-upgrade broke the Butler's
 * upgrade and its rollback on the host they shared (#1760).
 */
import { spawn } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import type { ProviderRuntime } from "../../heart/core"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Case, Observation, TraceCall } from "../domain/case"
import { createStreamChannel, serveProxyRuntime, type GuestOutcome } from "../transport/provider-proxy"
import { recordModelTraffic } from "../transport/telegram-turn"
import { DECLARED_GAPS } from "./declared-gaps"
import { agentImageOf, type SandboxImages } from "./images"
import { type AgentProfile, bundleMounts, checkProfile, sanctuaryProfile } from "./agent-profile"
import { assembleObservation, createdSince, readHouseholdState, SNAPSHOT_LIMITS, snapshotFiles, type GuestTurn, type HouseholdState } from "./readback"

export const SANDBOX_IMAGE = "ouro-eval-sandbox:local"
export const HOUSEHOLD_IMAGE = "ouro-eval-household:local"
/** What every container, network and folder a sandboxed run creates is named after. */
export const EVAL_RUN_PREFIX = "eval-sandbox-"
/** The label on everything an eval run creates, so other tooling on the host can tell it is not its own. */
export const EVAL_LABEL = "ouro.eval=1"
/** The live Butler's containers (sanctuary-deployment-target.mjs CANONICAL_NAMES); a host that has any of them is the Butler's. */
export const BUTLER_CONTAINERS = "^/?ouro-butler(-staging|-rollback)?$"
/** A lock on a Butler's host that its lifecycle (upgrade and rollback) honours while an eval run holds it. */
export type HostLock = { held(): Promise<boolean> }
export type { SandboxImages } from "./images"
export const LIBGEN_MIRRORS = ["libgen.li", "libgen.bz", "libgen.gl", "libgen.la", "libgen.vg"]
export const POCKETBOOK_ADDRESS = "pocketbook@example.invalid"
const ALIASES = ["calibre-web", "smtp", ...LIBGEN_MIRRORS]
/** Every container's limits; `memory` is the agent container's when its guest names one (`guest.memory`), 2g otherwise. */
function hardening(memory = "2g"): string[] {
  return [
    "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
    "--memory", memory, "--memory-swap", memory, "--cpus", "2", "--ulimit", `fsize=${SNAPSHOT_LIMITS.bytes}`,
  ]
}
const HARDENING = hardening()
/** A guest's memory goes to `docker run` as one argument, so it is only ever a whole number of megabytes or gigabytes. */
const GUEST_MEMORY = /^[1-9]\d*[mg]$/


export type DockerProcess = { stdin: Writable; stdout: Readable; exited: Promise<number>; stderr(): string }
export type Docker = {
  /** `docker <args>`, resolving with its stdout; rejects when it exits non-zero. */
  run(args: string[]): Promise<string>
  /** `docker <args>` left running, with its stdin and stdout. */
  start(args: string[]): DockerProcess
}

const STDERR_TAIL = 4000

export function dockerCli(command = "docker"): Docker {
  return {
    run: (args) => new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
      let out = ""
      let err = ""
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { out += chunk })
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err = (err + chunk).slice(-STDERR_TAIL) })
      child.on("error", reject)
      child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`docker ${args[0]} exited ${code}: ${err.trim()}`)))
    }),
    start: (args) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] })
      let err = ""
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { err = (err + chunk).slice(-STDERR_TAIL) })
      const exited = new Promise<number>((resolve) => {
        child.on("error", () => resolve(-1))
        child.on("close", (code) => resolve(code ?? -1))
      })
      return { stdin: child.stdin, stdout: child.stdout, exited, stderr: () => err }
    },
  }
}

const BUILD_ATTEMPTS = 3
/** A registry answering 5xx or dropping the connection while the base image is fetched; any other build failure is real. */
const REGISTRY_HICCUP = /(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Time-?out|unexpected status[^\n]*5\d\d|TLS handshake timeout|i\/o timeout|connection reset by peer)/i

/** Builds both eval images from a built checkout (`npm run build` first): the agent's (the harness `dist/` and its runtime dependencies) and the household's (the fakes). */
export async function buildSandboxImage(input: { repoRoot: string; images?: SandboxImages; docker: Docker; retryDelayMs?: number }): Promise<void> {
  const images = input.images ?? { agent: SANDBOX_IMAGE, household: HOUSEHOLD_IMAGE }
  emitNervesEvent({ component: "eval", event: "eval.sandbox_image_start", message: "building the eval sandbox images", meta: images })
  for (const target of ["agent", "household"] as const) {
    const args = ["build", "--file", path.join(input.repoRoot, "deploy/eval/Dockerfile"), "--target", target, "--tag", images[target], input.repoRoot]
    for (let attempt = 1; ; attempt++) {
      try {
        await input.docker.run(args)
        break
      } catch (error) {
        const message = (error as Error).message
        if (attempt >= BUILD_ATTEMPTS || !REGISTRY_HICCUP.test(message)) throw error
        emitNervesEvent({ level: "warn", component: "eval", event: "eval.sandbox_image_retry", message: "a registry error stopped the image build; retrying", meta: { target, attempt, reason: message.slice(0, 300) } })
        await new Promise((resolve) => setTimeout(resolve, (input.retryDelayMs ?? 5000) * attempt))
      }
    }
  }
  emitNervesEvent({ component: "eval", event: "eval.sandbox_image_end", message: "built the eval sandbox images", meta: images })
}

export type SandboxInput = {
  case: Case
  /** The bundle under test; only the case's `include` paths are used. */
  bundleDir: string
  /** The host's provider runtime for the run, served to the agent container. */
  host: ProviderRuntime
  budget: { take(): boolean }
  /** The public seed bundle the package-managed files come from. */
  seedBundleDir: string
  images?: SandboxImages
  docker?: Docker
  /** Where the run's private folder is made; the system temp folder by default. */
  workRoot?: string
  /** The pinned checker for files no fixture label covers. */
  oracle?: (file: string) => Promise<boolean>
  turnTimeoutMs?: number
  readyTimeoutMs?: number
  /** How long to wait for a removed container's `docker run` to end before going on without it; 30 s by default. */
  exitGraceMs?: number
  /**
   * Another guest than the real Telegram turn: the blind interviews' neutral loop, with the turn file it reads. Its
   * answer may have several user turns; the first is the job, scored as any run, and the rest come back as `followUps`.
   * `memory` is its container's memory and swap (such as `4g`), for a guest whose own work needs more than 2g.
   */
  guest?: { entry: InterviewGuestEntry; turn: unknown; image?: string; memory?: string }
  /** Lets the run share a host with the live Butler; without it, such a host is refused. */
  hostLock?: HostLock
  /**
   * The agent the container runs: its name, its bundle and what the turn may write (`agent-profile.ts`). The Butler's
   * by default, its bundle projected from `bundleDir` over `seedBundleDir`.
   */
  profile?: AgentProfile
}

/**
 * The guest entries the agent image keeps besides the Telegram turn's: the neutral loop's for U and X, and H's, which
 * runs each arm's own agent loop. `deploy/eval/Dockerfile` keeps each of these and removes every other file.
 */
export const INTERVIEW_GUEST_ENTRIES = ["interview-guest-entry.js", "h-guest-entry.js"] as const
export type InterviewGuestEntry = typeof INTERVIEW_GUEST_ENTRIES[number]

/** A later user turn in the same conversation (the interviews' debrief): its answer and how it ended. */
export type FollowUp = { finalReply: string; outcome: string; calls: number; toolCalls?: number }

/** Synthetic settings for the books CLI, pointing at the fake household and nothing else. */
function booksSettings(): object {
  return {
    calibre_web: { url: "http://calibre-web:8083", username: "butler", password: "eval-password" },
    smtp: { host: "smtp", port: 2525, user: "eval", password: "eval-password" },
    pocketbook: { from: "butler@example.invalid", to: POCKETBOOK_ADDRESS },
    libgen: { mirrors: LIBGEN_MIRRORS.map((host) => `https://${host}`) },
  }
}

/** A test authority and a server certificate for every alias; the authority's key is deleted once it has signed. */
function tlsScript(): string {
  const names = ALIASES.map((name) => `DNS:${name}`).join(",")
  return [
    "set -eu",
    "cd /out",
    "openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=ouro-eval test authority' -keyout ca.key -out ca.pem 2>/dev/null",
    "openssl req -newkey rsa:2048 -nodes -subj '/CN=ouro-eval household' -keyout server.key -out server.csr 2>/dev/null",
    `printf 'subjectAltName=${names}\\nbasicConstraints=critical,CA:FALSE\\nkeyUsage=critical,digitalSignature,keyEncipherment\\nextendedKeyUsage=serverAuth\\n' > server.ext`,
    "openssl x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile server.ext -out server.pem 2>/dev/null",
    "rm -f ca.key ca.srl server.csr server.ext",
  ].join("\n")
}

/** Makes every folder under `target` writable by the containers' users, which are not the host's. */
function openUp(target: string): void {
  const stat = fs.lstatSync(target)
  if (stat.isDirectory()) {
    fs.chmodSync(target, 0o777)
    for (const name of fs.readdirSync(target)) openUp(path.join(target, name))
  } else {
    fs.chmodSync(target, 0o666)
  }
}

function waitForReady(sidecar: DockerProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffered = ""
    const timer = setTimeout(() => reject(new Error(`the household was not ready within ${timeoutMs} ms`)), timeoutMs)
    sidecar.stdout.setEncoding("utf8")
    sidecar.stdout.on("data", (chunk: string) => {
      buffered += chunk
      if (buffered.split("\n").some((line) => line.includes("\"ready\": true"))) {
        clearTimeout(timer)
        resolve()
      }
    })
    void sidecar.exited.then((code) => {
      clearTimeout(timer)
      reject(new Error(`the household exited (${code}) before it was ready: ${sidecar.stderr().trim()}`))
    })
  })
}

/** The guest's `done` message, or why there is none: the container exited first, or the deadline passed. */
function waitForGuest(agent: DockerProcess, onDone: (listen: (outcome: GuestOutcome) => void) => void, timeoutMs: number): Promise<GuestOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `the turn did not finish within ${timeoutMs} ms` }), timeoutMs)
    onDone((outcome) => { clearTimeout(timer); resolve(outcome) })
    void agent.exited.then((code) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `the agent container exited (${code}) before the turn finished: ${agent.stderr().trim()}` })
    })
  })
}

/** Whether a removed container's `docker run` ended within the grace period. */
const settle = (exited: Promise<number>, graceMs: number): Promise<boolean> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), graceMs)
  void exited.then(() => { clearTimeout(timer); resolve(true) })
})

type GuestTurns = Array<{ start: number } & FollowUp>

const isTurns = (value: unknown): value is GuestTurns => Array.isArray(value) && value.every((turn: Record<string, unknown> | null) => typeof turn === "object" && turn !== null
  && Number.isInteger(turn.start) && typeof turn.finalReply === "string" && typeof turn.outcome === "string" && Number.isInteger(turn.calls))

function guestTurn(outcome: GuestOutcome): GuestTurn & { turns?: GuestTurns; grade?: unknown } {
  if (!outcome.ok) return { timeline: [], finalReply: "", outcome: `sandbox-error: ${outcome.error}` }
  const result = outcome.result as Partial<GuestTurn> & { turns?: unknown; grade?: unknown } | null
  if (!result || !Array.isArray(result.timeline) || typeof result.finalReply !== "string" || typeof result.outcome !== "string" || (result.turns !== undefined && !isTurns(result.turns))) {
    return { timeline: [], finalReply: "", outcome: "sandbox-error: the guest's result is malformed" }
  }
  return {
    timeline: result.timeline, finalReply: result.finalReply, outcome: result.outcome, ...(result.turns ? { turns: result.turns } : {}),
    ...(result.grade !== undefined ? { grade: result.grade } : {}),
  }
}

/** The job's part of a merged timeline and the later turns, by where the guest said each turn starts. */
export function splitTurns(observation: Observation, turns: GuestTurns | undefined): { observation: Observation; followUps: FollowUp[] } {
  // After a trace mismatch the timeline is the host's calls, not the guest's, so the guest's turn starts don't index it.
  if (!turns || turns.length < 2 || observation.outcome === "trace-mismatch") return { observation, followUps: [] }
  const end = turns[1]!.start
  return {
    observation: { ...observation, timeline: observation.timeline.slice(0, end) },
    followUps: turns.slice(1).map(({ start, finalReply, outcome, calls }, i) => ({
      finalReply, outcome, calls, toolCalls: observation.timeline.slice(start, turns[i + 2]?.start).filter((entry) => entry.kind === "call").length,
    })),
  }
}

export async function runSandboxed(input: SandboxInput): Promise<Observation & { gaps: string[]; followUps?: FollowUp[]; grade?: unknown }> {
  const docker = input.docker ?? dockerCli()
  const images: SandboxImages = input.images ?? { agent: SANDBOX_IMAGE, household: HOUSEHOLD_IMAGE }
  const agentImage = agentImageOf(images, input.guest?.image)
  const memory = input.guest?.memory
  if (memory !== undefined && !GUEST_MEMORY.test(memory)) throw new Error(`a guest's memory is a whole number of m or g, such as 4g, not ${memory}`)
  if (memory !== undefined) emitNervesEvent({ component: "eval", event: "eval.sandbox_guest_memory", message: "the guest's container takes its own memory", meta: { memory } })
  const profile = input.profile ?? sanctuaryProfile({ bundleDir: input.bundleDir, seedBundleDir: input.seedBundleDir })
  checkProfile(profile)
  const runId = `${EVAL_RUN_PREFIX}${crypto.randomBytes(4).toString("hex")}`
  const runLabels = ["--label", EVAL_LABEL, "--label", `ouro.eval.run=${runId}`]
  const last = input.case.prefix.at(-1)
  if (last?.role !== "user") throw new Error(`case ${input.case.id}: the prefix must end with the owner's message`)
  // Docker matches the filter against the name with its leading slash; any container it lists makes this the Butler's host.
  const butler = (await docker.run(["ps", "--all", "--filter", `name=${BUTLER_CONTAINERS}`, "--format", "{{.Names}}"])).trim()
  if (butler !== "" && !(await input.hostLock?.held())) {
    throw new Error(`refusing to run the eval sandbox on this host: it runs the live Butler (${butler.split("\n").join(", ")}), and no host lock that the Butler's upgrade and rollback honour is held`)
  }
  emitNervesEvent({ component: "eval", event: "eval.sandbox_run_start", message: "starting a sandboxed eval run", meta: { caseId: input.case.id, runId } })
  const work = fs.mkdtempSync(path.join(input.workRoot ?? os.tmpdir(), EVAL_RUN_PREFIX))
  fs.chmodSync(work, 0o700)
  const bundle = path.join(work, "bundle")
  const fixtures = path.join(work, "fixtures")
  const tls = path.join(work, "tls")
  const household = path.join(work, "household")
  const agentName = `${runId}-agent`
  const sidecarName = `${runId}-household`
  const started: string[] = []
  let networkMade = false
  let reclaimed = true
  const self = `${process.getuid!()}:${process.getgid!()}`
  // The containers' users own what they wrote, and may have locked it; hand it all back before reading or deleting.
  const reclaim = async (): Promise<void> => {
    reclaimed = true
    await docker.run([
      "run", "--rm", ...runLabels, "--network", "none", "--log-driver", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
      "--user", "0:0", "-v", `${work}:/work`, images.household, "sh", "-c", `chown -R ${self} /work && chmod -R u+rwX /work`,
    ])
  }
  try {
    // Every case is a books case, so the bundle source must make `books/` and each writable path, as the projection does.
    const { gaps } = profile.bundleSource({ include: input.case.bundle.include, out: bundle })
    fs.writeFileSync(path.join(bundle, "books/credentials.json"), `${JSON.stringify(booksSettings(), null, 1)}\n`)
    for (const dir of [fixtures, tls, household]) fs.mkdirSync(dir)
    const helper = ["run", "--rm", ...runLabels, "--network", "none", "--user", self, ...HARDENING]
    const labels = JSON.parse(await docker.run([...helper, "-v", `${fixtures}:/out`, images.household, "python3", "/opt/eval/fakes/fixtures.py", "build", "/out"])) as Record<string, string>
    // A seeded file sits where an earlier `books get` would have left it, so its place does not mark it as seeded.
    const earlier = Math.floor(Date.now() / 1000) - 86_400
    input.case.seed.disk.forEach((sha256, index) => {
      const name = Object.keys(labels).find((label) => labels[label] === sha256)
      if (!name) throw new Error(`case ${input.case.id} seeds ${sha256} on disk, which is no fixture`)
      const work = input.case.seed.labels.find((label) => label.sha256 === sha256)?.work ?? "book"
      const folder = path.join(bundle, "books/work", `${earlier + index}-${crypto.randomBytes(4).toString("hex")}`)
      fs.mkdirSync(folder)
      fs.copyFileSync(path.join(fixtures, `${name}.epub`), path.join(folder, `${work}.epub`))
    })
    await docker.run([...helper, "-v", `${tls}:/out`, images.household, "sh", "-c", tlsScript()])
    fs.chmodSync(path.join(tls, "server.key"), 0o644)
    const seedFile = path.join(work, "seed.json")
    fs.writeFileSync(seedFile, JSON.stringify({ ...input.case.seed, calibreWeb: { username: "butler", password: "eval-password" }, smtp: { user: "eval", password: "eval-password" } }))
    const turnFile = path.join(work, "turn.json")
    fs.writeFileSync(turnFile, JSON.stringify(input.guest ? input.guest.turn : { prefix: input.case.prefix.slice(0, -1), userText: last.content }))
    fs.chmodSync(household, 0o777)
    for (const entry of profile.writable) openUp(path.join(bundle, entry))

    await docker.run(["network", "create", "--internal", ...runLabels, runId])
    networkMade = true
    started.push(sidecarName)
    // From here a container's user may own files in the run's folder.
    reclaimed = false
    const sidecar = docker.start([
      "run", "--rm", "--name", sidecarName, ...runLabels, "--network", runId, ...ALIASES.flatMap((alias) => ["--network-alias", alias]),
      "--user", "10002:10002", ...HARDENING, "--tmpfs", "/tmp:rw,size=64m",
      "-v", `${fixtures}:/eval/fixtures:ro`, "-v", `${seedFile}:/eval/seed.json:ro`,
      "-v", `${tls}/server.pem:/eval/tls/server.pem:ro`, "-v", `${tls}/server.key:/eval/tls/server.key:ro`, "-v", `${household}:/eval/state`,
      images.household, "python3", "/opt/eval/fakes/household.py", "--seed", "/eval/seed.json", "--fixtures", "/eval/fixtures", "--state", "/eval/state",
      "--tls-cert", "/eval/tls/server.pem", "--tls-key", "/eval/tls/server.key",
    ])
    await waitForReady(sidecar, input.readyTimeoutMs ?? 60_000)

    const before = snapshotFiles(bundle, [...profile.writable])
    started.push(agentName)
    const agent = docker.start([
      "run", "-i", "--rm", "--name", agentName, ...runLabels, "--network", runId, "--user", "10001:10001", ...hardening(memory),
      "--tmpfs", "/tmp:rw,mode=1777,size=256m", "--tmpfs", "/home/ouro:rw,uid=10001,gid=10001,mode=0700,size=256m", "--env", "HOME=/home/ouro",
      ...bundleMounts(profile, bundle),
      "-v", `${tls}/ca.pem:/etc/ssl/certs/ca-certificates.crt:ro`, "-v", `${turnFile}:/eval/turn.json:ro`,
      agentImage, "node", ...(input.guest ? [`/opt/ouro/dist/eval/${input.guest.entry}`] : ["/opt/ouro/dist/eval/guest-entry.js", "--agent", profile.agent]),
    ])
    const hostCalls: TraceCall[] = []
    const recorded = recordModelTraffic(input.host, hostCalls)
    const channel = createStreamChannel(agent.stdout, agent.stdin)
    serveProxyRuntime(channel, recorded.runtime, input.budget)
    const outcome = await waitForGuest(agent, (listen) => channel.onMessage((msg) => { if (msg.type === "done") listen(msg.outcome) }), input.turnTimeoutMs ?? 600_000)
    // Ends every process the turn started, then the household, before anything is read back.
    await docker.run(["rm", "--force", agentName]).catch(() => "")
    const graceMs = input.exitGraceMs ?? 30_000
    const agentStopped = await settle(agent.exited, graceMs)
    await docker.run(["rm", "--force", sidecarName]).catch(() => "")
    const householdStopped = await settle(sidecar.exited, graceMs)
    await reclaim()

    let turn = guestTurn(outcome)
    let created: Observation["created"] = []
    let state: HouseholdState = { library: [], mail: [], events: 0 }
    const bytes = new Map<string, string>()
    // A container that may still be running could change what is read, so nothing is read back from such a run.
    const stuck = !agentStopped ? "the agent container" : !householdStopped ? "the household" : undefined
    if (stuck) {
      turn = { timeline: [], finalReply: "", outcome: `sandbox-error: ${stuck} did not stop within ${graceMs} ms of its removal` }
    } else {
      try {
        created = createdSince(before, snapshotFiles(bundle, [...profile.writable]))
      } catch (error) {
        turn = { timeline: [], finalReply: "", outcome: `sandbox-error: ${(error as Error).message}` }
      }
      state = readHouseholdState(path.join(household, "state.json"))
      for (const file of created) bytes.set(file.sha256, path.join(bundle, file.path))
      for (const book of state.library) bytes.set(book.sha256, path.join(household, "library", `${book.id}.epub`))
    }
    const assembled = await assembleObservation({
      seed: input.case.seed, turn, hostCalls, steps: recorded.steps(), household: state, created, bytes,
      ...(input.oracle ? { oracle: input.oracle } : {}),
    })
    const { observation, followUps } = splitTurns(assembled, turn.turns)
    emitNervesEvent({ component: "eval", event: "eval.sandbox_run_end", message: "finished a sandboxed eval run", meta: { caseId: input.case.id, runId, outcome: observation.outcome } })
    // A guest's own grade (a product scored in the container) goes back as it came, only from a turn read back whole.
    return {
      ...observation, gaps: [...gaps, ...(input.guest ? [] : DECLARED_GAPS)], ...(input.guest ? { followUps } : {}),
      ...(input.guest && turn.grade !== undefined ? { grade: turn.grade } : {}),
    }
  } catch (error) {
    emitNervesEvent({ component: "eval", level: "error", event: "eval.sandbox_run_error", message: "a sandboxed eval run failed", meta: { caseId: input.case.id, runId, error: (error as Error).message } })
    throw error
  } finally {
    for (const name of started.reverse()) await docker.run(["rm", "--force", name]).catch(() => "")
    if (networkMade) await docker.run(["network", "rm", runId]).catch(() => "")
    if (!reclaimed) await reclaim().catch(() => undefined)
    try {
      fs.rmSync(work, { recursive: true, force: true })
    } catch (error) {
      emitNervesEvent({ component: "eval", level: "error", event: "eval.sandbox_cleanup_error", message: "a sandboxed run's folder could not be removed", meta: { work, error: (error as Error).message } })
    }
  }
}
