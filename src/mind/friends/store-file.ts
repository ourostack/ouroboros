// FileFriendStore -- filesystem adapter for FriendStore.
// Stores each friend as one unified JSON file in bundle `friends/`.

import * as fs from "fs"
import * as fsPromises from "fs/promises"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { FriendStore } from "./store"
import type { FriendRecord, TrustLevel, AgentMeta } from "./types"

const DEFAULT_ROLE = "friend"
const DEFAULT_TRUST_LEVEL: TrustLevel = "friend"

export class FileFriendStore implements FriendStore {
  private readonly friendsPath: string

  constructor(friendsPath: string) {
    this.friendsPath = friendsPath
    fs.mkdirSync(friendsPath, { recursive: true })
    emitNervesEvent({
      component: "friends",
      event: "friends.store_init",
      message: "file friend store initialized",
      meta: {},
    })
  }

  async get(id: string): Promise<FriendRecord | null> {
    const record = await this.readJson(path.join(this.friendsPath, `${id}.json`))
    if (!record) return null
    return this.normalize(record)
  }

  async put(id: string, record: FriendRecord): Promise<void> {
    await this.writeJson(
      path.join(this.friendsPath, `${id}.json`),
      this.normalize(record),
    )
  }

  async delete(id: string): Promise<void> {
    await this.removeFile(path.join(this.friendsPath, `${id}.json`))
  }

  async findByExternalId(
    provider: string,
    externalId: string,
    tenantId?: string,
  ): Promise<FriendRecord | null> {
    let entries: string[]
    try {
      entries = await fsPromises.readdir(this.friendsPath)
    } catch {
      return null
    }

    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const raw = await this.readJson(path.join(this.friendsPath, entry))
      if (!raw) continue
      const record = this.normalize(raw)

      const match = record.externalIds.some(
        (ext) =>
          ext.provider === provider &&
          ext.externalId === externalId &&
          (tenantId === undefined || ext.tenantId === tenantId),
      )

      if (match) {
        return record
      }
    }

    return null
  }

  async hasAnyFriends(): Promise<boolean> {
    let entries: string[]
    try {
      entries = await fsPromises.readdir(this.friendsPath)
    } catch {
      return false
    }

    return entries.some((entry) => entry.endsWith(".json"))
  }

  async listAll(): Promise<FriendRecord[]> {
    let entries: string[]
    try {
      entries = await fsPromises.readdir(this.friendsPath)
    } catch {
      return []
    }

    const records: FriendRecord[] = []
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue
      const raw = await this.readJson(path.join(this.friendsPath, entry))
      if (!raw) continue
      records.push(this.normalize(raw))
    }
    return records
  }

  private normalize(raw: FriendRecord): FriendRecord {
    const trustLevel = raw.trustLevel
    const normalizedTrustLevel: TrustLevel =
      trustLevel === "family" ||
      trustLevel === "friend" ||
      trustLevel === "acquaintance" ||
      trustLevel === "stranger"
        ? trustLevel
        : DEFAULT_TRUST_LEVEL

    const kind: "human" | "agent" =
      raw.kind === "human" || raw.kind === "agent" ? raw.kind : "human"

    const agentMeta = kind === "agent" ? this.normalizeAgentMeta(raw.agentMeta) : undefined

    return {
      id: raw.id,
      name: raw.name,
      role: typeof raw.role === "string" && raw.role.trim() ? raw.role : DEFAULT_ROLE,
      trustLevel: normalizedTrustLevel,
      connections: Array.isArray(raw.connections)
        ? raw.connections
            .filter(
              (connection): connection is { name: string; relationship: string } => (
                typeof connection === "object" &&
                connection !== null &&
                typeof (connection as { name?: unknown }).name === "string" &&
                typeof (connection as { relationship?: unknown }).relationship === "string"
              ),
            )
            .map((connection) => ({
              name: connection.name,
              relationship: connection.relationship,
            }))
        : [],
      externalIds: Array.isArray(raw.externalIds) ? raw.externalIds : [],
      tenantMemberships: Array.isArray(raw.tenantMemberships) ? raw.tenantMemberships : [],
      toolPreferences: raw.toolPreferences && typeof raw.toolPreferences === "object"
        ? raw.toolPreferences
        : {},
      notes: raw.notes && typeof raw.notes === "object" ? raw.notes : {},
      totalTokens: typeof raw.totalTokens === "number" ? raw.totalTokens : 0,
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
      schemaVersion: typeof raw.schemaVersion === "number" ? raw.schemaVersion : 1,
      kind,
      agentMeta,
    }
  }

  private normalizeAgentMeta(raw: unknown): AgentMeta | undefined {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
    const meta = raw as Record<string, unknown>
    if (typeof meta.bundleName !== "string") return undefined

    return {
      bundleName: meta.bundleName,
      familiarity: typeof meta.familiarity === "number" ? meta.familiarity : 0,
      sharedMissions: Array.isArray(meta.sharedMissions) ? meta.sharedMissions : [],
      outcomes: Array.isArray(meta.outcomes) ? meta.outcomes : [],
    }
  }

  private async readJson(filePath: string): Promise<FriendRecord | null> {
    try {
      const raw = await fsPromises.readFile(filePath, "utf-8")
      try {
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return null
        }
        return parsed as FriendRecord
      } catch {
        return null
      }
    } catch {
      return null
    }
  }

  private async writeJson(filePath: string, data: FriendRecord): Promise<void> {
    await fsPromises.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8")
  }

  private async removeFile(filePath: string): Promise<void> {
    try {
      await fsPromises.unlink(filePath)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return
      throw err
    }
  }
}
