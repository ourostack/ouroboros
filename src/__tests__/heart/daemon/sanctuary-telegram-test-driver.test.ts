import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  FileSanctuaryTelegramAuthorityGateway,
  sanctuaryAuthorityPublicKeyDigest,
} from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import {
  FileSanctuaryTelegramTestLog,
  runSanctuaryTelegramTestDriver,
  sanctuaryTelegramOutboundEntry,
  sanctuaryTelegramTestLogRoot,
  type SanctuaryTelegramTestDriverDependencies,
} from "../../../heart/daemon/sanctuary-telegram-test-driver"
import { runSanctuaryTelegramTestDriverCli } from "../../../heart/daemon/sanctuary-telegram-test-driver-entry"
import { authorityArtifactDigest } from "../../../heart/daemon/sanctuary-authority-codec"
import { TELEGRAM_TEST_ID_FLOOR } from "../../../senses/telegram-client"

const roots: string[] = []

function root(): string {
  const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "stt-")))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

function fixture() {
  const agentRoot = root()
  const keys = generateKeyPairSync("ed25519")
  const gateway = new FileSanctuaryTelegramAuthorityGateway(agentRoot, {
    targetHost: "sanctuary", botId: "123456", ownerUserId: "42", ownerChatId: "42", keyId: "issuer-1",
    publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey), privateKey: keys.privateKey,
  })
  let clock = Date.parse("2026-11-15T12:00:00.000Z")
  const log = new FileSanctuaryTelegramTestLog(sanctuaryTelegramTestLogRoot(agentRoot), () => clock)
  const output: string[] = []
  const echo = vi.fn(async () => ({ message_id: 1 }))
  const deps: SanctuaryTelegramTestDriverDependencies = {
    gateway, log, botId: "123456", ownerUserId: "42", ownerChatId: "42", echo,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds },
    write: (text) => { output.push(text) },
  }
  return { agentRoot, gateway, log, deps, echo, output, advance: (ms: number) => { clock += ms } }
}

/** Plays the resident: settles the pending test update and, while armed, has the authority log one reply. */
function residentAnswers(f: ReturnType<typeof fixture>, reply: Record<string, unknown>, after = 1) {
  let calls = 0
  const sleep = f.deps.sleep!
  f.deps.sleep = async (milliseconds) => {
    calls += 1
    if (calls === after) {
      const observation = f.gateway.poll()!
      if (f.log.armed()) f.log.append(sanctuaryTelegramOutboundEntry({ method: "sendMessage", body: reply, result: { message_id: 77 }, observationUpdateId: observation.payload.updateId }))
      f.gateway.settle({ updateId: observation.payload.updateId, observationDigest: authorityArtifactDigest(observation.domain, observation.payload), outcome: "completed" })
    }
    await sleep(milliseconds)
  }
}

describe("Sanctuary owner-turn test driver", () => {
  it("injects an owner message, waits for the bot's reply and returns the transcript", async () => {
    const f = fixture()
    residentAnswers(f, { chat_id: "42", text: "Two downloads are running." })
    const transcript = await runSanctuaryTelegramTestDriver(["send", "--text", "[test] what's downloading?", "--quiet", "3"], f.deps) as any
    expect(transcript).toMatchObject({
      updateId: TELEGRAM_TEST_ID_FLOOR, messageId: TELEGRAM_TEST_ID_FLOOR, settlement: "completed", timedOut: false,
      replies: [{ kind: "outbound", method: "sendMessage", text: "Two downloads are running.", messageId: 77, observationUpdateId: TELEGRAM_TEST_ID_FLOOR, testObservation: true }],
    })
    expect(f.echo).toHaveBeenCalledWith("🧪 test driver, owner says: [test] what's downloading?")
    expect(f.gateway.record(TELEGRAM_TEST_ID_FLOOR)!.rawUpdate.message).toMatchObject({ message_id: TELEGRAM_TEST_ID_FLOOR, from: { id: 42 }, chat: { id: 42, type: "private" }, text: "[test] what's downloading?" })
    expect(f.log.read()[0]).toMatchObject({ seq: 1, kind: "injected", command: "send", updateId: TELEGRAM_TEST_ID_FLOOR })
    expect(JSON.parse(f.output.join(""))).toEqual(transcript)
    expect(fs.statSync(path.dirname(f.log.logPath)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(f.log.logPath).mode & 0o777).toBe(0o600)
  })

  it("builds replies, edits, reactions and button taps the way Telegram delivers them", async () => {
    const f = fixture()
    const run = (argv: string[]) => runSanctuaryTelegramTestDriver([...argv, "--no-wait", "--no-echo"], f.deps) as Promise<any>
    await run(["send", "--text", "[test] what was that about?", "--reply-to", "500", "--reply-to-text", "Disk 3 is warm."])
    await run(["send", "--text", "[test] and this?", "--reply-to", "501"])
    await run(["edit", "--message-id", String(TELEGRAM_TEST_ID_FLOOR), "--text", "[test] edited"])
    await run(["react", "--message-id", "500", "--emoji", "❤️"])
    const tap = await run(["tap", "--message-id", "502", "--data", "oua:approve"])
    expect(tap).toEqual({ updateId: TELEGRAM_TEST_ID_FLOOR + 4, seq: 5 })
    expect(f.echo).not.toHaveBeenCalled()
    const raw = (offset: number) => f.gateway.record(TELEGRAM_TEST_ID_FLOOR + offset)!.rawUpdate
    expect(raw(0).message!.reply_to_message).toEqual({ message_id: 500, from: { id: 123456, is_bot: true }, text: "Disk 3 is warm." })
    expect(raw(1).message!.reply_to_message).toEqual({ message_id: 501, from: { id: 123456, is_bot: true } })
    expect(raw(2).edited_message).toMatchObject({ message_id: TELEGRAM_TEST_ID_FLOOR, text: "[test] edited", edit_date: expect.any(Number) })
    expect(raw(3).message_reaction).toMatchObject({ message_id: 500, user: { id: 42 }, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "❤️" }] })
    expect(raw(4).callback_query).toMatchObject({ id: `ouro-test-${TELEGRAM_TEST_ID_FLOOR + 4}`, from: { id: 42 }, message: { message_id: 502, chat: { id: 42 } }, data: "oua:approve" })
    expect(f.gateway.isTestCallbackQuery(`ouro-test-${TELEGRAM_TEST_ID_FLOOR + 4}`)).toBe(true)
  })

  it("echoes each kind of turn so the owner can follow along in the chat", async () => {
    const f = fixture()
    const run = (argv: string[]) => runSanctuaryTelegramTestDriver([...argv, "--no-wait"], f.deps)
    await run(["send", "--text", "[test] hi", "--reply-to", "9"])
    await run(["edit", "--message-id", String(TELEGRAM_TEST_ID_FLOOR), "--text", "[test] hello"])
    await run(["react", "--message-id", "9", "--emoji", "❤️"])
    await run(["tap", "--message-id", "9", "--data", "x"])
    expect(f.echo.mock.calls.map(([text]) => text)).toEqual([
      "🧪 test driver, owner says (replying to message 9): [test] hi",
      `🧪 test driver, owner edits message ${TELEGRAM_TEST_ID_FLOOR} to: [test] hello`,
      "🧪 test driver, owner reacts ❤️ to message 9",
      "🧪 test driver, owner taps a button on message 9",
    ])
    const withoutEcho = fixture()
    delete withoutEcho.deps.echo
    await expect(runSanctuaryTelegramTestDriver(["send", "--text", "[test] quiet", "--no-wait"], withoutEcho.deps)).resolves.toMatchObject({ messageId: TELEGRAM_TEST_ID_FLOOR })
  })

  it("times out with what it saw when the resident never settles, and waits out trailing replies", async () => {
    const f = fixture()
    const timedOut = await runSanctuaryTelegramTestDriver(["send", "--text", "[test] anyone?", "--wait", "5"], f.deps) as any
    expect(timedOut).toMatchObject({ settlement: "pending", timedOut: true, replies: [] })

    const g = fixture()
    residentAnswers(g, { chat_id: "42", text: "Approve the restart?" })
    let sleeps = 0
    const sleep = g.deps.sleep!
    g.deps.sleep = async (milliseconds) => {
      sleeps += 1
      if (sleeps === 3) g.log.append(sanctuaryTelegramOutboundEntry({ method: "sendMessage", body: { chat_id: "42", text: "Done." }, result: { message_id: 78 } }))
      await sleep(milliseconds)
    }
    const settled = await runSanctuaryTelegramTestDriver(["send", "--text", "[test] restart it", "--quiet", "2"], g.deps) as any
    expect(settled.replies.map((reply: any) => reply.text)).toEqual(["Approve the restart?", "Done."])
    expect(settled.timedOut).toBe(false)
  })

  it("uses the real clock, timer and stdout by default and treats a vanished record as settled", async () => {
    const f = fixture()
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      const gateway = { ...f.gateway, injectTestUpdate: f.gateway.injectTestUpdate.bind(f.gateway), nextTestUpdateId: () => TELEGRAM_TEST_ID_FLOOR, record: () => null }
      const transcript = await runSanctuaryTelegramTestDriver(["send", "--text", "[test] gone", "--quiet", "1", "--no-echo"], {
        gateway, log: f.log, botId: "123456", ownerUserId: "42", ownerChatId: "42",
      }) as any
      expect(transcript).toMatchObject({ settlement: "missing", timedOut: false })
      expect(stdout).toHaveBeenCalled()
    } finally { stdout.mockRestore() }
  })

  it("prints the log, optionally from a sequence number", async () => {
    const f = fixture()
    await runSanctuaryTelegramTestDriver(["send", "--text", "[test] one", "--no-wait", "--no-echo"], f.deps)
    await runSanctuaryTelegramTestDriver(["send", "--text", "[test] two", "--no-wait", "--no-echo"], f.deps)
    expect(await runSanctuaryTelegramTestDriver(["log"], f.deps)).toHaveLength(2)
    expect(await runSanctuaryTelegramTestDriver(["log", "--since", "1"], f.deps)).toMatchObject([{ seq: 2 }])
    expect(new FileSanctuaryTelegramTestLog(path.join(root(), "absent")).read()).toEqual([])
  })

  it("refuses untagged text, edits of real messages and malformed options", async () => {
    const f = fixture()
    const run = (argv: string[]) => runSanctuaryTelegramTestDriver(argv, f.deps)
    await expect(run(["send", "--text", "what's downloading?"])).rejects.toThrow(/\[test\]/u)
    await expect(run(["send"])).rejects.toThrow(/\[test\]/u)
    await expect(run(["send", "--text", `[test] ${"x".repeat(4_096)}`])).rejects.toThrow(/\[test\]/u)
    await expect(run(["edit", "--message-id", "500", "--text", "[test] x"])).rejects.toThrow(/earlier injected message/u)
    await expect(run(["react", "--message-id", "500"])).rejects.toThrow(/--emoji/u)
    await expect(run(["react", "--message-id", "500", "--emoji", "x".repeat(17)])).rejects.toThrow(/--emoji/u)
    await expect(run(["tap", "--message-id", "500"])).rejects.toThrow(/--data/u)
    await expect(run(["tap", "--message-id", "500", "--data", "x".repeat(257)])).rejects.toThrow(/--data/u)
    await expect(run(["react", "--message-id", "0", "--emoji", "❤️"])).rejects.toThrow(/positive integer/u)
    await expect(run(["react", "--emoji", "❤️"])).rejects.toThrow(/positive integer/u)
    await expect(run(["react", "--message-id", "99999999999999999999", "--emoji", "❤️"])).rejects.toThrow(/positive integer/u)
    await expect(run(["send", "--text", "[test] x", "--wait", "soon"])).rejects.toThrow(/positive integer/u)
    await expect(run(["send", "--text"])).rejects.toThrow(/incomplete option/u)
    await expect(run(["send", "--bogus", "1"])).rejects.toThrow(/unknown or incomplete/u)
    await expect(run(["dance"])).rejects.toThrow(/usage/u)
    await expect(run([])).rejects.toThrow(/usage/u)
    expect(f.log.read()).toEqual([])
  })

  it("keeps the authority's log window closed unless a driver run armed it", () => {
    const logRoot = path.join(root(), "test-driver")
    let clock = 1_000
    const log = new FileSanctuaryTelegramTestLog(logRoot, () => clock)
    expect(log.armed()).toBe(false)
    log.arm(5_000)
    expect(log.armed()).toBe(true)
    clock = 5_000
    expect(log.armed()).toBe(false)
    fs.writeFileSync(path.join(logRoot, "armed-until.json"), "{\"until\":5}")
    expect(log.armed()).toBe(false)
    expect(new FileSanctuaryTelegramTestLog(logRoot).armed()).toBe(false)
  })

  it("summarizes outbound sends without content it does not need", () => {
    expect(sanctuaryTelegramOutboundEntry({ method: "sendPhoto", body: { chat_id: 42, caption: "c".repeat(5_000) }, result: [] })).toEqual({
      kind: "outbound", method: "sendPhoto", chatId: "42", caption: `${"c".repeat(4_096)}…`,
    })
    expect(sanctuaryTelegramOutboundEntry({ method: "editMessageText", body: { chat_id: 42, message_id: 3, text: "t" }, result: null })).toEqual({
      kind: "outbound", method: "editMessageText", chatId: "42", targetMessageId: 3, text: "t",
    })
    expect(sanctuaryTelegramOutboundEntry({ method: "sendMessage", body: { text: "t" }, result: { message_id: "x" } })).toEqual({ kind: "outbound", method: "sendMessage", text: "t" })
    expect(sanctuaryTelegramOutboundEntry({
      method: "sendMessage", observationUpdateId: 12, replyToDropped: TELEGRAM_TEST_ID_FLOOR,
      body: { chat_id: "42", text: "t", reply_markup: { inline_keyboard: [] }, reaction: [], callback_query_id: "q" }, result: { message_id: 4 },
    })).toEqual({
      kind: "outbound", method: "sendMessage", chatId: "42", observationUpdateId: 12, testObservation: false, text: "t", replyMarkup: { inline_keyboard: [] },
      reaction: [], replyTo: TELEGRAM_TEST_ID_FLOOR, replyToDropped: true, callbackQueryId: "q", messageId: 4,
    })
    expect(sanctuaryTelegramOutboundEntry({ method: "sendMessage", body: { chat_id: "42", text: "t", reply_parameters: { message_id: 9 } }, result: {}, local: true })).toEqual({
      kind: "outbound", method: "sendMessage", chatId: "42", text: "t", replyTo: 9, local: true,
    })
  })
})

describe("Sanctuary owner-turn test driver entry", () => {
  function installed() {
    const directory = root()
    const keys = generateKeyPairSync("ed25519")
    const tokenPath = path.join(directory, "token")
    const privateKeyPath = path.join(directory, "issuer.pem")
    const configPath = path.join(directory, "active.json")
    fs.writeFileSync(tokenPath, "123456:abcdefghijklmnopqrstuvwxyz\n", { mode: 0o600 })
    fs.writeFileSync(privateKeyPath, keys.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 })
    const at = (name: string) => path.join(directory, name)
    const digest = `sha256:${"a".repeat(64)}`
    const config = {
      schemaVersion: 1, agentRoot: at("agent"), targetHost: "sanctuary", botId: "123456", ownerUserId: "42", ownerChatId: "42",
      keyId: "issuer-1", publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey), tokenPath, privateKeyPath,
      socketPath: at("authority.sock"), socketGroupId: 10001, readinessPath: at("readiness.json"), lockPath: at("authority.lock"),
      hostStagingRoot: at("staging"), hostExecutionStateRoot: at("executions"), hostSupervisorStateRoot: at("supervisors"),
      hostCgroupRoot: at("cgroup"), hostSupervisorProgramPath: at("supervisor"), hostSupervisorProgramDigest: digest,
      hostLauncherPath: at("launcher"), hostLauncherDigest: digest, hostPrlimitPath: at("prlimit"), hostPrlimitDigest: digest,
      hostSetsidPath: at("setsid"), hostSetsidDigest: digest, hostShellPath: at("shell"), hostShellDigest: digest,
      epochRoot: directory, packageRoot: at("package"), packageManifestPath: at("manifest.json"), packageManifestDigest: digest,
    }
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
    return { configPath, config }
  }

  it("loads the live authority's root-only config and injects through its gateway", async () => {
    const { configPath, config } = installed()
    const api = { request: vi.fn(async () => ({ message_id: 1 })), stop: vi.fn() }
    const createApi = vi.fn(() => api)
    const output: string[] = []
    const injected = await runSanctuaryTelegramTestDriverCli({
      argv: ["send", "--config", configPath, "--text", "[test] hi", "--no-wait"],
      expectedUid: process.getuid!(), createApi, write: (text) => { output.push(text) },
    })
    expect(injected).toEqual({ updateId: TELEGRAM_TEST_ID_FLOOR, messageId: TELEGRAM_TEST_ID_FLOOR, seq: 1 })
    expect(createApi).toHaveBeenCalledWith("123456:abcdefghijklmnopqrstuvwxyz")
    expect(api.request).toHaveBeenCalledWith("sendMessage", { chat_id: "42", text: "🧪 test driver, owner says: [test] hi" })
    expect(api.stop).toHaveBeenCalled()
    expect(fs.existsSync(path.join(config.agentRoot, "authority", "test-driver", "log.ndjson"))).toBe(true)

    const quiet = await runSanctuaryTelegramTestDriverCli({ argv: ["--config", configPath, "log"], expectedUid: process.getuid!(), write: () => undefined })
    expect(quiet).toHaveLength(1)
    await expect(runSanctuaryTelegramTestDriverCli({ argv: ["log"] })).rejects.toThrow(/usage/u)
  })

  it("defaults to the process arguments, root ownership and the real Telegram client", async () => {
    const { configPath } = installed()
    const argv = process.argv
    process.argv = ["node", "driver", "log"]
    try {
      await expect(runSanctuaryTelegramTestDriverCli()).rejects.toThrow(/usage/u)
    } finally { process.argv = argv }
    if (process.getuid!() !== 0) {
      await expect(runSanctuaryTelegramTestDriverCli({ argv: ["--config", configPath, "log"] })).rejects.toThrow(/unsafe/u)
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { message_id: 3 } }), { status: 200, headers: { "content-type": "application/json" } }))
    vi.stubGlobal("fetch", fetch)
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      await runSanctuaryTelegramTestDriverCli({ argv: ["--config", configPath, "send", "--text", "[test] hi", "--no-wait"], expectedUid: process.getuid!() })
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/sendMessage"), expect.anything())
      expect(stdout).toHaveBeenCalled()
    } finally {
      stdout.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
