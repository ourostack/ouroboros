// `node dist/eval/interview-entry.js` with `--host-lock <holder>` holds the remote host's lock for the whole command
// (deploy/unraid/ouro-host-lock.mjs), sends its token with every job and releases it after, as `run-entry` does.
import { afterEach, expect, it, vi } from "vitest"

const runner = vi.hoisted(() => ({ parse: vi.fn(), run: vi.fn() }))
vi.mock("../../eval/interviews/runner", () => ({ parseInterviewArgs: runner.parse, runInterviews: runner.run, X_KIT: {} }))
vi.mock("../../eval/targets", () => ({ resolveTarget: vi.fn() }))
vi.mock("../../eval/report", () => ({ writePrivateReport: vi.fn() }))
vi.mock("../../eval/self-test", () => ({ loadCases: vi.fn() }))
const sandbox = vi.hoisted(() => ({ runSandboxed: vi.fn(), remoteRunCase: vi.fn(), sshNode: vi.fn((host: string, args: string[]) => ({ host, args })) }))
vi.mock("../../eval/sandbox/docker", () => ({ dockerCli: vi.fn(), runSandboxed: sandbox.runSandboxed }))
vi.mock("../../eval/sandbox/remote", () => ({ remoteRunCase: sandbox.remoteRunCase, sshStart: vi.fn(), sshNode: sandbox.sshNode }))
const lock = vi.hoisted(() => ({ holdHostLock: vi.fn(), release: vi.fn() }))
vi.mock("../../eval/sandbox/host-lock", () => ({ holdHostLock: lock.holdHostLock, HOST_LOCK_TTL_S: 21600, HOST_LOCK_WAIT_S: 1800 }))

const previous = process.exitCode
const argv = process.argv
afterEach(() => {
  process.exitCode = previous
  process.argv = argv
  vi.resetModules()
  vi.restoreAllMocks()
  lock.release.mockClear()
  lock.holdHostLock.mockReset()
  sandbox.remoteRunCase.mockClear()
  runner.run.mockReset()
})

async function run(flags: string[]): Promise<{ stderr: string[]; exitCode: typeof process.exitCode }> {
  const stderr: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write)
  process.argv = ["node", "interview-entry.js", ...flags]
  process.exitCode = undefined
  runner.parse.mockReturnValue({})
  await import("../../eval/interview-entry")
  await vi.waitFor(() => expect(process.exitCode).toBeDefined())
  return { stderr, exitCode: process.exitCode }
}

const REMOTE = ["--sandbox-ssh", "sanctuary:/tmp/x", "--bundle", "/tmp/x/bundle"]

it("holds the remote host's lock for the whole command, sends its token with every job, and releases it after", async () => {
  lock.holdHostLock.mockResolvedValue({ token: "t0k", release: lock.release })
  runner.run.mockImplementation(async () => {
    expect(lock.release).not.toHaveBeenCalled()
    return { exitCode: 0 }
  })
  expect((await run([...REMOTE, "--host-lock", "eval:c16-interviews"])).exitCode).toBe(0)
  expect(lock.holdHostLock).toHaveBeenCalledWith({
    host: "sanctuary",
    args: ["/tmp/x/harness/deploy/unraid/ouro-host-lock.mjs", "hold", "--holder", "eval:c16-interviews", "--ttl", "21600", "--wait", "1800"],
  })
  expect(sandbox.remoteRunCase).toHaveBeenCalledWith(expect.objectContaining({ paths: expect.objectContaining({ hostLockToken: "t0k" }) }))
  expect(runner.parse).toHaveBeenCalledWith([])
  expect(lock.release).toHaveBeenCalledTimes(1)
})

it("releases the host lock when the interviews fail", async () => {
  lock.holdHostLock.mockResolvedValue({ token: "t0k", release: lock.release })
  runner.run.mockRejectedValue(new Error("session X-pilot has already started"))
  expect(await run([...REMOTE, "--host-lock", "eval"])).toEqual({ stderr: ["interviews: session X-pilot has already started\n", "code: eval-error\n"], exitCode: 1 })
  expect(lock.release).toHaveBeenCalledTimes(1)
})

it("runs nothing when the host lock cannot be taken", async () => {
  lock.holdHostLock.mockRejectedValue(new Error("the host lock is held by butler:ship 1.0.0 (on sanctuary) until 2026-11-23T13:00:00.000Z"))
  expect((await run([...REMOTE, "--host-lock", "eval"])).stderr[0]).toBe("interviews: the host lock is held by butler:ship 1.0.0 (on sanctuary) until 2026-11-23T13:00:00.000Z\n")
  expect(runner.run).not.toHaveBeenCalled()
})

it("refuses --host-lock without a remote sandbox, since the lock is the remote host's", async () => {
  expect((await run(["--bundle", "/b", "--host-lock", "eval"])).stderr[0]).toBe("interviews: --host-lock needs --sandbox-ssh\n")
  expect(lock.holdHostLock).not.toHaveBeenCalled()
  expect(runner.run).not.toHaveBeenCalled()
})

it("holds no lock and sends no token without --host-lock", async () => {
  runner.run.mockResolvedValue({ exitCode: 0 })
  expect((await run(REMOTE)).exitCode).toBe(0)
  expect(lock.holdHostLock).not.toHaveBeenCalled()
  expect(sandbox.remoteRunCase).toHaveBeenCalledWith(expect.objectContaining({ paths: expect.not.objectContaining({ hostLockToken: expect.anything() }) }))
})

it("sends the run's named agent images with every job, beside the agent's and household's", async () => {
  runner.run.mockResolvedValue({ exitCode: 0 })
  expect((await run([...REMOTE, "--images", "ouro-eval-a:1,ouro-eval-h:1,arm-a=ouro-eval-arm-a:1"])).exitCode).toBe(0)
  expect(sandbox.remoteRunCase).toHaveBeenCalledWith(expect.objectContaining({
    paths: expect.objectContaining({ images: { agent: "ouro-eval-a:1", household: "ouro-eval-h:1", named: { "arm-a": "ouro-eval-arm-a:1" } } }),
  }))
  // The runner is told which images the run names, so a kit that needs another refuses before any session; H is registered.
  expect(runner.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentImages: ["arm-a"], kits: expect.objectContaining({ H: expect.objectContaining({ images: ["codex", "openhands"] }) }) }))
  runner.run.mockClear()
  vi.resetModules()
  await run(REMOTE)
  expect(runner.run).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentImages: [] }))
})

it("refuses a --host-lock with no holder, or one that isn't a single safe word, before taking anything", async () => {
  for (const flags of [[...REMOTE, "--host-lock"], [...REMOTE, "--host-lock", "--reduced"], [...REMOTE, "--host-lock", "eval; rm -rf /"], [...REMOTE, "--host-lock", "butler:ship"]]) {
    vi.resetModules()
    expect((await run(flags)).stderr[0]).toMatch(/^interviews: --host-lock (needs a holder|takes one word)/)
  }
  expect(lock.holdHostLock).not.toHaveBeenCalled()
  expect(runner.run).not.toHaveBeenCalled()
})

it("stops before marking another session started once a job finds the host lock gone", async () => {
  lock.holdHostLock.mockResolvedValue({ token: "t0k", release: lock.release })
  const lost = new Error("refusing to run the eval sandbox on this host: it runs the live Butler (ouro-butler), and no host lock that the Butler's upgrade and rollback honour is held")
  sandbox.remoteRunCase.mockReturnValue(async () => { throw lost })
  runner.run.mockImplementation(async (_args: unknown, deps: { runCase(input: unknown): Promise<unknown>; started: { add(id: string): void } }) => {
    await expect(deps.runCase({})).rejects.toBe(lost)
    // A version 2 session's started key; the message names the id --session takes.
    deps.started.add("v2/X-1")
    return { exitCode: 0 }
  })
  expect((await run([...REMOTE, "--host-lock", "eval"])).stderr).toEqual(["interviews: the host lock was lost, so session X-1 was not started; name it and the later sessions with --session to run them under a new lock\n", "code: eval-error\n"])
  expect(lock.release).toHaveBeenCalledTimes(1)
})
