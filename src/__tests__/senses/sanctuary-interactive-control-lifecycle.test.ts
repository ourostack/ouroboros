import * as fs from "node:fs"
import * as net from "node:net"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("node:net", async (importActual) => ({ ...await importActual<typeof import("node:net")>() }))
vi.mock("node:fs", async (importActual) => ({ ...await importActual<typeof import("node:fs")>() }))

import { createSanctuaryInteractiveControl, sanctuaryInteractiveControlReady } from "../../senses/sanctuary-interactive-control"
import { createTelegramSenseApp } from "../../senses/telegram"
import { FileTelegramEffectJournal } from "../../senses/telegram-effect-adapter"
import type { TelegramApprovalTransport } from "../../senses/telegram-client"

type Control = ReturnType<typeof createSanctuaryInteractiveControl>
const roots: string[] = []
const controls: Control[] = []

function root(): string {
  const directory = fs.mkdtempSync("/tmp/d007-")
  roots.push(directory)
  return directory
}

function transport(): TelegramApprovalTransport {
  const unused = vi.fn(async (): Promise<never> => { throw new Error("unexpected approval effect") })
  return {
    sendApproval: unused, handleUpdate: unused, recoverDecisionAttempt: unused,
    reconcileExpired: vi.fn(async () => undefined), terminalizeOrphaned: unused,
    terminalizeRecovered: unused, listPendingDeliveries: () => [], validatePendingTerminalControl: unused,
  }
}

function control(agentRoot: string): Control {
  const instance = createSanctuaryInteractiveControl({ agentRoot, transport: transport(), authorizedUserId: "42", authorizedChatId: "42" })
  controls.push(instance)
  return instance
}

function identity(socketPath: string) {
  const stat = fs.lstatSync(socketPath, { bigint: true })
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode, ctimeNs: stat.ctimeNs }
}

function staleSocket(socketPath: string): void {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  const child = spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen(process.argv[1], () => process.exit(0))", socketPath], { encoding: "utf8", timeout: 5_000 })
  expect(child.error).toBeUndefined()
  expect(child.status).toBe(0)
  expect(fs.lstatSync(socketPath).isSocket()).toBe(true)
}

afterEach(async () => {
  vi.restoreAllMocks()
  // Release the most recent pathname owner before retrying an older refused owner.
  for (const instance of controls.splice(0).reverse()) await instance.stop()
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("D-007 native endpoint ownership", () => {
  it("never lets a never-started sibling dispose the resident endpoint", async () => {
    const directory = root()
    const resident = control(directory)
    const sibling = control(directory)
    await resident.start()
    const before = identity(resident.socketPath)
    await sibling.stop()
    expect(identity(resident.socketPath)).toEqual(before)
    expect(await sanctuaryInteractiveControlReady(resident.socketPath)).toBe(true)
  })

  it("refuses another live listener on start without changing its identity", async () => {
    const directory = root()
    const resident = control(directory)
    const sibling = control(directory)
    await resident.start()
    const before = identity(resident.socketPath)
    await expect(sibling.start()).rejects.toThrow()
    expect(identity(resident.socketPath)).toEqual(before)
    expect(await sanctuaryInteractiveControlReady(resident.socketPath)).toBe(true)
  })

  it("checks ownership before native close and retries the same owner after release", async () => {
    const directory = root()
    const first = control(directory)
    const replacement = control(directory)
    await first.start()
    fs.unlinkSync(first.socketPath)
    await replacement.start()
    const before = identity(replacement.socketPath)
    await expect(first.stop()).rejects.toThrow(/ownership|another|replaced/i)
    expect(identity(replacement.socketPath)).toEqual(before)
    expect(await sanctuaryInteractiveControlReady(replacement.socketPath)).toBe(true)
    await replacement.stop()
    await first.stop()
    await first.start()
    expect(await sanctuaryInteractiveControlReady(first.socketPath)).toBe(true)
    await first.stop()
    expect(fs.existsSync(first.socketPath)).toBe(false)
  })

  it("does not unlink a new owner on an old instance's repeated completed stop", async () => {
    const directory = root()
    const first = control(directory)
    const second = control(directory)
    await first.start()
    await first.stop()
    await second.start()
    const before = identity(second.socketPath)
    await first.stop()
    expect(identity(second.socketPath)).toEqual(before)
    expect(await sanctuaryInteractiveControlReady(second.socketPath)).toBe(true)
  })

  it.each(["file", "directory", "symlink", "dangling-symlink"] as const)("refuses a %s without reclaiming it", async (kind) => {
    const instance = control(root())
    fs.mkdirSync(path.dirname(instance.socketPath), { recursive: true })
    const target = path.join(path.dirname(instance.socketPath), "target")
    if (kind === "file") fs.writeFileSync(instance.socketPath, "foreign")
    if (kind === "directory") fs.mkdirSync(instance.socketPath)
    if (kind === "symlink") fs.writeFileSync(target, "foreign target")
    if (kind === "symlink" || kind === "dangling-symlink") fs.symlinkSync(target, instance.socketPath)
    const before = identity(instance.socketPath)
    try {
      await expect(instance.start()).rejects.toThrow()
      expect(identity(instance.socketPath)).toEqual(before)
      if (kind === "symlink") expect(fs.readFileSync(target, "utf8")).toBe("foreign target")
    } finally {
      if (kind === "directory") fs.rmdirSync(instance.socketPath)
      else if (fs.lstatSync(instance.socketPath, { throwIfNoEntry: false })) fs.unlinkSync(instance.socketPath)
    }
  })

  it("reclaims a real refused stale socket and supports two owning cycles", async () => {
    const instance = control(root())
    staleSocket(instance.socketPath)
    expect(await sanctuaryInteractiveControlReady(instance.socketPath)).toBe(false)
    for (let cycle = 0; cycle < 2; cycle += 1) {
      await instance.start()
      expect(fs.lstatSync(instance.socketPath).mode & 0o777).toBe(0o600)
      expect(await sanctuaryInteractiveControlReady(instance.socketPath)).toBe(true)
      await instance.stop()
      expect(fs.existsSync(instance.socketPath)).toBe(false)
    }
  })

  it("refuses a changed stale identity after the connect result", async () => {
    const instance = control(root())
    staleSocket(instance.socketPath)
    const connect = net.createConnection
    vi.spyOn(net, "createConnection").mockImplementationOnce((...args) => {
      const socket = Reflect.apply(connect, net, args)
      socket.prependOnceListener("error", () => {
        fs.unlinkSync(instance.socketPath)
        fs.writeFileSync(instance.socketPath, "replacement")
      })
      return socket
    })
    try {
      await expect(instance.start()).rejects.toThrow()
      expect(fs.readFileSync(instance.socketPath, "utf8")).toBe("replacement")
    } finally {
      vi.restoreAllMocks()
      if (fs.lstatSync(instance.socketPath, { throwIfNoEntry: false })) fs.unlinkSync(instance.socketPath)
    }
  })

  it.each(["EACCES", "EIO", "timeout"])("does not treat %s as proof of staleness", async (failure) => {
    const instance = control(root())
    staleSocket(instance.socketPath)
    const before = identity(instance.socketPath)
    const socket = new net.Socket()
    vi.spyOn(net, "createConnection").mockImplementationOnce(() => {
      queueMicrotask(() => socket.emit(failure === "timeout" ? "timeout" : "error", Object.assign(new Error(failure), { code: failure })))
      return socket
    })
    try {
      await expect(instance.start()).rejects.toThrow()
      expect(identity(instance.socketPath)).toEqual(before)
      expect(socket.destroyed).toBe(true)
    } finally {
      socket.destroy()
      vi.restoreAllMocks()
    }
  })

  it("resets a real failed listen and retries without removing the intervening file", async () => {
    const instance = control(root())
    const createServer = net.createServer
    vi.spyOn(net, "createServer").mockImplementationOnce((...args) => {
      const server = Reflect.apply(createServer, net, args)
      server.once("newListener", () => fs.writeFileSync(instance.socketPath, "intervening file"))
      return server
    })
    await expect(instance.start()).rejects.toThrow()
    expect(fs.readFileSync(instance.socketPath, "utf8")).toBe("intervening file")
    fs.unlinkSync(instance.socketPath)
    await instance.start()
    expect(await sanctuaryInteractiveControlReady(instance.socketPath)).toBe(true)
  })

  it("follows the real startup result when stop overlaps start", async () => {
    const instance = control(root())
    const starting = instance.start()
    const stopping = instance.stop()
    await Promise.all([starting, stopping])
    expect(fs.existsSync(instance.socketPath)).toBe(false)
    await instance.start()
    expect(await sanctuaryInteractiveControlReady(instance.socketPath)).toBe(true)
  })

  it("single-flights concurrent starts and queues a new start behind an unfinished close", async () => {
    const instance = control(root())
    const starting = instance.start()
    expect(instance.start()).toBe(starting)
    await starting
    const connection = net.createConnection(instance.socketPath)
    await new Promise<void>((resolve, reject) => { connection.once("connect", resolve); connection.once("error", reject) })
    const closing = instance.stop()
    const restarting = instance.start()
    connection.destroy()
    await Promise.all([closing, restarting])
    expect(await sanctuaryInteractiveControlReady(instance.socketPath)).toBe(true)
  })

  it("does not claim or close an endpoint replaced before the listening callback", async () => {
    const directory = root()
    const first = control(directory)
    const replacement = control(directory)
    const starting = first.start()
    fs.unlinkSync(first.socketPath)
    const replacementStarting = replacement.start()
    await expect(starting).rejects.toThrow(/ownership|another|replaced/i)
    await replacementStarting
    expect(await sanctuaryInteractiveControlReady(replacement.socketPath)).toBe(true)
    await replacement.stop()
    await first.stop()
  })

  it("surfaces a startup permission failure, cleans its own listener and retries", async () => {
    const instance = control(root())
    vi.spyOn(fs, "chmodSync").mockImplementationOnce(() => { throw new Error("permission fixture") })
    await expect(instance.start()).rejects.toThrow("permission fixture")
    expect(fs.existsSync(instance.socketPath)).toBe(false)
    await instance.start()
    expect(await sanctuaryInteractiveControlReady(instance.socketPath)).toBe(true)
  })

  it("also reports startup failure to an overlapping stop without leaving a late listener", async () => {
    const instance = control(root())
    vi.spyOn(fs, "chmodSync").mockImplementationOnce(() => { throw new Error("overlapping permission fixture") })
    const starting = instance.start()
    const stopping = instance.stop()
    const outcomes = await Promise.allSettled([starting, stopping])
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"])
    expect(fs.existsSync(instance.socketPath)).toBe(false)
    await instance.start()
    expect(await sanctuaryInteractiveControlReady(instance.socketPath)).toBe(true)
  })

  it("retains ownership after a failed native close and retries that listener", async () => {
    const instance = control(root())
    await instance.start()
    const before = identity(instance.socketPath)
    let nativeServer: net.Server | undefined
    vi.spyOn(net.Server.prototype, "close").mockImplementationOnce(function (this: net.Server, callback) {
      nativeServer = this
      queueMicrotask(() => callback?.(new Error("native close fixture")))
      return this
    })
    try {
      await expect(instance.stop()).rejects.toThrow("native close fixture")
      expect(identity(instance.socketPath)).toEqual(before)
      expect(await sanctuaryInteractiveControlReady(instance.socketPath)).toBe(true)
      await instance.stop()
      expect(fs.existsSync(instance.socketPath)).toBe(false)
    } finally {
      vi.restoreAllMocks()
      if (nativeServer?.listening) await new Promise<void>((resolve, reject) => nativeServer!.close((error) => error ? reject(error) : resolve()))
    }
  })

  it("does not delete a replacement created while its native close is completing", async () => {
    const directory = root()
    const first = control(directory)
    const replacement = control(directory)
    await first.start()
    const connection = net.createConnection(first.socketPath)
    await new Promise<void>((resolve, reject) => { connection.once("connect", resolve); connection.once("error", reject) })
    const closing = first.stop()
    try {
      await vi.waitFor(() => expect(fs.existsSync(first.socketPath)).toBe(false))
      await replacement.start()
      const before = identity(replacement.socketPath)
      connection.destroy()
      await closing
      expect(identity(replacement.socketPath)).toEqual(before)
      expect(await sanctuaryInteractiveControlReady(replacement.socketPath)).toBe(true)
    } finally { connection.destroy(); await closing }
  })
})

describe("D-007 same-public-app cleanup", () => {
  function app(directory: string) {
    fs.mkdirSync(path.join(directory, "state", "telegram", "effects"), { recursive: true })
    let finishPolling!: () => void
    let observedPolling!: () => void
    const polling = new Promise<void>((resolve) => { observedPolling = resolve })
    const stopped = new Promise<void>((resolve) => { finishPolling = resolve })
    const poll = { pollOnce: vi.fn(async () => 0), run: vi.fn(async () => { observedPolling(); await stopped }), stop: vi.fn(() => finishPolling()) }
    const api = { request: vi.fn(async (): Promise<never> => { throw new Error("unexpected external send") }), stop: vi.fn() }
    const instance = createTelegramSenseApp({
      agentName: "sanctuary", _agentRoot: directory, _toolContext: {},
      credentials: { botToken: "777:fixture", botId: "777", authorizedUserId: "42", authorizedChatId: "42" },
      identityKey: "k".repeat(43), api, createLongPoll: () => poll,
      migrateIdentity: async () => undefined, acceptanceMarker: () => null,
    })
    return { instance, api, poll, polling }
  }

  it("does not let a real send-only app's disposal remove the resident listener", async () => {
    const directory = root()
    const resident = control(directory)
    await resident.start()
    const before = identity(resident.socketPath)
    const sender = app(directory)
    await sender.instance.stop()
    expect(identity(resident.socketPath)).toEqual(before)
    expect(await sanctuaryInteractiveControlReady(resident.socketPath)).toBe(true)
    expect(sender.api.request).not.toHaveBeenCalled()
    expect(sender.poll.run).not.toHaveBeenCalled()
  })

  it("retries rejected stop on the same app, single-flights calls and does not re-close dependencies", async () => {
    const directory = root()
    const owner = app(directory)
    const nativeServers: net.Server[] = []
    const createServer = net.createServer
    vi.spyOn(net, "createServer").mockImplementation((...args) => {
      const server = Reflect.apply(createServer, net, args)
      nativeServers.push(server)
      return server
    })
    const running = owner.instance.run()
    const observedRun = running.catch((error: unknown) => error)
    await owner.polling
    const replacement = control(directory)
    fs.unlinkSync(replacement.socketPath)
    await replacement.start()
    const before = identity(replacement.socketPath)
    const closeJournal = vi.spyOn(FileTelegramEffectJournal.prototype, "close")
    try {
      const firstStop = owner.instance.stop()
      expect(owner.instance.stop()).toBe(firstStop)
      await expect(firstStop).rejects.toThrow(/ownership|another|replaced/i)
      expect(identity(replacement.socketPath)).toEqual(before)
      expect(nativeServers[0]!.listening).toBe(true)
      expect(await sanctuaryInteractiveControlReady(replacement.socketPath)).toBe(true)
      await replacement.stop()
      const retry = owner.instance.stop()
      expect(owner.instance.stop()).toBe(retry)
      await expect(retry).resolves.toBeUndefined()
      expect(nativeServers[0]!.listening).toBe(false)
      expect(owner.instance.stop()).toBe(retry)
      expect(closeJournal).toHaveBeenCalledTimes(1)
      expect(owner.poll.stop).toHaveBeenCalledTimes(1)
      expect(owner.api.stop).toHaveBeenCalledTimes(1)
      expect(owner.api.request).not.toHaveBeenCalled()
    } finally {
      await replacement.stop()
      await owner.instance.stop()
      await observedRun
    }
  })

  it("retains aggregated cleanup failures and retries only the unfinished dependencies", async () => {
    const owner = app(root())
    const running = owner.instance.run()
    await owner.polling
    const apiError = new Error("API cleanup fixture")
    const journalError = new Error("journal cleanup fixture")
    owner.api.stop.mockImplementationOnce(() => { throw apiError })
    const closeJournal = vi.spyOn(FileTelegramEffectJournal.prototype, "close").mockImplementationOnce(() => { throw journalError })
    try {
      const firstStop = owner.instance.stop()
      expect(owner.instance.stop()).toBe(firstStop)
      await expect(firstStop).rejects.toMatchObject({ message: "Telegram sense cleanup failed", errors: [apiError, journalError] })
      await expect(owner.instance.stop()).resolves.toBeUndefined()
      await owner.instance.stop()
      expect(owner.api.stop).toHaveBeenCalledTimes(2)
      expect(closeJournal).toHaveBeenCalledTimes(2)
      expect(owner.poll.stop).toHaveBeenCalledTimes(1)
      expect(owner.api.request).not.toHaveBeenCalled()
    } finally {
      vi.restoreAllMocks()
      await owner.instance.stop()
      await running
    }
  })
})
