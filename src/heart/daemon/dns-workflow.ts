export type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT"

export interface DnsRecord {
  id?: string
  type: DnsRecordType
  name: string
  content: string
  ttl?: number
  priority?: number
}

export interface DnsWorkflowBinding {
  workflow: "dns"
  domain: string
  driver: "porkbun"
  credentialItem: string
  resources: {
    records: Array<{ type: DnsRecordType; name: string }>
  }
  desired: {
    records: DnsRecord[]
  }
  certificate?: {
    host: string
    source: "porkbun-ssl" | "acme-dns-01"
    storeItem: string
    acmeChallengeRecord?: { type: "TXT"; name: string }
  }
}

export interface DnsWorkflowSecrets {
  apiKey: string
  secretApiKey: string
}

export interface VaultItemSecretReader {
  readSecretField: (item: string, field: string) => Promise<string>
  readNotes?: (item: string) => Promise<string>
}

export interface DnsWorkflowPlan {
  backup: { domain: string; records: DnsRecord[] }
  changes: Array<{ action: "create" | "update" | "delete"; record: DnsRecord; reason: string; currentRecord?: DnsRecord }>
  preservedRecords: DnsRecord[]
  certificateActions: Array<{ action: string; host: string; secretItem: string }>
}

interface PorkbunResponse {
  status?: string
  message?: string
  credentialsValid?: boolean
  records?: DnsRecord[]
  certificatechain?: string
  publickey?: string
  privatekey?: string
}

function isRecordType(value: unknown): value is DnsRecordType {
  return value === "A" || value === "AAAA" || value === "CNAME" || value === "MX" || value === "TXT"
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`)
  return value.trim()
}

function requireRecordType(value: unknown, label: string): DnsRecordType {
  if (!isRecordType(value)) throw new Error(`${label} must be A, AAAA, CNAME, MX, or TXT`)
  return value
}

function recordKey(record: Pick<DnsRecord, "type" | "name">): string {
  return `${record.type}:${record.name}`
}

function parseRecord(input: unknown, label: string): DnsRecord {
  const value = input as Record<string, unknown>
  const record: DnsRecord = {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    type: requireRecordType(value.type, `${label}.type`),
    name: requireString(value.name, `${label}.name`),
    content: requireString(value.content, `${label}.content`),
    ...(typeof value.ttl === "number" ? { ttl: value.ttl } : {}),
    ...(typeof value.priority === "number" ? { priority: value.priority } : {}),
  }
  return record
}

function parseResourceRecord(input: unknown, label: string): { type: DnsRecordType; name: string } {
  const value = input as Record<string, unknown>
  return {
    type: requireRecordType(value.type, `${label}.type`),
    name: requireString(value.name, `${label}.name`),
  }
}

function assertNoCredentialOntology(input: Record<string, unknown>): void {
  if ("credentialItemNoteQuery" in input || "noteQuery" in input || "notes" in input) {
    throw new Error("notes are not machine contracts")
  }
  if ("authority" in input || "kind" in input) {
    throw new Error("workflow binding must not give a vault item assumed use")
  }
}

export function loadDnsWorkflowBinding(input: unknown): DnsWorkflowBinding {
  if (!input || typeof input !== "object") throw new Error("DNS workflow binding must be an object")
  const value = input as Record<string, unknown>
  assertNoCredentialOntology(value)
  if (value.workflow !== "dns") throw new Error("DNS workflow binding must set workflow to dns")
  if (value.driver !== "porkbun") throw new Error("DNS workflow binding driver must be porkbun")
  const resources = value.resources as { records?: unknown[] } | undefined
  const desired = value.desired as { records?: unknown[] } | undefined
  if (!Array.isArray(resources?.records) || resources.records.length === 0) {
    throw new Error("DNS workflow binding requires a resource allowlist")
  }
  if (!Array.isArray(desired?.records)) throw new Error("DNS workflow binding requires desired records")
  const certificate = value.certificate as Record<string, unknown> | undefined
  return {
    workflow: "dns",
    domain: requireString(value.domain, "domain"),
    driver: "porkbun",
    credentialItem: requireString(value.credentialItem, "credentialItem"),
    resources: {
      records: resources.records.map((record, index) => parseResourceRecord(record, `resources.records[${index}]`)),
    },
    desired: {
      records: desired.records.map((record, index) => parseRecord(record, `desired.records[${index}]`)),
    },
    ...(certificate ? {
      certificate: {
        host: requireString(certificate.host, "certificate.host"),
        source: certificate.source === "acme-dns-01" ? "acme-dns-01" : "porkbun-ssl",
        storeItem: requireString(certificate.storeItem, "certificate.storeItem"),
        ...(certificate.acmeChallengeRecord
          ? {
              acmeChallengeRecord: parseResourceRecord(certificate.acmeChallengeRecord, "certificate.acmeChallengeRecord") as { type: "TXT"; name: string },
            }
          : {}),
      },
    } : {}),
  }
}

export async function resolveDnsWorkflowSecrets(
  binding: DnsWorkflowBinding,
  reader: VaultItemSecretReader,
): Promise<DnsWorkflowSecrets> {
  return {
    apiKey: await reader.readSecretField(binding.credentialItem, "apiKey"),
    secretApiKey: await reader.readSecretField(binding.credentialItem, "secretApiKey"),
  }
}

async function readPorkbunJson(response: Response): Promise<PorkbunResponse> {
  const payload = await response.json() as PorkbunResponse
  if (!response.ok || payload.status === "ERROR") {
    throw new Error(payload.message ?? `Porkbun request failed with status ${response.status}`)
  }
  return payload
}

function porkbunHeaders(secrets: DnsWorkflowSecrets): Record<string, string> {
  return {
    "X-API-Key": secrets.apiKey,
    "X-Secret-API-Key": secrets.secretApiKey,
  }
}

export function createPorkbunDnsDriver(options: { baseUrl?: string; fetchImpl: typeof fetch }): {
  ping: (secrets: DnsWorkflowSecrets) => Promise<{ credentialsValid: boolean }>
  retrieveRecords: (input: { domain: string; secrets: DnsWorkflowSecrets }) => Promise<DnsRecord[]>
  retrieveCertificate: (input: { domain: string; secrets: DnsWorkflowSecrets }) => Promise<{
    certificatechain: string
    publickey: string
    privatekey: string
  }>
} {
  const baseUrl = (options.baseUrl ?? "https://api.porkbun.com/api/json/v3").replace(/\/+$/, "")
  const readOnly = async (path: string, secrets: DnsWorkflowSecrets): Promise<PorkbunResponse> => {
    return readPorkbunJson(await options.fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers: porkbunHeaders(secrets),
    }))
  }
  return {
    async ping(secrets) {
      const payload = await readOnly("/ping", secrets)
      return { credentialsValid: payload.credentialsValid === true }
    },
    async retrieveRecords({ domain, secrets }) {
      const payload = await readOnly(`/dns/retrieve/${encodeURIComponent(domain)}`, secrets)
      return payload.records ?? []
    },
    async retrieveCertificate({ domain, secrets }) {
      const payload = await readOnly(`/ssl/retrieve/${encodeURIComponent(domain)}`, secrets)
      return {
        certificatechain: requireString(payload.certificatechain, "certificatechain"),
        publickey: requireString(payload.publickey, "publickey"),
        privatekey: requireString(payload.privatekey, "privatekey"),
      }
    },
  }
}

function assertDesiredRecordsAllowed(binding: DnsWorkflowBinding): void {
  const allowed = new Set(binding.resources.records.map(recordKey))
  for (const desired of binding.desired.records) {
    if (!allowed.has(recordKey(desired))) throw new Error("desired DNS record is outside DNS workflow allowlist")
  }
}

function recordsEqual(left: DnsRecord, right: DnsRecord): boolean {
  return left.type === right.type &&
    left.name === right.name &&
    left.content === right.content &&
    left.ttl === right.ttl &&
    left.priority === right.priority
}

export function planDnsWorkflow(input: { binding: DnsWorkflowBinding; currentRecords: DnsRecord[] }): DnsWorkflowPlan {
  assertDesiredRecordsAllowed(input.binding)
  const desiredKeys = new Set(input.binding.desired.records.map(recordKey))
  const changes: DnsWorkflowPlan["changes"] = []
  for (const desired of input.binding.desired.records) {
    const current = input.currentRecords.find((record) => recordKey(record) === recordKey(desired))
    if (!current) {
      changes.push({ action: "create", record: desired, reason: "desired record is missing" })
    } else if (!recordsEqual(current, desired)) {
      changes.push({ action: "update", record: desired, currentRecord: current, reason: "desired record differs from current provider record" })
    }
  }
  const preservedRecords = input.currentRecords.filter((record) => !desiredKeys.has(recordKey(record)))
  return {
    backup: { domain: input.binding.domain, records: input.currentRecords },
    changes,
    preservedRecords,
    certificateActions: input.binding.certificate
      ? [{
          action: "retrieve-and-store",
          host: input.binding.certificate.host,
          secretItem: input.binding.certificate.storeItem,
        }]
      : [],
  }
}

function redactedValueForKey(key: string, value: unknown): unknown | undefined {
  const normalized = key.toLowerCase()
  if (normalized === "apikey" || normalized === "secretapikey" || normalized === "x-api-key" || normalized === "x-secret-api-key") {
    return "[redacted]"
  }
  if (normalized === "privatekey" || normalized === "privatekeypem" || normalized === "privatekeypath") {
    return "[redacted]"
  }
  if (typeof value === "string" && value.includes("BEGIN PRIVATE KEY")) {
    return "[redacted]"
  }
  return undefined
}

export function redactDnsWorkflowArtifact(input: unknown): unknown {
  if (Array.isArray(input)) return input.map((item) => redactDnsWorkflowArtifact(item))
  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input)) {
      output[key] = redactedValueForKey(key, value) ?? redactDnsWorkflowArtifact(value)
    }
    return output
  }
  if (typeof input === "string" && input.includes("BEGIN PRIVATE KEY")) return "[redacted]"
  return input
}
