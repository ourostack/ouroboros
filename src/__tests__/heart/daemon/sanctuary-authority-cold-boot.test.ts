import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { expect, it, vi } from "vitest"
import { startTelegramSenseApp } from "../../../senses/telegram"
import { openSanctuaryResidentAuthority } from "../../../senses/sanctuary-authority-resident"
import { FileSanctuaryTelegramAuthorityGateway, sanctuaryAuthorityPublicKeyDigest } from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import { createSanctuaryTelegramAuthorityServer, SanctuaryTelegramAuthorityService } from "../../../heart/daemon/sanctuary-telegram-authority-service"

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))
vi.mock("../../../heart/runtime-credentials", async (original) => ({
  ...await original<typeof import("../../../heart/runtime-credentials")>(),
  readRuntimeCredentialConfig: () => ({ ok: true, config: {} }),
  readMachineRuntimeCredentialConfig: () => ({ ok: true, config: {} }),
}))

it("proves two cold boots with absent pins, absent gateway, then root-only Telegram recovery over the real socket", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scb-")))
  const socketRoot = path.join(root, "run")
  fs.mkdirSync(socketRoot, { mode: 0o750 })
  const keys = generateKeyPairSync("ed25519")
  const identity = { targetHost: "sanctuary", botId: "123", ownerUserId: "42", ownerChatId: "42", keyId: "cold-boot", publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey) }
  const pins = { schemaVersion: 1, ...identity, publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }
  const configPath = path.join(socketRoot, "resident.json")
  const options = { configPath, expectedUid: process.getuid!(), expectedGid: process.getgid!() }
  const poll = { offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"] }
  const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("resident direct Telegram is forbidden"))
  try {
    for (let cycle = 0; cycle < 2; cycle++) {
      const lstat = fs.lstatSync
      const absent = vi.spyOn(fs, "lstatSync").mockImplementation(((file, settings) => {
        if (file === "/run/ouro-authority") throw Object.assign(new Error("cold boot: pins absent"), { code: "ENOENT" })
        return lstat(file, settings)
      }) as typeof fs.lstatSync)
      await expect(startTelegramSenseApp("sanctuary")).rejects.toThrow("cold boot: pins absent")
      absent.mockRestore()
      expect(() => openSanctuaryResidentAuthority({}, {}, options)).toThrow()
      fs.writeFileSync(configPath, JSON.stringify(pins), { mode: 0o640 })
      const early = openSanctuaryResidentAuthority({}, {}, options)
      await expect(early.authorityTransport.api.request("getUpdates", poll)).rejects.toThrow(/ENOENT/u)
      early.authorityTransport.api.stop()
      expect(network).not.toHaveBeenCalled()
      const api = { request: vi.fn(async () => []), stop: vi.fn() }
      const gateway = new FileSanctuaryTelegramAuthorityGateway(path.join(root, "agent"), { ...identity, privateKey: keys.privateKey })
      gateway.initializeCursor(0)
      const service = new SanctuaryTelegramAuthorityService({ gateway, api })
      const server = createSanctuaryTelegramAuthorityServer({ socketPath: path.join(socketRoot, "authority.sock"), dispatch: (method, params) => service.dispatch(method, params) })
      await server.listen()
      const recovered = openSanctuaryResidentAuthority({}, {}, options)
      try {
        expect((await recovered.cursorSnapshot()).keyId).toBe("cold-boot")
        expect(api.request).not.toHaveBeenCalled()
        await expect(recovered.authorityTransport.api.request("getUpdates", poll)).resolves.toEqual([])
        expect(api.request).toHaveBeenCalledTimes(1)
        expect(api.request.mock.calls[0]![0]).toBe("getUpdates")
        expect(network).not.toHaveBeenCalled()
      } finally {
        recovered.authorityTransport.api.stop()
        await server.close()
      }
      fs.unlinkSync(configPath)
    }
  } finally {
    vi.restoreAllMocks()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
