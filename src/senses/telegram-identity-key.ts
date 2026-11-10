import { randomBytes } from "node:crypto"
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

// The Telegram sense's opaque identity key, apart from the sense itself so the
// daemon can read it without loading the sense and the turn engine it imports.

const TELEGRAM_IDENTITY_KEY = /^[A-Za-z0-9_-]{43}$/u

export function canonicalTelegramIdentityKey(value: string): string {
  const key = value.trim()
  if (!TELEGRAM_IDENTITY_KEY.test(key) || Buffer.from(key, "base64url").length !== 32) {
    throw new Error("Telegram opaque identity key is invalid")
  }
  return key
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined
}

export function openSecureTelegramDirectory(directory: string, afterOpen?: (handle: number) => void): number {
  try {
    const existing = lstatSync(directory)
    if (existing.isSymbolicLink()) throw new Error("Telegram state directory must not be a symbolic link")
    if (!existing.isDirectory()) throw new Error("Telegram state directory is not a directory")
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error
    mkdirSync(directory, { recursive: true, mode: 0o700 })
  }
  const handle = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  try {
    fchmodSync(handle, 0o700)
    afterOpen?.(handle)
    const metadata = fstatSync(handle)
    if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700) {
      throw new Error("Telegram state directory permissions are invalid")
    }
    return handle
  } catch (error) {
    closeSync(handle)
    throw error
  }
}

export function readOrCreateTelegramIdentityKey(agentRoot: string, hooks: {
  beforeCreate?: (keyPath: string) => void
  afterOpenDirectory?: (handle: number) => void
  afterCreateTemporary?: (temporaryPath: string, keyPath: string) => void
  beforePublish?: (temporaryPath: string, keyPath: string) => void
} = {}): string {
  const directory = path.join(agentRoot, "state", "senses", "telegram")
  const keyPath = path.join(directory, "identity.key")
  const directoryHandle = openSecureTelegramDirectory(directory, hooks.afterOpenDirectory)
  const readKey = (): string => {
    const handle = openSync(keyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const metadata = fstatSync(handle)
      if (!metadata.isFile() || (metadata.mode & 0o777) !== 0o600) throw new Error("Telegram opaque identity key permissions are invalid")
      return canonicalTelegramIdentityKey(readFileSync(handle, "utf8"))
    } finally {
      closeSync(handle)
    }
  }
  try {
    try {
      return readKey()
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error
    }
    const key = randomBytes(32).toString("base64url")
    hooks.beforeCreate?.(keyPath)
    const temporaryPath = path.join(directory, `.identity.key.${randomBytes(12).toString("base64url")}.tmp`)
    let temporaryHandle: number | undefined
    try {
      temporaryHandle = openSync(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
      hooks.afterCreateTemporary?.(temporaryPath, keyPath)
      writeFileSync(temporaryHandle, `${key}\n`)
      fsyncSync(temporaryHandle)
      closeSync(temporaryHandle)
      temporaryHandle = undefined
      hooks.beforePublish?.(temporaryPath, keyPath)
      try {
        linkSync(temporaryPath, keyPath)
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error
        return readKey()
      }
      fsyncSync(directoryHandle)
      emitNervesEvent({ component: "senses", event: "senses.telegram_identity_key_created", message: "created the Telegram opaque identity key", meta: { agentRoot } })
      return key
    } finally {
      if (temporaryHandle !== undefined) closeSync(temporaryHandle)
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
      fsyncSync(directoryHandle)
    }
  } finally {
    closeSync(directoryHandle)
  }
}
