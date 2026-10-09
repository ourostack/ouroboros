import * as fs from "node:fs"
import { emitNervesEvent } from "../nerves/runtime"

/**
 * Operator-set state lives in the agent bundle, which the agent's own process (and anything a prompt-injected model can
 * run through its shell) can write. Such state only counts when root owns it and nobody else can write it, the same
 * rule the replay window follows. Anything else reads as "not there", so every consumer fails closed.
 */
export const TRUSTED_UID = 0
let uidOverride: number | undefined

/** Tests run as an ordinary user, so they declare that user trusted; production never calls this. */
export function overrideTrustedUidForTests(uid: number | undefined): void {
  uidOverride = uid
}

/** A real directory (no symlink), owned by the trusted uid, writable by neither group nor other. */
export function isTrustedDirectory(target: string, trustedUid: number = uidOverride ?? TRUSTED_UID): boolean {
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(target)
  } catch {
    return false
  }
  const trusted = stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === trustedUid && (stat.mode & 0o022) === 0
  if (!trusted) rejected(target, "directory is not a real directory owned by the trusted uid and closed to group and other writes")
  return trusted
}

function rejected(target: string, reason: string): void {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.a2a_trusted_file_rejected", message: "ignored operator-set state the agent could have written", meta: { target, reason } })
}

/**
 * Parses a JSON file only if the file actually opened is trusted. The path is opened once with O_NOFOLLOW, then the
 * descriptor itself is checked (regular file, trusted owner, not group- or other-writable) and read, so a rename loop
 * cannot swap a different file in between the check and the read. Any error is `undefined`.
 */
export function readTrustedJson(file: string, trustedUid: number = uidOverride ?? TRUSTED_UID): unknown {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== trustedUid || (stat.mode & 0o022) !== 0) {
      rejected(file, "file is not a regular file owned by the trusted uid and closed to group and other writes")
      return undefined
    }
    return JSON.parse(fs.readFileSync(fd, "utf8"))
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}
