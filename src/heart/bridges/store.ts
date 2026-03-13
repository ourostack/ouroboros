import * as fs from "fs"
import * as path from "path"
import { getAgentStateRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BridgeLifecycle, BridgeRuntime } from "./state-machine"

export interface BridgeSessionRef {
  friendId: string
  channel: string
  key: string
  sessionPath: string
  snapshot?: string | null
}

export interface BridgeTaskLink {
  taskName: string
  path: string
  mode: "bound" | "promoted"
  boundAt: string
}

export interface BridgeRecord {
  id: string
  objective: string
  summary: string
  lifecycle: BridgeLifecycle
  runtime: BridgeRuntime
  createdAt: string
  updatedAt: string
  attachedSessions: BridgeSessionRef[]
  task: BridgeTaskLink | null
}

export interface BridgeStore {
  save(bridge: BridgeRecord): BridgeRecord
  get(id: string): BridgeRecord | null
  list(): BridgeRecord[]
  findBySession(session: Pick<BridgeSessionRef, "friendId" | "channel" | "key">): BridgeRecord[]
}

interface CreateBridgeStoreOptions {
  rootDir?: string
}

function sessionIdentityMatches(
  session: Pick<BridgeSessionRef, "friendId" | "channel" | "key">,
  candidate: BridgeSessionRef,
): boolean {
  return (
    session.friendId === candidate.friendId
    && session.channel === candidate.channel
    && session.key === candidate.key
  )
}

function bridgeFilePath(rootDir: string, id: string): string {
  return path.join(rootDir, `${id}.json`)
}

export function getBridgeStateRoot(): string {
  return path.join(getAgentStateRoot(), "bridges")
}

export function createBridgeStore(options: CreateBridgeStoreOptions = {}): BridgeStore {
  const rootDir = options.rootDir ?? getBridgeStateRoot()

  function ensureRoot(): void {
    fs.mkdirSync(rootDir, { recursive: true })
  }

  return {
    save(bridge: BridgeRecord): BridgeRecord {
      ensureRoot()
      fs.writeFileSync(bridgeFilePath(rootDir, bridge.id), JSON.stringify(bridge, null, 2), "utf-8")
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_store_save",
        message: "saved bridge record",
        meta: {
          bridgeId: bridge.id,
          rootDir,
        },
      })
      return bridge
    },

    get(id: string): BridgeRecord | null {
      const filePath = bridgeFilePath(rootDir, id)
      try {
        const raw = fs.readFileSync(filePath, "utf-8")
        return JSON.parse(raw) as BridgeRecord
      } catch {
        return null
      }
    },

    list(): BridgeRecord[] {
      ensureRoot()
      const files = fs.readdirSync(rootDir).filter((entry) => entry.endsWith(".json")).sort()
      const bridges = files
        .map((fileName) => {
          try {
            return JSON.parse(fs.readFileSync(path.join(rootDir, fileName), "utf-8")) as BridgeRecord
          } catch {
            return null
          }
        })
        .filter((bridge): bridge is BridgeRecord => bridge !== null)
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_store_list",
        message: "listed bridge records",
        meta: {
          rootDir,
          count: bridges.length,
        },
      })
      return bridges
    },

    findBySession(session: Pick<BridgeSessionRef, "friendId" | "channel" | "key">): BridgeRecord[] {
      const matches = this.list().filter((bridge) =>
        bridge.attachedSessions.some((candidate) => sessionIdentityMatches(session, candidate)))
      emitNervesEvent({
        component: "engine",
        event: "engine.bridge_store_find_by_session",
        message: "located bridges for canonical session",
        meta: {
          friendId: session.friendId,
          channel: session.channel,
          key: session.key,
          count: matches.length,
        },
      })
      return matches
    },
  }
}
