/**
 * Runs one case in the two-container sandbox and reads back what happened.
 *
 * Each run makes a fresh `docker network create --internal` network (no route off the host) and two containers on
 * it, both `--rm --log-driver none --read-only --cap-drop ALL` with capped memory, CPU, processes and file size, each
 * from its own image (deploy/eval/Dockerfile) so the agent's holds none of the eval's grading code:
 * - the household sidecar (`household.py`, uid 10002), answering as `calibre-web`, `smtp` and the libgen mirror
 *   names over TLS signed by a test authority made for the run, whose key is deleted once it has signed. Its state
 *   folder is a host folder the agent container never mounts, and its admin port listens on its own loopback only.
 * - the agent container (uid 10001, `HOME=/home/ouro`, `--agent sanctuary`), running the real Telegram turn
 *   (`guest-entry.js`) on the projected bundle at the production path. The bundle is mounted read-only except the
 *   places the turn and the books CLI write: `books/work`, `books/removed`, `books/ledger.ndjson`, `state`,
 *   `friends` and `arc`. The test authority replaces the system trust store, and `books/credentials.json` is
 *   synthetic. Its provider is the host's runtime, served over the container's stdin and stdout, so no credential
 *   enters the container. Its `node` is execute-only, which leaves the guest undumpable: the shell the model runs
 *   cannot reach the guest's stdio, memory or trace, so it cannot speak on that channel.
 *
 * When the guest reports its turn done (or the deadline passes, or it exits), the host removes the agent container,
 * which ends every process the turn started, then the household, and only then reads the household's state file and
 * hashes the files that appeared in the writable mounts. A run whose files cannot be read back within the limits ends
 * as a sandbox error, which fails it. The containers, the network and the run's folder are removed afterwards,
 * whatever happened. Every name the run creates starts with `ouro-eval-`.
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
import { projectBundle } from "./projection"
import { assembleObservation, createdSince, readHouseholdState, SNAPSHOT_LIMITS, snapshotFiles, type GuestTurn, type HouseholdState } from "./readback"

export const SANDBOX_IMAGE = "ouro-eval-sandbox:local"
export const HOUSEHOLD_IMAGE = "ouro-eval-household:local"
export type SandboxImages = { agent: string; household: string }
export const LIBGEN_MIRRORS = ["libgen.li", "libgen.bz", "libgen.gl", "libgen.la", "libgen.vg"]
export const POCKETBOOK_ADDRESS = "pocketbook@example.invalid"
const ALIASES = ["calibre-web", "smtp", ...LIBGEN_MIRRORS]
const BUNDLE = "/home/ouro/AgentBundles/sanctuary.ouro"
/** What the turn and the books CLI write; everything else in the bundle is read-only. */
export const WRITABLE = ["books/work", "books/removed", "books/ledger.ndjson", "state", "friends", "arc"]
const HARDENING = [
  "--log-driver", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "512",
  "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--ulimit", `fsize=${SNAPSHOT_LIMITS.bytes}`,
]


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

/** Builds both eval images from a built checkout (`npm run build` first): the agent's (the harness `dist/` and its runtime dependencies) and the household's (the fakes). */
export async function buildSandboxImage(input: { repoRoot: string; images?: SandboxImages; docker: Docker }): Promise<void> {
  const images = input.images ?? { agent: SANDBOX_IMAGE, household: HOUSEHOLD_IMAGE }
  emitNervesEvent({ component: "eval", event: "eval.sandbox_image_start", message: "building the eval sandbox images", meta: images })
  for (const target of ["agent", "household"] as const) {
    await input.docker.run(["build", "--file", path.join(input.repoRoot, "deploy/eval/Dockerfile"), "--target", target, "--tag", images[target], input.repoRoot])
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
}

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

function guestTurn(outcome: GuestOutcome): GuestTurn {
  if (!outcome.ok) return { timeline: [], finalReply: "", outcome: `sandbox-error: ${outcome.error}` }
  const result = outcome.result as Partial<GuestTurn> | null
  if (!result || !Array.isArray(result.timeline) || typeof result.finalReply !== "string" || typeof result.outcome !== "string") {
    return { timeline: [], finalReply: "", outcome: "sandbox-error: the guest's result is malformed" }
  }
  return { timeline: result.timeline, finalReply: result.finalReply, outcome: result.outcome }
}

export async function runSandboxed(input: SandboxInput): Promise<Observation & { gaps: string[] }> {
  const docker = input.docker ?? dockerCli()
  const images = input.images ?? { agent: SANDBOX_IMAGE, household: HOUSEHOLD_IMAGE }
  const runId = `ouro-eval-${crypto.randomBytes(4).toString("hex")}`
  const last = input.case.prefix.at(-1)
  if (last?.role !== "user") throw new Error(`case ${input.case.id}: the prefix must end with the owner's message`)
  emitNervesEvent({ component: "eval", event: "eval.sandbox_run_start", message: "starting a sandboxed eval run", meta: { caseId: input.case.id, runId } })

  const work = fs.mkdtempSync(path.join(input.workRoot ?? os.tmpdir(), "ouro-eval-"))
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
      "run", "--rm", "--network", "none", "--log-driver", "none", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--cap-add", "FOWNER", "--cap-add", "DAC_OVERRIDE",
      "--user", "0:0", "-v", `${work}:/work`, images.household, "sh", "-c", `chown -R ${self} /work && chmod -R u+rwX /work`,
    ])
  }
  try {
    const { gaps } = projectBundle({ bundleDir: input.bundleDir, seedBundleDir: input.seedBundleDir, include: input.case.bundle.include, out: bundle })
    fs.writeFileSync(path.join(bundle, "books/credentials.json"), `${JSON.stringify(booksSettings(), null, 1)}\n`)
    for (const dir of [fixtures, tls, household]) fs.mkdirSync(dir)
    const helper = ["run", "--rm", "--network", "none", "--user", self, ...HARDENING]
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
    fs.writeFileSync(turnFile, JSON.stringify({ prefix: input.case.prefix.slice(0, -1), userText: last.content }))
    fs.chmodSync(household, 0o777)
    for (const entry of WRITABLE) openUp(path.join(bundle, entry))

    await docker.run(["network", "create", "--internal", "--label", "ouro-eval", runId])
    networkMade = true
    started.push(sidecarName)
    // From here a container's user may own files in the run's folder.
    reclaimed = false
    const sidecar = docker.start([
      "run", "--rm", "--name", sidecarName, "--network", runId, ...ALIASES.flatMap((alias) => ["--network-alias", alias]),
      "--user", "10002:10002", ...HARDENING, "--tmpfs", "/tmp:rw,size=64m",
      "-v", `${fixtures}:/eval/fixtures:ro`, "-v", `${seedFile}:/eval/seed.json:ro`,
      "-v", `${tls}/server.pem:/eval/tls/server.pem:ro`, "-v", `${tls}/server.key:/eval/tls/server.key:ro`, "-v", `${household}:/eval/state`,
      images.household, "python3", "/opt/eval/fakes/household.py", "--seed", "/eval/seed.json", "--fixtures", "/eval/fixtures", "--state", "/eval/state",
      "--tls-cert", "/eval/tls/server.pem", "--tls-key", "/eval/tls/server.key",
    ])
    await waitForReady(sidecar, input.readyTimeoutMs ?? 60_000)

    const before = snapshotFiles(bundle, WRITABLE)
    started.push(agentName)
    const agent = docker.start([
      "run", "-i", "--rm", "--name", agentName, "--network", runId, "--user", "10001:10001", ...HARDENING,
      "--tmpfs", "/tmp:rw,mode=1777,size=256m", "--tmpfs", "/home/ouro:rw,uid=10001,gid=10001,mode=0700,size=256m", "--env", "HOME=/home/ouro",
      "-v", `${bundle}:${BUNDLE}:ro`, ...WRITABLE.flatMap((entry) => ["-v", `${path.join(bundle, entry)}:${BUNDLE}/${entry}`]),
      "-v", `${tls}/ca.pem:/etc/ssl/certs/ca-certificates.crt:ro`, "-v", `${turnFile}:/eval/turn.json:ro`,
      images.agent, "node", "/opt/ouro/dist/eval/guest-entry.js", "--agent", "sanctuary",
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
        created = createdSince(before, snapshotFiles(bundle, WRITABLE))
      } catch (error) {
        turn = { timeline: [], finalReply: "", outcome: `sandbox-error: ${(error as Error).message}` }
      }
      state = readHouseholdState(path.join(household, "state.json"))
      for (const file of created) bytes.set(file.sha256, path.join(bundle, file.path))
      for (const book of state.library) bytes.set(book.sha256, path.join(household, "library", `${book.id}.epub`))
    }
    const observation = await assembleObservation({
      seed: input.case.seed, turn, hostCalls, steps: recorded.steps(), household: state, created, bytes,
      ...(input.oracle ? { oracle: input.oracle } : {}),
    })
    emitNervesEvent({ component: "eval", event: "eval.sandbox_run_end", message: "finished a sandboxed eval run", meta: { caseId: input.case.id, runId, outcome: observation.outcome } })
    return { ...observation, gaps }
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
