import { describe, expect, it } from "vitest"
import { runCommand } from "../../../senses/app-sessions/run-command"

describe("runCommand", () => {
  it("runs an argv with no shell and returns what it printed", async () => {
    expect(await runCommand([process.execPath, "-e", "process.stdout.write('$HOME;ok')"], 10_000)).toEqual({ ok: true, stdout: "$HOME;ok", error: null })
  })

  it("names a non-zero exit by its program and first stderr line, a missing program and a timeout", async () => {
    const failed = await runCommand([process.execPath, "-e", "console.error('first\\nsecond'); process.exit(3)"], 10_000)
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/^node failed: first$/) })
    const silent = await runCommand([process.execPath, "-e", "process.exit(2)"], 10_000)
    expect(silent.error).toMatch(/^node failed: Command failed/)
    expect((await runCommand(["/nonexistent/program"], 10_000)).error).toMatch(/^program failed: .*ENOENT/)
    expect((await runCommand([process.execPath, "-e", "setTimeout(() => {}, 5000)"], 100)).ok).toBe(false)
  })
})
