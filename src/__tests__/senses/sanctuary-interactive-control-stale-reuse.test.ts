import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { expect, it, vi } from "vitest"
import { createSanctuaryInteractiveControl } from "../../senses/sanctuary-interactive-control"

vi.mock("node:fs", async (importActual) => ({ ...await importActual<typeof import("node:fs")>() }))
vi.mock("node:net", async (importActual) => ({ ...await importActual<typeof import("node:net")>() }))

it("refuses changed stale metadata when creation time is unavailable and inode values are reused", async () => {
  const agentRoot = fs.mkdtempSync("/tmp/d007-stale-")
  const control = createSanctuaryInteractiveControl({
    agentRoot, authorizedUserId: "42", authorizedChatId: "42",
    transport: { handleUpdate: vi.fn(), listPendingDeliveries: () => [] } as never,
  })
  fs.mkdirSync(path.dirname(control.socketPath), { recursive: true })
  const child = spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", control.socketPath], { timeout: 5_000 })
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  const lstat = fs.lstatSync
  const stale = lstat(control.socketPath, { bigint: true })
  let replacementIdentity: fs.BigIntStats | undefined
  let replacement: net.Server | undefined
  const connect = net.createConnection
  vi.spyOn(net, "createConnection").mockImplementationOnce((...args) => {
    const socket = Reflect.apply(connect, net, args)
    socket.prependOnceListener("error", () => {
      fs.unlinkSync(control.socketPath)
      replacement = net.createServer((connection) => connection.end("replacement"))
      replacement.listen(control.socketPath)
      replacementIdentity = lstat(control.socketPath, { bigint: true })
      expect(replacementIdentity.ctimeNs).not.toBe(stale.ctimeNs)
    })
    return socket
  })
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const current = Reflect.apply(lstat, fs, args)
    if (String(args[0]) === control.socketPath && current) Object.assign(current, { dev: stale.dev, ino: stale.ino, birthtimeNs: 0n })
    return current
  })
  try {
    await expect(control.start()).rejects.toThrow(/replaced.*ownership probe/)
    expect(replacement?.listening).toBe(true)
    expect(lstat(control.socketPath, { bigint: true })).toEqual(replacementIdentity)
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(control.socketPath)
      let text = ""
      socket.setEncoding("utf8")
      socket.on("data", (chunk) => { text += chunk })
      socket.on("error", reject)
      socket.on("end", () => resolve(text))
    })
    expect(reply).toBe("replacement")
  } finally {
    await control.stop()
    vi.restoreAllMocks()
    if (replacement?.listening) await new Promise<void>((resolve, reject) => replacement!.close((error) => error ? reject(error) : resolve()))
    fs.rmSync(agentRoot, { recursive: true, force: true })
  }
})
