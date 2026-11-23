/**
 * Docker as the sandbox uses it, in process, for tests that pin exactly what a run hands Docker: every `docker`
 * command line, and every file the agent container is given (the bundle it mounts and its turn file), read at the
 * moment the agent container starts. Paths and names that change from run to run are replaced by placeholders, so two
 * runs of the same case compare byte for byte.
 */
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { PassThrough } from "node:stream"
import type { Docker, DockerProcess } from "../../../eval/sandbox/docker"
import { runGuest } from "../../../eval/sandbox/guest"
import type { runTelegramTurn } from "../../../eval/transport/telegram-turn"

export const sha = (text: string | Buffer): string => crypto.createHash("sha256").update(text).digest("hex")

export interface Recorded {
  calls: string[][]
  /** Each file the agent container could read, by its path in the container, with its write and run bits and sha256. */
  agentFiles: Record<string, string>
}

function mounts(args: string[]): Array<[string, string]> {
  const found: Array<[string, string]> = []
  args.forEach((arg, index) => {
    if (arg === "-v") {
      const [host, container] = args[index + 1]!.split(":")
      found.push([container!, host!])
    }
  })
  return found
}

function filesUnder(hostPath: string, containerPath: string, into: Record<string, string>): void {
  const stat = fs.lstatSync(hostPath)
  // A link points at a host path the container doesn't have, so it is recorded as a link, never followed.
  if (stat.isSymbolicLink()) {
    into[containerPath] = `link ${fs.readlinkSync(hostPath)}`
    return
  }
  // Only what the sandbox sets: whether the containers' users may write it, and whether it runs. The rest is the umask's.
  const bits = `${stat.mode & 0o002 ? "w" : "-"}${stat.mode & 0o100 ? "x" : "-"}`
  if (stat.isDirectory()) {
    into[`${containerPath}/`] = `${bits} folder`
    for (const name of fs.readdirSync(hostPath).sort()) filesUnder(path.join(hostPath, name), `${containerPath}/${name}`, into)
    return
  }
  into[containerPath] = `${bits} ${sha(fs.readFileSync(hostPath))}`
}

/** A Docker whose household is ready at once, whose fixtures are two books, and whose agent runs `runTurn` as its guest. */
export function recordingDocker(runTurn: typeof runTelegramTurn): { docker: Docker; recorded: Recorded } {
  const recorded: Recorded = { calls: [], agentFiles: {} }
  const ends = new Map<string, (code: number) => void>()
  const docker: Docker = {
    run: async (args) => {
      recorded.calls.push(args)
      const at = new Map(mounts(args))
      if (args.includes("/opt/eval/fakes/fixtures.py")) {
        fs.writeFileSync(path.join(at.get("/out")!, "A0.epub"), "A0")
        fs.writeFileSync(path.join(at.get("/out")!, "A.epub"), "A")
        return JSON.stringify({ A: sha("A"), A0: sha("A0") })
      }
      if (args.at(-1)?.includes("openssl")) {
        for (const name of ["ca.pem", "server.pem", "server.key"]) fs.writeFileSync(path.join(at.get("/out")!, name), name, { mode: 0o600 })
        return ""
      }
      if (args[0] === "rm") ends.get(args[2]!)?.(137)
      return ""
    },
    start: (args): DockerProcess => {
      recorded.calls.push(args)
      const at = mounts(args)
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      let exit!: (code: number) => void
      const exited = new Promise<number>((resolve) => { exit = resolve })
      const name = args[args.indexOf("--name") + 1]!
      ends.set(name, exit)
      if (name.endsWith("-household")) {
        const state = new Map(at).get("/eval/state")!
        fs.writeFileSync(path.join(state, "state.json"), JSON.stringify({ library: [], mail: [], events: [] }))
        setImmediate(() => stdout.write("{\"ready\": true, \"ports\": {}}\n"))
        return { stdin, stdout, exited, stderr: () => "" }
      }
      // The deepest mount wins, as in Docker: read each mount's files, the writable ones over the read-only bundle.
      for (const [container, host] of [...at].sort(([a], [b]) => a.length - b.length)) {
        if (fs.existsSync(host)) filesUnder(host, container, recorded.agentFiles)
      }
      void runGuest({ stdin, stdout, turnFile: new Map(at).get("/eval/turn.json")!, runTurn }).then(() => setImmediate(() => exit(0)))
      return { stdin, stdout, exited, stderr: () => "" }
    },
  }
  return { docker, recorded }
}

/** The recording with the run's id, its folder, the test's folder and the host user replaced by placeholders. */
export function normalized(recorded: Recorded, root: string): string {
  const runId = recorded.calls.find((args) => args[0] === "network" && args[1] === "create")!.at(-1)!
  const self = `${process.getuid!()}:${process.getgid!()}`
  // One line per command and per file, so a difference shows as the one line that changed.
  const lines = [
    ...recorded.calls.map((args) => JSON.stringify(args)),
    ...Object.entries(recorded.agentFiles).sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, what]) => `${file} ${what}`),
  ]
  return lines.join("\n")
    .replaceAll(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/${runId.slice(0, "eval-sandbox-".length)}[A-Za-z0-9]+`, "g"), "<work>")
    .replaceAll(runId, "<run>")
    .replaceAll(root, "<root>")
    .replaceAll(self, "<self>")
}
