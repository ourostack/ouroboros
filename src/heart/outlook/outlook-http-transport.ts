import * as fs from "fs"
import * as http from "http"

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

export interface BundleWatcherDeps {
  existsSync(targetPath: string): boolean
  watch(targetPath: string, options: { recursive: true }, listener: fs.WatchListener<string>): { close(): void }
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

const DEFAULT_BUNDLE_WATCHER_DEPS: BundleWatcherDeps = {
  existsSync: fs.existsSync,
  watch: fs.watch,
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

export function createBundleWatcher(
  bundlesRoot: string,
  onChange: () => void,
  deps: BundleWatcherDeps = DEFAULT_BUNDLE_WATCHER_DEPS,
): BundleWatcher {
  const watchers: Array<{ close(): void }> = []
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  const debounceMs = 500

  function debouncedOnChange(): void {
    if (debounceTimer) deps.clearTimeout(debounceTimer)
    debounceTimer = deps.setTimeout(onChange, debounceMs)
  }

  try {
    if (deps.existsSync(bundlesRoot)) {
      watchers.push(deps.watch(bundlesRoot, { recursive: true }, debouncedOnChange))
    }
  } catch {
    // Watching is best-effort; manual broadcasts still keep Outlook usable.
  }

  return {
    stop() {
      if (debounceTimer) deps.clearTimeout(debounceTimer)
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
          // Already closed.
        }
      }
      watchers.length = 0
    },
  }
}
