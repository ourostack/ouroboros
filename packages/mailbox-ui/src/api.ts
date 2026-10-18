const BASE = "/api"

export async function fetchJson<T>(path: string, options?: { signal?: AbortSignal }): Promise<T> {
  const response = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" }, signal: options?.signal })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  return response.json() as Promise<T>
}

export type ConnectionState = "connecting" | "connected" | "reconnecting"

export function subscribeToEvents(
  onEvent: (event: string, data: unknown) => void,
  onConnectionState?: (state: ConnectionState) => void,
): () => void {
  const source = new EventSource(`${BASE}/events`)
  let closed = false
  onConnectionState?.("connecting")

  const changed = (e: Event) => {
    if (closed || !(e instanceof MessageEvent)) return
    try {
      const data: unknown = JSON.parse(e.data)
      onEvent("state-changed", data)
    } catch {
      onEvent("state-changed", {})
    }
  }
  source.addEventListener("state-changed", changed)

  source.onopen = () => {
    if (closed) return
    onConnectionState?.("connected")
    onEvent("connected", {})
  }
  source.onerror = () => {
    if (!closed) onConnectionState?.("reconnecting")
  }

  return () => {
    closed = true
    source.removeEventListener("state-changed", changed)
    source.onopen = null
    source.onerror = null
    source.close()
  }
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "unknown"
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return "just now"
  if (ms < 60_000) return "just now"
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export function truncate(str: string | null | undefined, max: number): string {
  if (!str) return ""
  if (str.length <= max) return str
  const cut = str.lastIndexOf(" ", max)
  return (cut > max * 0.6 ? str.slice(0, cut) : str.slice(0, max)) + "\u2026"
}
