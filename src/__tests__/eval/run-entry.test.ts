// `node dist/eval/run-entry.js` ends a failure with the `code: <code>` line its Ouro AX card names
// (cli-commands/entry-points.ts), and sets process.exitCode rather than calling process.exit, which can drop the line
// on a pipe.
import { afterEach, expect, it, vi } from "vitest"

const command = vi.hoisted(() => ({ parse: vi.fn(), run: vi.fn() }))
vi.mock("../../eval/run-command", () => ({ parseEvalArgs: command.parse, runEvalCommand: command.run }))
vi.mock("../../eval/targets", () => ({ resolveTarget: vi.fn() }))
vi.mock("../../eval/report", () => ({ writePrivateReport: vi.fn() }))
const sandbox = vi.hoisted(() => ({ runSandboxed: vi.fn(), dockerOracle: vi.fn(), remoteRunCase: vi.fn(), sshNode: vi.fn((host: string, args: string[]) => ({ host, args })) }))
vi.mock("../../eval/sandbox/docker", () => ({ dockerCli: vi.fn(), HOUSEHOLD_IMAGE: "household", runSandboxed: sandbox.runSandboxed }))
vi.mock("../../eval/sandbox/oracle", () => ({ dockerOracle: sandbox.dockerOracle }))
vi.mock("../../eval/sandbox/remote", () => ({ remoteRunCase: sandbox.remoteRunCase, sshStart: vi.fn(), sshNode: sandbox.sshNode }))
const lock = vi.hoisted(() => ({ holdHostLock: vi.fn(), release: vi.fn() }))
vi.mock("../../eval/sandbox/host-lock", () => ({ holdHostLock: lock.holdHostLock, HOST_LOCK_TTL_S: 21600, HOST_LOCK_WAIT_S: 1800 }))

const previous = process.exitCode
afterEach(() => { process.exitCode = previous; vi.resetModules(); vi.restoreAllMocks(); lock.release.mockClear(); lock.holdHostLock.mockReset() })

async function run(): Promise<{ stderr: string[]; exitCode: typeof process.exitCode }> {
  const stderr: string[] = []
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => { stderr.push(String(chunk)); return true }) as typeof process.stderr.write)
  const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("process.exit called") }) as typeof process.exit)
  process.exitCode = undefined
  await import("../../eval/run-entry")
  await vi.waitFor(() => expect(process.exitCode).toBeDefined())
  expect(exit).not.toHaveBeenCalled()
  return { stderr, exitCode: process.exitCode }
}

it("exits 0 with no code line when every run ran", async () => {
  command.parse.mockReturnValue({})
  command.run.mockResolvedValue({ exitCode: 0 })
  expect(await run()).toEqual({ stderr: [], exitCode: 0 })
})

it("names a run the budget or the provider stopped", async () => {
  command.parse.mockReturnValue({})
  command.run.mockResolvedValue({ exitCode: 2 })
  expect(await run()).toEqual({ stderr: ["code: budget-stopped\n"], exitCode: 2 })
})

it("names a refusal or a failure, after the reason", async () => {
  command.parse.mockReturnValue({})
  command.run.mockRejectedValue(new Error("--runs is required"))
  expect(await run()).toEqual({ stderr: ["eval: --runs is required\n", "code: eval-error\n"], exitCode: 1 })
})

const images = { agent: "ouro-eval-c17-sandbox:local", household: "ouro-eval-c17-household:local" }
async function runCaseFor(args: Record<string, unknown>): Promise<(input: any) => unknown> {
  command.parse.mockReturnValue(args)
  let made: ((input: any) => unknown) | undefined
  command.run.mockImplementation(async (parsed: any, deps: any) => { made = deps.runCase(parsed); return { exitCode: 0 } })
  await run()
  return made!
}

it("sends the run's own image tags to the remote host", async () => {
  await runCaseFor({ sandboxSsh: "sanctuary:/tmp/x", bundle: "/tmp/x/bundle", oracleBooks: "/tmp/x/books", sandboxImages: images })
  expect(sandbox.remoteRunCase).toHaveBeenCalledWith(expect.objectContaining({ paths: expect.objectContaining({ images, oracleBooks: "/tmp/x/books" }) }))
})

it("runs a local sandbox and its books oracle in the run's own images", async () => {
  const runCase = await runCaseFor({ bundle: "/b", oracleBooks: "/books", sandboxImages: images })
  sandbox.dockerOracle.mockReturnValue("oracle")
  expect(sandbox.dockerOracle).toHaveBeenCalledWith(expect.objectContaining({ image: images.household, booksLib: "/books" }))
  await runCase({ case: { id: "c" }, host: {}, budget: {} })
  expect(sandbox.runSandboxed).toHaveBeenCalledWith(expect.objectContaining({ images, bundleDir: "/b" }))
})

it("holds the remote host's lock for the whole command, sends its token with every job, and releases it after", async () => {
  lock.holdHostLock.mockResolvedValue({ token: "t0k", release: lock.release })
  await runCaseFor({ sandboxSsh: "sanctuary:/tmp/x", bundle: "/tmp/x/bundle", hostLock: "eval c17 replay" })
  expect(lock.holdHostLock).toHaveBeenCalledWith({
    host: "sanctuary",
    args: ["/tmp/x/harness/deploy/unraid/ouro-host-lock.mjs", "hold", "--holder", "eval c17 replay", "--ttl", "21600", "--wait", "1800"],
  })
  expect(sandbox.remoteRunCase).toHaveBeenCalledWith(expect.objectContaining({ paths: expect.objectContaining({ hostLockToken: "t0k" }) }))
  expect(lock.release).toHaveBeenCalledTimes(1)
})

it("releases the host lock when the command fails", async () => {
  lock.holdHostLock.mockResolvedValue({ token: "t0k", release: lock.release })
  command.parse.mockReturnValue({ sandboxSsh: "sanctuary:/tmp/x", hostLock: "eval" })
  command.run.mockRejectedValue(new Error("the provider broke"))
  expect((await run()).exitCode).toBe(1)
  expect(lock.release).toHaveBeenCalledTimes(1)
})

it("runs nothing when the host lock cannot be taken", async () => {
  command.parse.mockReturnValue({ sandboxSsh: "sanctuary:/tmp/x", hostLock: "eval" })
  lock.holdHostLock.mockRejectedValue(new Error("the host lock is held by butler:ship 1.0.0 (on sanctuary) until 2026-11-23T13:00:00.000Z"))
  command.run.mockClear()
  expect((await run()).stderr).toContain("eval: the host lock is held by butler:ship 1.0.0 (on sanctuary) until 2026-11-23T13:00:00.000Z\n")
  expect(command.run).not.toHaveBeenCalled()
})
