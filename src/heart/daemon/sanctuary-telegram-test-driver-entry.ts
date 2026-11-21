#!/usr/bin/env node
import { createPrivateKey } from "node:crypto"
import * as fs from "node:fs"

import { emitNervesEvent } from "../../nerves/runtime"
import { createTelegramBotApi, type TelegramBotApi } from "../../senses/telegram-client"
import { loadSanctuaryTelegramAuthorityConfig, readPrivateFile } from "./sanctuary-telegram-authority-entry"
import { FileSanctuaryTelegramAuthorityGateway } from "./sanctuary-telegram-authority-gateway"
import {
  FileSanctuaryTelegramTestLog,
  runSanctuaryTelegramTestDriver,
  SANCTUARY_TELEGRAM_TEST_DRIVER_USAGE,
  sanctuaryTelegramTestLogRoot,
} from "./sanctuary-telegram-test-driver"
import { failureCodeLine } from "./cli-commands/failure-code"

/**
 * Root-only entry for the owner-turn test driver. It reads the live authority's own config and signing key, which
 * only root can read, and talks to nothing but the authority's state files and, for the visible echo, Telegram.
 */
export async function runSanctuaryTelegramTestDriverCli(options: {
  argv?: string[]
  expectedUid?: number
  createApi?: (token: string) => Pick<TelegramBotApi, "request" | "stop">
  write?: (text: string) => void
} = {}): Promise<unknown> {
  const argv = options.argv ?? process.argv.slice(2)
  const configIndex = argv.indexOf("--config")
  const configPath = configIndex >= 0 ? argv[configIndex + 1] : undefined
  if (!configPath) throw Object.assign(new Error(SANCTUARY_TELEGRAM_TEST_DRIVER_USAGE), { code: "missing-config" })
  const rest = [...argv.slice(0, configIndex), ...argv.slice(configIndex + 2)]
  const expectedUid = options.expectedUid ?? 0
  emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_telegram_test_driver_started", message: "Sanctuary owner-turn test driver started", meta: {} })
  const config = loadSanctuaryTelegramAuthorityConfig(configPath, { expectedUid })
  const gateway = new FileSanctuaryTelegramAuthorityGateway(config.agentRoot, {
    targetHost: config.targetHost,
    botId: config.botId,
    ownerUserId: config.ownerUserId,
    ownerChatId: config.ownerChatId,
    keyId: config.keyId,
    publicKeyDigest: config.publicKeyDigest,
    privateKey: createPrivateKey(readPrivateFile(config.privateKeyPath, expectedUid)),
  })
  let api: Pick<TelegramBotApi, "request" | "stop"> | undefined
  try {
    return await runSanctuaryTelegramTestDriver(rest, {
      gateway,
      log: new FileSanctuaryTelegramTestLog(sanctuaryTelegramTestLogRoot(config.agentRoot)),
      botId: config.botId,
      ownerUserId: config.ownerUserId,
      ownerChatId: config.ownerChatId,
      echo: async (text) => {
        api ??= (options.createApi ?? ((token) => createTelegramBotApi({ token })))(readPrivateFile(config.tokenPath, expectedUid).trim())
        return api.request("sendMessage", { chat_id: config.ownerChatId, text })
      },
      ...(options.write ? { write: options.write } : {}),
    })
  } finally {
    api?.stop()
  }
}

/** The codes this program's card names; only these end its stderr (see failure-code.ts). */
const CARD_CODES = ["missing-config"]

/* v8 ignore start -- process entry wiring; runSanctuaryTelegramTestDriverCli is tested directly @preserve */
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === __filename) {
  void runSanctuaryTelegramTestDriverCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Sanctuary test driver failed"}\n${failureCodeLine(error, CARD_CODES)}`)
    process.exitCode = 1
  })
}
/* v8 ignore stop @preserve */
