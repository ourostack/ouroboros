import * as path from "node:path"
import { pathToFileURL } from "node:url"
import * as fs from "node:fs"
import { afterEach, expect, it, vi } from "vitest"

const argv = process.argv
const exitCode = process.exitCode
vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))
afterEach(() => { process.argv = argv; process.exitCode = exitCode; vi.restoreAllMocks(); vi.resetModules() })

it.each([
  ["sanctuary-authority-root-lifecycle", "Sanctuary root lifecycle failed; inspect the root transaction and repair its failed boundary.\n"],
  ["sanctuary-telegram-authority-entry", "Sanctuary Telegram authority requires --config\n"],
])("runs the canonical %s executable and does not expose private failure details", async (name, message) => {
  const source = path.resolve(`src/heart/daemon/${name}.ts`)
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true)
  vi.spyOn(process, "getuid").mockReturnValue(10001)
  process.argv = [process.execPath, source]
  await import(pathToFileURL(source).href)
  await vi.waitFor(() => expect(output).toHaveBeenCalledWith(message))
  expect(process.exitCode).toBe(1)
  process.argv = [process.execPath]
  vi.resetModules()
  await import(pathToFileURL(source).href)
  expect(output).toHaveBeenCalledOnce()
  process.argv = [process.execPath, "/not-an-entrypoint-fixture"]
  vi.resetModules()
  await expect(import(pathToFileURL(source).href)).resolves.toBeDefined()
  expect(output).toHaveBeenCalledOnce()
})

it("keeps non-Error executable failures private", async () => {
  const source = path.resolve("src/heart/daemon/sanctuary-telegram-authority-entry.ts")
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true)
  vi.spyOn(process, "getuid").mockReturnValue(0)
  const open = fs.openSync
  vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
    if (file === "/fixture/private-config") throw "private failure"
    return open(file, flags, mode)
  })
  process.argv = [process.execPath, source, "--config", "/fixture/private-config"]
  await import(pathToFileURL(source).href)
  await vi.waitFor(() => expect(output).toHaveBeenCalledWith("Sanctuary Telegram authority failed\n"))
})

it("dispatches the standalone DockerMan executable through the same strict CLI", async () => {
  const source = path.resolve("deploy/unraid/docker-man-template-transaction.mjs")
  process.argv = [process.execPath, source]
  await expect(import(pathToFileURL(source).href)).rejects.toThrow(/Usage: docker-man-template-transaction/u)
})
