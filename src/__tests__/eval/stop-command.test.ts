import { expect, it } from "vitest"
import { parseStopArgs, runStopCommand, type HostRun } from "../../eval/stop-command"

/** A fake Docker host: labelled ids per kind, removed when asked, and a host lock in one of its states. */
function fakeHost(start: { containers: string[]; networks: string[]; images: string[] }, lock: { before: string; afterFree: string; status: string }, over: { failOn?: string; keep?: string } = {}) {
  const state = { containers: [...start.containers], networks: [...start.networks], images: [...start.images] }
  const calls: string[] = []
  const run: HostRun = async (argv) => {
    const line = argv.join(" ")
    calls.push(line)
    if (over.failOn && line.startsWith(over.failOn)) return { code: 1, stdout: "" }
    const kind = line.startsWith("docker ps") || line.startsWith("docker rm ") ? "containers" : line.startsWith("docker network") ? "networks" : "images"
    if (line.includes(" free-eval")) return { code: 0, stdout: `${lock.afterFree}\n` }
    if (line.includes(" status")) return { code: 0, stdout: `${lock.status}\n` }
    if (line.includes("--filter label=ouro.eval=1")) return { code: 0, stdout: state[kind].map((id) => `${id}\n`).join("") }
    state[kind] = state[kind].filter((id) => !argv.includes(id) || id === over.keep)
    return { code: 0, stdout: "" }
  }
  return { run, calls }
}

it("reads only a plain host and an absolute folder", () => {
  expect(parseStopArgs(["--sandbox-ssh", "sanctuary:/mnt/user/eval"])).toEqual({ host: "sanctuary", root: "/mnt/user/eval" })
  for (const bad of [[], ["--sandbox-ssh"], ["--other", "a:/b"], ["--sandbox-ssh", "sanctuary"], ["--sandbox-ssh", ":/b"], ["--sandbox-ssh", "a;b:/c"], ["--sandbox-ssh", "a:rel"], ["--sandbox-ssh", "a:/x/../y"], ["--sandbox-ssh", "a:/x y"], ["--sandbox-ssh", "a:/b", "x"], ["--sandbox-ssh", "-oProxyCommand:/b"]]) {
    expect(() => parseStopArgs(bad), bad.join(" ")).toThrow(/^usage: npm run eval:stop/)
  }
})

it("removes every labelled container, network and image, frees an eval's lock, and reads back that none remain", async () => {
  const host = fakeHost({ containers: ["c1", "c2"], networks: ["n1"], images: ["i1", "i1", "i2"] }, { before: "held", afterFree: "@@LOCK freed eval minimax (pid 9 on sanctuary) until x", status: "@@LOCK free" })
  const printed: string[] = []
  const result = await runStopCommand({ host: "sanctuary", root: "/e" }, host.run, (text) => printed.push(text))
  expect(result).toEqual({ exitCode: 0, removed: { containers: 2, networks: 1, images: 2 }, lock: "freed, now free", remaining: { containers: 0, networks: 0, images: 0 } })
  expect(host.calls).toEqual([
    "docker ps -aq --filter label=ouro.eval=1",
    "docker network ls -q --filter label=ouro.eval=1",
    "docker images -q --filter label=ouro.eval=1",
    "docker rm -f c1 c2",
    "docker network rm n1",
    "docker rmi -f i1 i2",
    "node /e/harness/deploy/unraid/ouro-host-lock.mjs free-eval",
    "docker ps -aq --filter label=ouro.eval=1",
    "docker network ls -q --filter label=ouro.eval=1",
    "docker images -q --filter label=ouro.eval=1",
    "node /e/harness/deploy/unraid/ouro-host-lock.mjs status",
  ])
  expect(printed).toEqual(["removed 2 containers, 1 networks and 2 images labelled ouro.eval=1 on sanctuary", "host lock: freed, now free", "read back: none remain"])
})

it("removes nothing when nothing is labelled, and passes with a Butler on the lock", async () => {
  const host = fakeHost({ containers: [], networks: [], images: [] }, { before: "other", afterFree: "@@LOCK kept butler:ship 1 (on s) until x", status: "@@LOCK other butler:ship 1 (on s) until x" })
  const result = await runStopCommand({ host: "s", root: "/e" }, host.run, () => undefined)
  expect(result).toMatchObject({ exitCode: 0, lock: "other" })
  expect(host.calls.filter((call) => call.startsWith("docker rm") || call.startsWith("docker network rm") || call.startsWith("docker rmi"))).toEqual([])
})

it("fails the read-back when something stays or an eval still holds the lock", async () => {
  const left = fakeHost({ containers: ["c1"], networks: [], images: [] }, { before: "free", afterFree: "@@LOCK free", status: "@@LOCK free" }, { keep: "c1" })
  const printed: string[] = []
  expect(await runStopCommand({ host: "s", root: "/e" }, left.run, (text) => printed.push(text))).toMatchObject({ exitCode: 1, remaining: { containers: 1 } })
  expect(printed[2]).toBe("read back: 1 containers, 0 networks and 0 images remain; host lock free")
  const held = fakeHost({ containers: [], networks: [], images: [] }, { before: "eval", afterFree: "@@LOCK free", status: "@@LOCK eval eval:c17 (on s) until x" })
  expect(await runStopCommand({ host: "s", root: "/e" }, held.run, () => undefined)).toMatchObject({ exitCode: 1, lock: "eval" })
  const garbled = fakeHost({ containers: [], networks: [], images: [] }, { before: "free", afterFree: "", status: "nonsense" })
  expect(await runStopCommand({ host: "s", root: "/e" }, garbled.run, () => undefined)).toMatchObject({ exitCode: 1, lock: "unknown" })
})

it("throws when a step exits with an error, naming the step only", async () => {
  const host = fakeHost({ containers: ["c1"], networks: [], images: [] }, { before: "free", afterFree: "@@LOCK free", status: "@@LOCK free" }, { failOn: "docker rm" })
  await expect(runStopCommand({ host: "s", root: "/e" }, host.run, () => undefined)).rejects.toThrow(/^docker rm -f exited 1$/)
  const lockFails = fakeHost({ containers: [], networks: [], images: [] }, { before: "free", afterFree: "", status: "" }, { failOn: "node" })
  await expect(runStopCommand({ host: "s", root: "/secret/place" }, lockFails.run, () => undefined)).rejects.toThrow(/^host lock free-eval exited 1$/)
})
