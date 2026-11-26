// The answering handles (design §3.4): for each person, the one iMessage handle whose messages may answer their
// letters. Only the owner sets one, with the CLI-only `ouro mailbox handle set`; the file tools refuse this folder.
// The friend record is never consulted, since several paths write its identities. Filing freezes the person's
// handle into the letter, so changing it later leaves letters already filed alone.
import * as fs from "fs"
import * as path from "path"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../../nerves/runtime"

export const ANSWERING_FILE = "answering.json"

export type HandleCheck = { ok: true; handle: string } | { ok: false; problem: string }

/**
 * A handle the way both sides compare it: an email address in lowercase, or a phone number in E.164 (`+` and
 * digits only). A number without its country code is refused rather than guessed.
 */
export function normalizeAnsweringHandle(raw: string): HandleCheck {
  const trimmed = raw.trim()
  if (trimmed.includes("@")) {
    const email = trimmed.toLowerCase()
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ? { ok: true, handle: email }
      : { ok: false, problem: `"${trimmed}" isn't an email address or a phone number.` }
  }
  const compact = trimmed.replace(/[\s().-]/g, "")
  if (/^\+[1-9]\d{6,14}$/.test(compact)) return { ok: true, handle: compact }
  if (/^\d{7,15}$/.test(compact)) return { ok: false, problem: `"${trimmed}" has no country code. Write it with one, such as +15551234567.` }
  return { ok: false, problem: `"${trimmed}" isn't an email address or a phone number.` }
}

/** Each person's answering handle, by friend id. A missing or unreadable file means nobody has one. */
export function readAnsweringHandles(lettersDir: string): Record<string, string> {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(lettersDir, ANSWERING_FILE), "utf8"))
  } catch {
    return {}
  }
  const handles = (parsed as { handles?: unknown } | null)?.handles
  if (!handles || typeof handles !== "object" || Array.isArray(handles)) return {}
  const result: Record<string, string> = {}
  for (const [friendId, handle] of Object.entries(handles)) {
    if (typeof handle !== "string") continue
    const checked = normalizeAnsweringHandle(handle)
    if (checked.ok) result[friendId] = checked.handle
  }
  return result
}

/** Sets one person's handle, replacing the file atomically: write a temporary file, sync it, rename, sync the folder. */
export function writeAnsweringHandle(lettersDir: string, friendId: string, handle: string): void {
  fs.mkdirSync(lettersDir, { recursive: true })
  const handles = { ...readAnsweringHandles(lettersDir), [friendId]: handle }
  const tmp = path.join(lettersDir, `${ANSWERING_FILE}.tmp`)
  const fd = fs.openSync(tmp, "w", 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify({ v: 1, handles }, null, 2)}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, path.join(lettersDir, ANSWERING_FILE))
  const dir = fs.openSync(lettersDir, "r")
  try {
    fs.fsyncSync(dir)
  } finally {
    fs.closeSync(dir)
  }
  emitNervesEvent({ component: "daemon", event: "letters.answering_handle_set", message: "a person's answering handle was set", meta: { friendId } })
}

function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * `ouro mailbox handle set <person> <handle>`: finds the person among the agent's friends by id, or else by name
 * (ignoring case), and sets their handle. Throws with the card's code when the handle or the person doesn't check out.
 */
export async function setAnsweringHandle(
  bundleRoot: string,
  person: string,
  rawHandle: string,
  list: (bundleRoot: string) => Promise<FriendRecord[]> = (root) => new FileFriendStore(path.join(root, "friends")).listAll(),
): Promise<string> {
  const checked = normalizeAnsweringHandle(rawHandle)
  if (!checked.ok) throw refusal("bad-handle", checked.problem)
  const friends = await list(bundleRoot)
  const byId = friends.find((record) => record.id === person)
  const byName = friends.filter((record) => record.name.toLowerCase() === person.toLowerCase())
  if (!byId && byName.length > 1) throw refusal("which-person", `${byName.length} friends are named ${person}: ${byName.map((record) => record.id).join(", ")}. Pass one of those ids.`)
  const friend = byId ?? byName[0]
  if (!friend) throw refusal("no-person", `No friend is ${person}. Find the person's id with ouro friend list.`)
  writeAnsweringHandle(path.join(bundleRoot, "state", "letters"), friend.id, checked.handle)
  return `${friend.name} (${friend.id}) answers letters from ${checked.handle}. Letters filed from now on go to that chat; letters already filed keep the handle they were filed with.`
}
