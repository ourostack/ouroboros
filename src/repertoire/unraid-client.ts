import { emitNervesEvent } from "../nerves/runtime"

export type UnraidErrorCode = "unauthorized" | "forbidden" | "timeout" | "transport" | "graphql" | "invalid_response"

export class UnraidClientError extends Error {
  constructor(
    readonly code: UnraidErrorCode,
    message: string,
    readonly ambiguous = false,
    options: { cause?: unknown } = {},
  ) {
    super(limitUtf8(message, 240), options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "UnraidClientError"
  }
}

type UnraidFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface UnraidClientOptions {
  endpoint: string
  apiKey: string
  fetch?: UnraidFetch
  sleep?: (milliseconds: number) => Promise<void>
  readTimeoutMs?: number
  mutationTimeoutMs?: number
}

function limitUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8")
  if (bytes.length <= maxBytes) return value
  return bytes.subarray(0, Math.max(0, maxBytes - 3)).toString("utf8").replace(/\uFFFD+$/u, "") + "..."
}

function canonicalEndpoint(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error("Unraid GraphQL endpoint is invalid") }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) {
    throw new Error("Unraid GraphQL endpoint is invalid")
  }
  return url.toString()
}

function statusError(status: number): UnraidClientError {
  if (status === 401) return new UnraidClientError("unauthorized", "Unraid GraphQL request was unauthorized")
  if (status === 403) return new UnraidClientError("forbidden", "Unraid GraphQL request was forbidden")
  return new UnraidClientError("transport", `Unraid GraphQL request failed with HTTP ${status}`)
}

export class UnraidClient {
  private readonly endpoint: string
  private readonly apiKey: string
  private readonly fetchImpl: UnraidFetch
  private readonly sleep: (milliseconds: number) => Promise<void>
  private readonly readTimeoutMs: number
  private readonly mutationTimeoutMs: number

  constructor(options: UnraidClientOptions) {
    this.endpoint = canonicalEndpoint(options.endpoint)
    this.apiKey = options.apiKey.trim()
    if (!this.apiKey) throw new Error("Unraid API key is missing")
    this.fetchImpl = options.fetch ?? fetch
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    this.readTimeoutMs = options.readTimeoutMs ?? 10_000
    this.mutationTimeoutMs = options.mutationTimeoutMs ?? 15_000
  }

  static assertPrefixedId(value: string): string {
    if (Buffer.byteLength(value, "utf8") > 256 || !/^[^:]+:[^:]+$/u.test(value)) {
      throw new Error("Unraid identifier must be one bounded prefixed ID")
    }
    return value
  }

  read<T extends Record<string, unknown>>(document: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.execute<T>("read", document, variables, signal)
  }

  mutate<T extends Record<string, unknown>>(document: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    return this.execute<T>("mutation", document, variables, signal)
  }

  private async execute<T extends Record<string, unknown>>(
    kind: "read" | "mutation",
    document: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.unraid_request_start",
      message: "Unraid GraphQL request started",
      meta: { kind },
    })
    const delays = [250, 1000]
    const maxAttempts = kind === "read" ? 3 : 1
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const timeout = AbortSignal.timeout(kind === "read" ? this.readTimeoutMs : this.mutationTimeoutMs)
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      let response: Response
      try {
        response = await this.fetchImpl(this.endpoint, {
          method: "POST",
          headers: { "x-api-key": this.apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({ query: document, variables }),
          signal: requestSignal,
        })
      } catch (error) {
        const timedOut = timeout.aborted && !signal?.aborted
        if (kind === "read" && !timedOut && !signal?.aborted && attempt < maxAttempts - 1) {
          await this.sleep(delays[attempt]!)
          continue
        }
        const normalized = new UnraidClientError(
          timedOut ? "timeout" : "transport",
          timedOut ? "Unraid GraphQL request timed out" : "Unraid GraphQL transport failed",
          kind === "mutation" && !timedOut,
          { cause: error },
        )
        this.emitError(kind, normalized)
        throw normalized
      }
      if (!response.ok) {
        if (kind === "read" && [429, 502, 503, 504].includes(response.status) && attempt < maxAttempts - 1) {
          await this.sleep(delays[attempt]!)
          continue
        }
        const error = statusError(response.status)
        this.emitError(kind, error)
        throw error
      }
      let envelope: unknown
      try { envelope = await response.json() } catch (cause) {
        const error = new UnraidClientError("invalid_response", "Unraid GraphQL returned invalid JSON", false, { cause })
        this.emitError(kind, error)
        throw error
      }
      if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
        const error = new UnraidClientError("invalid_response", "Unraid GraphQL response envelope is invalid")
        this.emitError(kind, error)
        throw error
      }
      const record = envelope as Record<string, unknown>
      if (Array.isArray(record.errors) && record.errors.length > 0) {
        const error = new UnraidClientError("graphql", "Unraid GraphQL operation failed")
        this.emitError(kind, error)
        throw error
      }
      if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
        const error = new UnraidClientError("invalid_response", "Unraid GraphQL response omitted data")
        this.emitError(kind, error)
        throw error
      }
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.unraid_request_end",
        message: "Unraid GraphQL request completed",
        meta: { kind, attempt: attempt + 1 },
      })
      return record.data as T
    }
    /* v8 ignore next -- @preserve The finite loop's last attempt always returns or throws; this is a defensive exhaustiveness guard. */
    throw new UnraidClientError("transport", "Unraid GraphQL retry budget exhausted")
  }

  private emitError(kind: "read" | "mutation", error: UnraidClientError): void {
    emitNervesEvent({
      level: "error",
      component: "repertoire",
      event: "repertoire.unraid_request_error",
      message: "Unraid GraphQL request failed",
      meta: { kind, code: error.code, ambiguous: error.ambiguous },
    })
  }
}
