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
