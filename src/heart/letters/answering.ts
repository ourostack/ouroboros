// Who letters go to, and the handles they answer from (design §3.4). A letter goes to the one family record naming
// this machine's owner. Its answering handle is the one iMessage handle whose messages may answer it, set only by the
// owner with the CLI-only `ouro mailbox handle set`; the file tools refuse this folder. The friend record's own
// identities are never used to decide who may answer, since several paths write them. Filing freezes the person's
// handle into the letter, so changing it later leaves letters already filed alone.
import * as fs from "fs"
import * as path from "path"
import { randomBytes } from "crypto"
import { FileFriendStore, isLocalMachineOwnerIdentity, machineOwnerUsername, type FriendRecord } from "@ouro.bot/friends"
import { emitNervesEvent } from "../../nerves/runtime"

export const ANSWERING_FILE = "answering.json"

export type HandleCheck = { ok: true; handle: string } | { ok: false; problem: string }

type ListFriends = (bundleRoot: string) => Promise<FriendRecord[]>

const listBundleFriends: ListFriends = (root) => new FileFriendStore(path.join(root, "friends")).listAll()

/** The family records in a bundle's friends folder that name this machine's owner, the rule `ouro friend link-code` uses. */
export async function ownerFriendIds(bundleRoot: string, owner: string | null, list: ListFriends = listBundleFriends): Promise<string[]> {
  const friends = await list(bundleRoot)
  return friends
    .filter((record) => record.trustLevel === "family" && record.externalIds.some((id) => isLocalMachineOwnerIdentity(id.provider, id.externalId, owner)))
    .map((record) => record.id)
}

/**
 * A handle the way both sides compare it: an email address in lowercase, or a phone number in E.164 (`+` and
 * digits only). A number without its country code is refused rather than guessed. The answer reader compares a
 * sender, and the handle in a chat GUID, through this same function.
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

type AnsweringFile = { ok: true; handles: Record<string, unknown> } | { ok: false; problem: string }

/** The file as stored: missing means nobody has a handle yet; anything else that doesn't read is a problem. */
function readFile(lettersDir: string): AnsweringFile {
  let raw: string
  try {
    raw = fs.readFileSync(path.join(lettersDir, ANSWERING_FILE), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, handles: {} }
    return { ok: false, problem: (error as Error).message }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { ok: false, problem: (error as Error).message }
  }
  const handles = (parsed as { handles?: unknown } | null)?.handles
  if (!handles || typeof handles !== "object" || Array.isArray(handles)) return { ok: false, problem: "it has no handles object" }
  return { ok: true, handles: handles as Record<string, unknown> }
}

/** Each person's answering handle, by friend id. Filing reads it; a file that doesn't read gives nobody a handle. */
export function readAnsweringHandles(lettersDir: string): Record<string, string> {
  const file = readFile(lettersDir)
  if (!file.ok) {
    emitNervesEvent({ level: "warn", component: "daemon", event: "letters.answering_unreadable", message: "the answering handles file doesn't read, so no letter gets a handle", meta: { problem: file.problem } })
    return {}
  }
  const result: Record<string, string> = {}
  for (const [friendId, handle] of Object.entries(file.handles)) {
    if (typeof handle !== "string") continue
    const checked = normalizeAnsweringHandle(handle)
    if (checked.ok) result[friendId] = checked.handle
  }
  return result
}

function refusal(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

/**
 * Sets one person's handle and keeps every other entry as stored. A file that doesn't read is refused rather than
 * replaced, so a torn file never silently drops other people's handles. The new file is written under a name of its
 * own, synced, renamed into place, and the folder synced.
 */
export function writeAnsweringHandle(lettersDir: string, friendId: string, handle: string): void {
  fs.mkdirSync(lettersDir, { recursive: true })
  const file = readFile(lettersDir)
  if (!file.ok) throw refusal("answering-unreadable", `${path.join(lettersDir, ANSWERING_FILE)} doesn't read (${file.problem}), so it wasn't replaced. Fix: move it aside, then set each person's handle again.`)
  const tmp = path.join(lettersDir, `${ANSWERING_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`)
  const fd = fs.openSync(tmp, "wx", 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify({ v: 1, handles: { ...file.handles, [friendId]: handle } }, null, 2)}\n`)
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

/**
 * `ouro mailbox handle set <person> <handle>`: finds the person among the agent's friends by id, or else by name
 * (ignoring case), and sets their handle. Only a person letters go to can have one. Throws with the card's code when
 * the handle or the person doesn't check out.
 */
export async function setAnsweringHandle(
  bundleRoot: string,
  person: string,
  rawHandle: string,
  deps: { list?: ListFriends; owner?: () => string | null } = {},
): Promise<string> {
  const checked = normalizeAnsweringHandle(rawHandle)
  if (!checked.ok) throw refusal("bad-handle", checked.problem)
  const list = deps.list ?? listBundleFriends
  const friends = await list(bundleRoot)
  const byId = friends.find((record) => record.id === person)
  const byName = friends.filter((record) => record.name.toLowerCase() === person.toLowerCase())
  if (!byId && byName.length > 1) throw refusal("which-person", `${byName.length} friends are named ${person}: ${byName.map((record) => record.id).join(", ")}. Pass one of those ids.`)
  const friend = byId ?? byName[0]
  if (!friend) throw refusal("no-person", `No friend is ${person}. Find the person's id with ouro friend list.`)
  const recipients = await ownerFriendIds(bundleRoot, (deps.owner ?? machineOwnerUsername)(), async () => friends)
  if (!recipients.includes(friend.id)) {
    throw refusal("not-recipient", `${friend.name} (${friend.id}) isn't who letters go to: that is the family record naming this machine's owner${recipients.length === 1 ? `, ${recipients[0]}` : ""}.`)
  }
  writeAnsweringHandle(path.join(bundleRoot, "state", "letters"), friend.id, checked.handle)
  return `${friend.name} (${friend.id}) answers letters from ${checked.handle}. Letters filed from now on go to that chat; letters already filed keep the handle they were filed with.`
}
