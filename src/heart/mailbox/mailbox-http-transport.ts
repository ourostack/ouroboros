import * as fs from "fs"
import * as http from "http"
import * as path from "path"

export interface SseClient {
  id: number
  response: http.ServerResponse
}

export interface SseBroadcaster {
  add(response: http.ServerResponse): SseClient
  broadcast(event: string, data?: Record<string, unknown>): void
  disconnectAll(): void
}

export interface BundleWatcher {
  stop(): void
}

export interface BundleWatchHandle {
  close(): void
  on?(event: "error", listener: (error: Error) => void): void
}

export interface BundleWatcherDeps {
  platform: NodeJS.Platform
  existsSync(targetPath: string): boolean
  watch(targetPath: string, options: { recursive: boolean }, listener: (eventType: string, filename: string | null) => void): BundleWatchHandle
  readdir(targetPath: string): Promise<Array<{ name: string; isDirectory(): boolean }>>
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

const DEFAULT_BUNDLE_WATCHER_DEPS: BundleWatcherDeps = {
  platform: process.platform,
  existsSync: fs.existsSync,
  watch: (targetPath, options, listener) => fs.watch(targetPath, options, listener),
  readdir: (targetPath) => fs.promises.readdir(targetPath, { withFileTypes: true }),
  setTimeout,
  clearTimeout,
}

export function createSseBroadcaster(): SseBroadcaster {
  let nextId = 1
  const clients = new Set<SseClient>()

  function add(response: http.ServerResponse): SseClient {
    const client: SseClient = { id: nextId++, response }
    clients.add(client)
    response.on("close", () => clients.delete(client))
    return client
  }

  function broadcast(event: string, data: Record<string, unknown> = {}): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of clients) {
      try {
        client.response.write(payload)
      } catch {
        clients.delete(client)
      }
    }
  }

  function disconnectAll(): void {
    for (const client of clients) {
      try {
        client.response.end()
      } catch {
        // The client may already have closed between the loop snapshot and end.
      }
    }
    clients.clear()
  }

  return { add, broadcast, disconnectAll }
}

export function createStateChangedBroadcast(sse: Pick<SseBroadcaster, "broadcast">): () => void {
  return () => {
    sse.broadcast("state-changed", { at: new Date().toISOString() })
  }
}

const BUNDLE_WATCH_DEBOUNCE_MS = 500

function closeQuietly(handle: BundleWatchHandle): void {
  try {
    handle.close()
  } catch {
    // Already closed.
  }
}

/**
 * Report "something under the bundles root changed" to Mailbox, debounced.
 *
 * On Linux, Node implements `fs.watch(root, { recursive: true })` in JavaScript: it stats and
 * inotify-watches every file in the tree before returning (7-10 s of blocked event loop for a
 * 12k-file bundle), and it answers every file event on a directory by re-reading that whole
 * directory. A host-side `chown -R` of a bundle holding directories of ~3.5k receipts therefore
 * keeps the daemon's event loop busy for ~150 s, long enough to fail the container healthcheck.
 *
 * So on Linux we watch each directory (not each file) non-recursively. The tree is discovered
 * with async readdir, and event callbacks never touch the filesystem: they only schedule a
 * debounced onChange, plus, for create/delete/rename events, a debounced async re-read of that
 * one directory to pick up added or removed subdirectories. macOS and Windows have a native
 * recursive watcher that is cheap, so they keep it.
 */
export function createBundleWatcher(
  bundlesRoot: string,
  onChange: () => void,
  deps: BundleWatcherDeps = DEFAULT_BUNDLE_WATCHER_DEPS,
): BundleWatcher {
  const watchers = new Map<string, BundleWatchHandle>()
  const pendingDirectories = new Set<string>()
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let rescanTimer: ReturnType<typeof setTimeout> | null = null
  let rescanRunning = false
  let stopped = false

  function debouncedOnChange(): void {
    if (debounceTimer) deps.clearTimeout(debounceTimer)
    debounceTimer = deps.setTimeout(onChange, BUNDLE_WATCH_DEBOUNCE_MS)
  }

  function watchPath(targetPath: string, recursive: boolean, listener: (eventType: string) => void): boolean {
    try {
      const handle = deps.watch(targetPath, { recursive }, listener)
      handle.on?.("error", () => {
        closeQuietly(handle)
        if (watchers.get(targetPath) === handle) watchers.delete(targetPath)
        debouncedOnChange()
      })
      watchers.set(targetPath, handle)
      return true
    } catch {
      // Watching is best-effort; manual broadcasts still keep Mailbox usable.
      return false
    }
  }

  function unwatchTree(directory: string): void {
    for (const [watched, handle] of watchers) {
      if (watched === directory || watched.startsWith(`${directory}${path.sep}`)) {
        closeQuietly(handle)
        watchers.delete(watched)
      }
    }
  }

  function scheduleRescan(directory: string): void {
    pendingDirectories.add(directory)
    if (rescanTimer) return
    rescanTimer = deps.setTimeout(() => {
      rescanTimer = null
      void drainRescans()
    }, BUNDLE_WATCH_DEBOUNCE_MS)
  }

  async function drainRescans(): Promise<void> {
    if (rescanRunning) return
    rescanRunning = true
    try {
      while (!stopped && pendingDirectories.size > 0) {
        const [directory] = pendingDirectories
        pendingDirectories.delete(directory!)
        await reconcileDirectory(directory!)
      }
    } finally {
      rescanRunning = false
    }
  }

  function watchDirectory(directory: string): boolean {
    return watchPath(directory, false, (eventType) => {
      debouncedOnChange()
      if (eventType === "rename") scheduleRescan(directory)
    })
  }

  async function reconcileDirectory(directory: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean }>
    try {
      entries = await deps.readdir(directory)
    } catch {
      unwatchTree(directory)
      return
    }
    if (stopped) return
    const subdirectories = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name)))
    for (const watched of [...watchers.keys()]) {
      if (path.dirname(watched) === directory && !subdirectories.has(watched)) unwatchTree(watched)
    }
    for (const subdirectory of subdirectories) {
      if (stopped) return
      if (watchers.has(subdirectory) || !watchDirectory(subdirectory)) continue
      await reconcileDirectory(subdirectory)
    }
  }

  if (deps.existsSync(bundlesRoot)) {
    if (deps.platform === "linux") {
      if (watchDirectory(bundlesRoot)) void reconcileDirectory(bundlesRoot)
    } else {
      watchPath(bundlesRoot, true, debouncedOnChange)
    }
  }

  return {
    stop() {
      stopped = true
      if (debounceTimer) deps.clearTimeout(debounceTimer)
      if (rescanTimer) deps.clearTimeout(rescanTimer)
      pendingDirectories.clear()
      for (const handle of watchers.values()) closeQuietly(handle)
      watchers.clear()
    },
  }
}
