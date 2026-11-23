// `node dist/eval/run-entry.js` ends a failure with the `code: <code>` line its Ouro AX card names
// (cli-commands/entry-points.ts), and sets process.exitCode rather than calling process.exit, which can drop the line
// on a pipe.
import { afterEach, expect, it, vi } from "vitest"

const command = vi.hoisted(() => ({ parse: vi.fn(), run: vi.fn() }))
vi.mock("../../eval/run-command", () => ({ parseEvalArgs: command.parse, runEvalCommand: command.run }))
vi.mock("../../eval/targets", () => ({ resolveTarget: vi.fn() }))
vi.mock("../../eval/report", () => ({ writePrivateReport: vi.fn() }))
const sandbox = vi.hoisted(() => ({ runSandboxed: vi.fn(), dockerOracle: vi.fn(), remoteRunCase: vi.fn() }))
vi.mock("../../eval/sandbox/docker", () => ({ dockerCli: vi.fn(), HOUSEHOLD_IMAGE: "household", runSandboxed: sandbox.runSandboxed }))
vi.mock("../../eval/sandbox/oracle", () => ({ dockerOracle: sandbox.dockerOracle }))
vi.mock("../../eval/sandbox/remote", () => ({ remoteRunCase: sandbox.remoteRunCase, sshStart: vi.fn() }))

const previous = process.exitCode
afterEach(() => { process.exitCode = previous; vi.resetModules(); vi.restoreAllMocks() })

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
