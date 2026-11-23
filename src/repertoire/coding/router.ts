import { emitNervesEvent } from "../../nerves/runtime"
import type {
  CodingActionResult,
  CodingBackend,
  CodingSession,
  CodingSessionManagerApi,
  CodingSessionRequest,
  CodingSessionUpdate,
  RefreshableCodingSessionManagerApi,
} from "./types"

/** Every coding backend, in the order sessions are listed. */
export const CODING_BACKENDS: readonly CodingBackend[] = ["orca", "local", "workbench"]

export type CodingManagerFactory = (backend: CodingBackend) => CodingSessionManagerApi

export interface CodingSessionRouterOptions {
  /** The backend a spawn uses when it names none: the agent's `coding.backend`, else orca. */
  preferredBackend: CodingBackend
  createManager: CodingManagerFactory
  /** Backends whose sessions are read at start (their managers restore persisted sessions cheaply). */
  eagerBackends?: CodingBackend[]
}

function isRefreshable(manager: CodingSessionManagerApi): manager is RefreshableCodingSessionManagerApi {
  return typeof (manager as Partial<RefreshableCodingSessionManagerApi>).refreshSessions === "function"
}

function stamp(session: CodingSession, backend: CodingBackend): CodingSession {
  return { ...session, backend }
}

/**
 * The one way Ouro starts and drives a coding agent. Each spawn goes to one backend (the request's,
 * else the preferred one); status, tail, input and kill find the session wherever it runs.
 */
export class CodingSessionRouter implements RefreshableCodingSessionManagerApi {
  readonly preferredBackend: CodingBackend
  private readonly createManager: CodingManagerFactory
  private readonly managers = new Map<CodingBackend, CodingSessionManagerApi>()

  constructor(options: CodingSessionRouterOptions) {
    this.preferredBackend = options.preferredBackend
    this.createManager = options.createManager
    for (const backend of options.eagerBackends ?? []) this.managerFor(backend)
  }

  async spawnSession(request: CodingSessionRequest): Promise<CodingSession> {
    const backend = request.backend ?? this.preferredBackend
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.coding_backend_selected",
      message: "routing coding spawn to a backend",
      meta: { backend, preferred: this.preferredBackend, runner: request.runner },
    })
    const session = await this.managerFor(backend).spawnSession({ ...request, backend })
    return stamp(session, backend)
  }

  listSessions(): CodingSession[] {
    return this.entries().flatMap(([backend, manager]) => manager.listSessions().map((session) => stamp(session, backend)))
  }

  async refreshSessions(): Promise<CodingSession[]> {
    const all: CodingSession[] = []
    for (const [backend, manager] of this.entries()) {
      const sessions = isRefreshable(manager) ? await manager.refreshSessions() : manager.listSessions()
      all.push(...sessions.map((session) => stamp(session, backend)))
    }
    return all
  }

  getSession(sessionId: string): CodingSession | null {
    const owner = this.ownerOf(sessionId)
    return owner ? stamp(owner[1].getSession(sessionId)!, owner[0]) : null
  }

  async refreshSession(sessionId: string): Promise<CodingSession | null> {
    const owner = await this.findOwner(sessionId)
    if (!owner) return null
    const [backend, manager] = owner
    const session = isRefreshable(manager) ? await manager.refreshSession(sessionId) : manager.getSession(sessionId)
    return session ? stamp(session, backend) : null
  }

  subscribe(sessionId: string, listener: (update: CodingSessionUpdate) => void | Promise<void>): () => void {
    const owner = this.ownerOf(sessionId)
    if (!owner) return () => {}
    const [backend, manager] = owner
    return manager.subscribe(sessionId, (update) => listener({ ...update, session: stamp(update.session, backend) }))
  }

  async sendInput(sessionId: string, input: string): Promise<CodingActionResult> {
    const owner = await this.findOwner(sessionId)
    return owner ? owner[1].sendInput(sessionId, input) : { ok: false, message: `session not found: ${sessionId}` }
  }

  async killSession(sessionId: string): Promise<CodingActionResult> {
    const owner = await this.findOwner(sessionId)
    return owner ? owner[1].killSession(sessionId) : { ok: false, message: `session not found: ${sessionId}` }
  }

  async checkStalls(nowMs?: number): Promise<number> {
    let total = 0
    for (const [, manager] of this.entries()) total += await manager.checkStalls(nowMs)
    return total
  }

  async shutdown(): Promise<void> {
    for (const [, manager] of this.entries()) await manager.shutdown()
    this.managers.clear()
  }

  private managerFor(backend: CodingBackend): CodingSessionManagerApi {
    let manager = this.managers.get(backend)
    if (!manager) {
      manager = this.createManager(backend)
      this.managers.set(backend, manager)
    }
    return manager
  }

  private entries(): Array<[CodingBackend, CodingSessionManagerApi]> {
    return CODING_BACKENDS.filter((backend) => this.managers.has(backend)).map((backend) => [backend, this.managers.get(backend)!])
  }

  /** The session's backend, refreshing once first when no manager knows it yet (Workbench learns its sessions on refresh). */
  private async findOwner(sessionId: string): Promise<[CodingBackend, CodingSessionManagerApi] | null> {
    const known = this.ownerOf(sessionId)
    if (known) return known
    await this.refreshSessions()
    return this.ownerOf(sessionId)
  }

  private ownerOf(sessionId: string): [CodingBackend, CodingSessionManagerApi] | null {
    return this.entries().find(([, manager]) => manager.getSession(sessionId) !== null) ?? null
  }
}
