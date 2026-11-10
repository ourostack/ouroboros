/**
 * Presence: one named agent, present on several machines at once.
 *
 * A bundle opts in with a versioned `presence` block in its synced agent.json:
 *
 *   { "presence": { "schema": 1, "minVersion": "0.1.0-alpha.1003",
 *       "machines": [{ "machineId": "machine_…", "name": "aris-mac-mini", "role": "always-on" }, …],
 *       "owners": { "teams": "machine_…", "habits": "machine_…" } } }
 *
 * and each machine opts in locally with `~/.ouro-cli/presence.json`
 * (`{ "enabled": true }`, never synced) or `OURO_PRESENCE=1`. With the flag
 * off, or the block missing, the one-machine `home` lease applies unchanged.
 *
 * Every presence on a roster machine runs the agent. Machine-scoped senses
 * (cli, shepherd, app-sessions, …) run on every presence; each shared sense
 * (Teams, Telegram, mail, …) and the habits run only on the machine the roster
 * names as its owner.
 *
 * Mixed versions: each presence writes `presence/<machineId>.json` in the
 * bundle (`{ version, seenAt, … }`). A roster machine with no record, or one
 * whose version is below `minVersion`, may run a daemon that knows only
 * `home`, which would run every shared sense itself. Until every roster
 * machine is past that, every shared sense is owned by `home` and handoffs
 * refuse, so one Teams message is never answered twice.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseAgentHome, type AgentHome } from "./agent-discovery"

export const PRESENCE_SCHEMA = 1

/** The first harness version that knows presence; a rollback below it leaves the roster (see leavePresence). */
export const PRESENCE_FIRST_VERSION = "0.1.0-alpha.1012"

/** Senses that exist once per agent: exactly one machine runs each. */
export const SHARED_SENSES = ["teams", "telegram", "mail", "bluebubbles", "voice", "a2a", "habits"] as const
export type SharedSense = typeof SHARED_SENSES[number]

export function isSharedSense(sense: string): sense is SharedSense {
  return (SHARED_SENSES as readonly string[]).includes(sense)
}

export interface PresenceMachine {
  machineId: string
  name: string
  role: string
}

export interface PresenceBlock {
  schema: 1
  minVersion?: string
  machines: PresenceMachine[]
  owners: Record<string, string>
}

/** One session as a presence last saw it in its machine's Copilot app. */
export interface PeerAppSession {
  id: string
  name?: string
  state?: string
  /** Reserved for the fleet sense: why this session runs. */
  why?: string
  /** Reserved for the fleet sense: who runs and coordinates it. */
  owner?: { agent?: string; coordinator?: string; startedBy?: string }
  /** Reserved for the fleet sense: the desk card that is its source of truth. */
  desk?: { desk?: string; track?: string; slug?: string; status?: string; url?: string; via?: string }
}

/** What a presence publishes about itself in `presence/<machineId>.json`. */
export interface PeerRecord {
  machineId: string
  version: string
  seenAt: string
  name?: string
  role?: string
  os?: string
  location?: string
  owns?: string[]
  appSessions?: { at: string; counts: Record<string, number>; sessions?: PeerAppSession[] }
}

export interface Presence {
  block: PresenceBlock
  home: AgentHome | null
  /** Machines that may still run a daemon that knows only `home`: roster machines without a current record, and a home off the roster. */
  legacy: string[]
  peers: PeerRecord[]
}

export interface LocalPresenceSettings {
  enabled: boolean
  /** Where this machine is right now, e.g. "home" or "office"; written by whatever knows. */
  location?: string
  /** The daemon's launchd `Nice` on this machine (e.g. 10 where foreground work comes first). */
  nice?: number
  /** A command (argv) that prints this machine's location, as text or JSON `{ "location": … }`; run each minute. */
  locationCommand?: string[]
  /** Per location, a command (argv) to run the first time each day this machine arrives there; its output goes to the agent to tell its owner. */
  onArrive?: Record<string, string[]>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null
}

/** Parse agent.json's `presence` block; null when absent, of another schema, or unusable. */
export function parsePresenceBlock(value: unknown): PresenceBlock | null {
  if (!isRecord(value) || value.schema !== PRESENCE_SCHEMA || !Array.isArray(value.machines)) return null
  const machines: PresenceMachine[] = []
  for (const entry of value.machines) {
    if (!isRecord(entry)) continue
    const machineId = text(entry.machineId)
    if (!machineId || machines.some((machine) => machine.machineId === machineId)) continue
    machines.push({ machineId, name: text(entry.name) ?? machineId, role: text(entry.role) ?? "peer" })
  }
  if (machines.length === 0) return null
  const owners: Record<string, string> = {}
  if (isRecord(value.owners)) {
    for (const [sense, owner] of Object.entries(value.owners)) {
      const machineId = text(owner)
      if (machineId) owners[sense] = machineId
    }
  }
  const block: PresenceBlock = { schema: 1, machines, owners }
  const minVersion = text(value.minVersion)
  if (minVersion) block.minVersion = minVersion
  return block
}

/**
 * Compare two harness versions (`0.1.0-alpha.1003`). Numeric parts compare as
 * numbers; a release sorts after its prereleases.
 */
export function compareVersions(left: string, right: string): number {
  const split = (version: string): { core: number[]; pre: string[] } => {
    const [core, ...pre] = version.trim().replace(/^v/, "").split("-")
    return { core: core.split(".").map((part) => Number(part) || 0), pre: pre.join("-").split(".").filter(Boolean) }
  }
  const a = split(left)
  const b = split(right)
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i++) {
    const diff = (a.core[i] ?? 0) - (b.core[i] ?? 0)
    if (diff !== 0) return Math.sign(diff)
  }
  if (a.pre.length === 0 || b.pre.length === 0) return Math.sign(b.pre.length - a.pre.length)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = Number(x)
    const ny = Number(y)
    const bothNumeric = Number.isFinite(nx) && Number.isFinite(ny)
    const diff = bothNumeric ? nx - ny : x.localeCompare(y)
    if (diff !== 0) return Math.sign(diff)
  }
  return 0
}

export function parsePeerRecord(value: unknown): PeerRecord | null {
  if (!isRecord(value)) return null
  const machineId = text(value.machineId)
  const version = text(value.version)
  const seenAt = text(value.seenAt)
  if (!machineId || !version || !seenAt) return null
  const record: PeerRecord = { machineId, version, seenAt }
  for (const key of ["name", "role", "os", "location"] as const) {
    const field = text(value[key])
    if (field) record[key] = field
  }
  if (Array.isArray(value.owns)) record.owns = value.owns.filter((sense): sense is string => typeof sense === "string")
  if (isRecord(value.appSessions)) record.appSessions = value.appSessions as PeerRecord["appSessions"]
  return record
}

export function peerRecordsDir(agentRoot: string): string {
  return path.join(agentRoot, "presence")
}

/** Every presence record in the bundle; unreadable ones are skipped. */
export function readPeerRecords(agentRoot: string): PeerRecord[] {
  let names: string[]
  try {
    names = fs.readdirSync(peerRecordsDir(agentRoot))
  } catch {
    return []
  }
  const records: PeerRecord[] = []
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const record = parsePeerRecord(JSON.parse(fs.readFileSync(path.join(peerRecordsDir(agentRoot), name), "utf-8")))
      if (record && `${record.machineId}.json` === name) records.push(record)
    } catch {
      // Skip a record that is mid-write or malformed; the next read sees it.
    }
  }
  return records
}

/** Remove this machine's record (presence turned off here), so peers stop counting it as presence-aware. */
export function removePeerRecord(agentRoot: string, machineId: string): boolean {
  const target = path.join(peerRecordsDir(agentRoot), `${machineId}.json`)
  if (!fs.existsSync(target)) return false
  fs.rmSync(target, { force: true })
  emitNervesEvent({ component: "daemon", event: "daemon.presence_record_removed", message: "presence is off here; removed this machine's record", meta: { agentRoot, machineId } })
  return true
}

/**
 * Leave presence in a bundle: remove this machine's record and publish the
 * removal, so peers fall back to `home` before this machine runs shared senses
 * under the home lease. True when the bundle no longer holds this machine's
 * record on its remote (or never did, or does not sync).
 */
export async function leavePresence(agentRoot: string, machineId: string, publish: (agentRoot: string) => Promise<boolean>): Promise<boolean> {
  if (!removePeerRecord(agentRoot, machineId)) return true
  return publish(agentRoot)
}

/** Write this machine's own record. Each machine writes only its own file, so two presences never edit one file. */
export function writePeerRecord(agentRoot: string, record: PeerRecord): string {
  const dir = peerRecordsDir(agentRoot)
  fs.mkdirSync(dir, { recursive: true })
  const target = path.join(dir, `${record.machineId}.json`)
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, "utf-8")
  fs.renameSync(temp, target)
  return target
}

export function presenceSettingsPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, ".ouro-cli", "presence.json")
}

/** This machine's local opt-in. `OURO_PRESENCE=1|0` overrides the file. */
export function readLocalPresenceSettings(homeDir: string = os.homedir(), env: NodeJS.ProcessEnv = process.env): LocalPresenceSettings {
  let settings: LocalPresenceSettings = { enabled: false }
  try {
    const parsed = JSON.parse(fs.readFileSync(presenceSettingsPath(homeDir), "utf-8")) as unknown
    if (isRecord(parsed)) {
      settings = { enabled: parsed.enabled === true }
      const location = text(parsed.location)
      if (location) settings.location = location
      if (typeof parsed.nice === "number" && Number.isInteger(parsed.nice) && parsed.nice >= -20 && parsed.nice <= 20) settings.nice = parsed.nice
      const argv = (value: unknown): string[] | null => (Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === "string") ? value as string[] : null)
      const locationCommand = argv(parsed.locationCommand)
      if (locationCommand) settings.locationCommand = locationCommand
      if (isRecord(parsed.onArrive)) {
        const onArrive: Record<string, string[]> = {}
        for (const [place, command] of Object.entries(parsed.onArrive)) {
          const parsedCommand = argv(command)
          if (parsedCommand) onArrive[place] = parsedCommand
        }
        if (Object.keys(onArrive).length > 0) settings.onArrive = onArrive
      }
    }
  } catch {
    // No file: presence is off on this machine.
  }
  if (env.OURO_PRESENCE === "1") settings.enabled = true
  if (env.OURO_PRESENCE === "0") settings.enabled = false
  return settings
}

export function writeLocalPresenceSettings(settings: LocalPresenceSettings, homeDir: string = os.homedir()): void {
  const target = presenceSettingsPath(homeDir)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.writeFileSync(target, `${JSON.stringify(settings, null, 2)}\n`, "utf-8")
}

/**
 * The presence this machine should follow, or null for today's one-home lease
 * (flag off, or no usable block).
 */
export function readPresence(agentJson: unknown, localFlag: boolean, peerRecords: PeerRecord[]): Presence | null {
  if (!localFlag || !isRecord(agentJson)) return null
  const block = parsePresenceBlock(agentJson.presence)
  if (!block) return null
  const home = parseAgentHome(agentJson.home)
  const current = (machineId: string): boolean => {
    const record = peerRecords.find((peer) => peer.machineId === machineId)
    if (!record) return false
    return block.minVersion === undefined || compareVersions(record.version, block.minVersion) >= 0
  }
  const legacy = block.machines.filter((machine) => !current(machine.machineId)).map((machine) => machine.machineId)
  // A home off the roster runs every shared sense under the home lease.
  if (home && !block.machines.some((machine) => machine.machineId === home.machineId)) legacy.push(home.machineId)
  return { block, home, legacy, peers: peerRecords }
}

/**
 * Whether this machine may run a sense now: it owns it, and, for a shared
 * sense, no other roster machine's record still says it runs it. A new owner
 * waits for the old owner to publish that it let go, so a handoff never runs
 * a sense on two machines. Ownership is static: a silent old owner keeps its
 * claim until it publishes again or leaves the roster (no timeout, because a
 * sleeping laptop and a machine whose sync broke look the same as a dead one).
 */
export function mayRunSense(presence: Presence, machineId: string, sense: string): boolean {
  if (!ownsSense(presence, machineId, sense)) return false
  if (!isSharedSense(sense)) return true
  return !presence.peers.some((peer) => peer.machineId !== machineId && isRosterMember(presence, peer.machineId) && peer.owns?.includes(sense))
}

/** Read the bundle's agent.json, the local flag and the peer records together. */
export function readPresenceForAgent(agentRoot: string, options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {}): Presence | null {
  const settings = readLocalPresenceSettings(options.homeDir, options.env)
  if (!settings.enabled) return null
  let agentJson: unknown
  try {
    agentJson = JSON.parse(fs.readFileSync(path.join(agentRoot, "agent.json"), "utf-8"))
  } catch {
    return null
  }
  return readPresence(agentJson, true, readPeerRecords(agentRoot))
}

export function isRosterMember(presence: Presence, machineId: string): boolean {
  return presence.block.machines.some((machine) => machine.machineId === machineId)
}

export function rosterMachine(presence: Presence, machineId: string): PresenceMachine | undefined {
  return presence.block.machines.find((machine) => machine.machineId === machineId)
}

/**
 * The machine that runs a shared sense. While any roster machine may run a
 * daemon that knows only `home`, that is `home`, whatever the roster says.
 */
export function effectiveOwner(presence: Presence, sense: SharedSense): string {
  if (presence.legacy.length > 0 && presence.home) return presence.home.machineId
  return presence.block.owners[sense] ?? presence.home?.machineId ?? presence.block.machines[0].machineId
}

/** Whether this machine runs this sense under the roster. Machine-scoped senses run on every roster machine. */
export function ownsSense(presence: Presence, machineId: string, sense: string): boolean {
  if (!isRosterMember(presence, machineId)) return false
  if (!isSharedSense(sense)) return true
  return effectiveOwner(presence, sense) === machineId
}

export function ownedSharedSenses(presence: Presence, machineId: string): SharedSense[] {
  return SHARED_SENSES.filter((sense) => ownsSense(presence, machineId, sense))
}

/** A machine name a person would type: case-insensitive, `.local` ignored; ids match too. */
export function findRosterMachine(presence: Presence | { block: PresenceBlock }, nameOrId: string): PresenceMachine | undefined {
  const wanted = nameOrId.trim().replace(/\.local$/i, "").toLowerCase()
  return presence.block.machines.find((machine) => machine.machineId.toLowerCase() === wanted || machine.name.toLowerCase() === wanted)
}

/**
 * Whether a shared sense this machine owns is currently being handed to
 * another machine: used by the daemon to log the moment ownership changes.
 */
export function emitOwnershipChange(agent: string, sense: string, owns: boolean, owner: string | null): void {
  emitNervesEvent({
    component: "daemon",
    event: owns ? "daemon.presence_sense_owned" : "daemon.presence_sense_released",
    message: owns ? `${sense} is owned by this machine` : `${sense} is owned by another machine`,
    meta: { agent, sense, owner },
  })
}
