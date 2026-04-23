import { describe, expect, it, vi } from "vitest"

type DnsRecordType = "A" | "AAAA" | "CNAME" | "MX" | "TXT"

interface DnsRecord {
  id?: string
  type: DnsRecordType
  name: string
  content: string
  ttl?: number
  priority?: number
}

interface DnsWorkflowBinding {
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
  certificate: {
    host: string
    source: "porkbun-ssl" | "acme-dns-01"
    storeItem: string
    acmeChallengeRecord: { type: "TXT"; name: string }
  }
}

interface DnsWorkflowSecrets {
  apiKey: string
  secretApiKey: string
}

interface VaultItemSecretReader {
  readSecretField: (item: string, field: string) => Promise<string>
  readNotes: (item: string) => Promise<string>
}

interface DnsWorkflowModule {
  loadDnsWorkflowBinding: (input: unknown) => DnsWorkflowBinding
  resolveDnsWorkflowSecrets: (binding: DnsWorkflowBinding, reader: VaultItemSecretReader) => Promise<DnsWorkflowSecrets>
  createPorkbunDnsDriver: (options: { baseUrl?: string; fetchImpl: typeof fetch }) => {
    ping: (secrets: DnsWorkflowSecrets) => Promise<{ credentialsValid: boolean }>
    retrieveRecords: (input: { domain: string; secrets: DnsWorkflowSecrets }) => Promise<DnsRecord[]>
    retrieveCertificate: (input: { domain: string; secrets: DnsWorkflowSecrets }) => Promise<{
      certificatechain: string
      publickey: string
      privatekey: string
    }>
  }
  planDnsWorkflow: (input: { binding: DnsWorkflowBinding; currentRecords: DnsRecord[] }) => {
    backup: { domain: string; records: DnsRecord[] }
    changes: Array<{ action: "create" | "update" | "delete"; record: DnsRecord; reason: string }>
    preservedRecords: DnsRecord[]
    certificateActions: Array<{ action: string; host: string; secretItem: string }>
  }
  redactDnsWorkflowArtifact: (input: unknown) => unknown
}

async function loadDnsWorkflowModule(): Promise<DnsWorkflowModule> {
  return await import("../../../heart/daemon/dns-workflow") as unknown as DnsWorkflowModule
}

function headerValue(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) return null
  if (headers instanceof Headers) return headers.get(name)
  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase())
    return found?.[1] ?? null
  }
  const lowerName = name.toLowerCase()
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)
  return found?.[1] ?? null
}

const ouroBotBinding: DnsWorkflowBinding = {
  workflow: "dns",
  domain: "ouro.bot",
  driver: "porkbun",
  credentialItem: "ops/registrars/porkbun/accounts/ari@mendelow.me",
  resources: {
    records: [
      { type: "A", name: "mx1" },
      { type: "MX", name: "@" },
      { type: "TXT", name: "@" },
      { type: "TXT", name: "_dmarc" },
      { type: "TXT", name: "_acme-challenge.mx1" },
    ],
  },
  desired: {
    records: [
      { type: "A", name: "mx1", content: "20.10.114.197", ttl: 600 },
      { type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10, ttl: 600 },
      { type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none; rua=mailto:dmarc@ouro.bot", ttl: 600 },
    ],
  },
  certificate: {
    host: "mx1.ouro.bot",
    source: "porkbun-ssl",
    storeItem: "runtime/mail/certificates/mx1.ouro.bot",
    acmeChallengeRecord: { type: "TXT", name: "_acme-challenge.mx1" },
  },
}

const currentRecords: DnsRecord[] = [
  { id: "mx-old", type: "MX", name: "@", content: "ouro-bot.mail.protection.outlook.com", priority: 0, ttl: 600 },
  { id: "google-verification", type: "TXT", name: "@", content: "google-site-verification=keep-this", ttl: 600 },
  { id: "microsoft-verification", type: "TXT", name: "@", content: "MS=ms-keep-this", ttl: 600 },
  { id: "www", type: "A", name: "www", content: "203.0.113.12", ttl: 600 },
]

describe("DNS workflow binding", () => {
  it("loads explicit binding fields without treating vault item notes as configuration", async () => {
    const { loadDnsWorkflowBinding } = await loadDnsWorkflowModule()

    expect(loadDnsWorkflowBinding(ouroBotBinding)).toMatchObject({
      domain: "ouro.bot",
      driver: "porkbun",
      credentialItem: "ops/registrars/porkbun/accounts/ari@mendelow.me",
    })
    expect(() => loadDnsWorkflowBinding({
      ...ouroBotBinding,
      credentialItemNoteQuery: "domain=ouro.bot driver=porkbun",
    })).toThrow("notes are not machine contracts")
    expect(() => loadDnsWorkflowBinding({
      ...ouroBotBinding,
      authority: "Porkbun account-level DNS credential",
    })).toThrow("workflow binding must not give a vault item assumed use")
  })

  it("resolves only required hidden fields from the referenced ordinary vault item", async () => {
    const { resolveDnsWorkflowSecrets } = await loadDnsWorkflowModule()
    const reader: VaultItemSecretReader = {
      readSecretField: vi.fn(async (_item, field) => field === "apiKey" ? "porkbun-api-key" : "porkbun-secret-key"),
      readNotes: vi.fn(async () => "Account-level key; do not parse this prose."),
    }

    await expect(resolveDnsWorkflowSecrets(ouroBotBinding, reader)).resolves.toEqual({
      apiKey: "porkbun-api-key",
      secretApiKey: "porkbun-secret-key",
    })
    expect(reader.readSecretField).toHaveBeenCalledTimes(2)
    expect(reader.readSecretField).toHaveBeenNthCalledWith(1, "ops/registrars/porkbun/accounts/ari@mendelow.me", "apiKey")
    expect(reader.readSecretField).toHaveBeenNthCalledWith(2, "ops/registrars/porkbun/accounts/ari@mendelow.me", "secretApiKey")
    expect(reader.readNotes).not.toHaveBeenCalled()
  })

  it("uses Porkbun read-only GET endpoints with header auth for ping, DNS retrieve, and SSL retrieve", async () => {
    const { createPorkbunDnsDriver } = await loadDnsWorkflowModule()
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/ping")) {
        return Response.json({ status: "SUCCESS", credentialsValid: true })
      }
      if (url.endsWith("/dns/retrieve/ouro.bot")) {
        return Response.json({ status: "SUCCESS", records: currentRecords })
      }
      return Response.json({
        status: "SUCCESS",
        certificatechain: "-----BEGIN CERTIFICATE-----\npublic-chain\n-----END CERTIFICATE-----",
        publickey: "-----BEGIN PUBLIC KEY-----\npublic-key\n-----END PUBLIC KEY-----",
        privatekey: "-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----",
      })
    }) as unknown as typeof fetch
    const driver = createPorkbunDnsDriver({ baseUrl: "https://api.test/json/v3", fetchImpl })
    const secrets = { apiKey: "porkbun-api-key", secretApiKey: "porkbun-secret-key" }

    await expect(driver.ping(secrets)).resolves.toEqual({ credentialsValid: true })
    await expect(driver.retrieveRecords({ domain: "ouro.bot", secrets })).resolves.toEqual(currentRecords)
    await expect(driver.retrieveCertificate({ domain: "ouro.bot", secrets })).resolves.toMatchObject({
      certificatechain: expect.stringContaining("BEGIN CERTIFICATE"),
      privatekey: expect.stringContaining("BEGIN PRIVATE KEY"),
    })

    const calls = vi.mocked(fetchImpl).mock.calls
    expect(calls.map(([url]) => url)).toEqual([
      "https://api.test/json/v3/ping",
      "https://api.test/json/v3/dns/retrieve/ouro.bot",
      "https://api.test/json/v3/ssl/retrieve/ouro.bot",
    ])
    for (const [, init] of calls) {
      const requestInit = init as RequestInit
      expect(requestInit.method).toBe("GET")
      expect(requestInit.body).toBeUndefined()
      expect(headerValue(requestInit.headers, "X-API-Key")).toBe("porkbun-api-key")
      expect(headerValue(requestInit.headers, "X-Secret-API-Key")).toBe("porkbun-secret-key")
    }
  })

  it("plans backup, dry-run changes, preservation, rollback inputs, and allowlist refusal", async () => {
    const { planDnsWorkflow } = await loadDnsWorkflowModule()
    const plan = planDnsWorkflow({ binding: ouroBotBinding, currentRecords })

    expect(plan.backup).toEqual({ domain: "ouro.bot", records: currentRecords })
    expect(plan.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "create", record: expect.objectContaining({ type: "A", name: "mx1", content: "20.10.114.197" }) }),
      expect.objectContaining({ action: "update", record: expect.objectContaining({ type: "MX", name: "@", content: "mx1.ouro.bot" }) }),
      expect.objectContaining({ action: "create", record: expect.objectContaining({ type: "TXT", name: "_dmarc" }) }),
    ]))
    expect(plan.preservedRecords).toEqual([
      currentRecords[1],
      currentRecords[2],
      currentRecords[3],
    ])
    expect(plan.certificateActions).toEqual([
      { action: "retrieve-and-store", host: "mx1.ouro.bot", secretItem: "runtime/mail/certificates/mx1.ouro.bot" },
    ])

    expect(() => planDnsWorkflow({
      binding: {
        ...ouroBotBinding,
        desired: {
          records: [
            ...ouroBotBinding.desired.records,
            { type: "CNAME", name: "unapproved", content: "elsewhere.example", ttl: 600 },
          ],
        },
      },
      currentRecords,
    })).toThrow("outside DNS workflow allowlist")
  })

  it("redacts secrets and certificate private keys from workflow artifacts", async () => {
    const { redactDnsWorkflowArtifact } = await loadDnsWorkflowModule()
    const redacted = redactDnsWorkflowArtifact({
      binding: ouroBotBinding,
      secrets: { apiKey: "porkbun-api-key", secretApiKey: "porkbun-secret-key" },
      providerRequest: {
        headers: {
          "X-API-Key": "porkbun-api-key",
          "X-Secret-API-Key": "porkbun-secret-key",
        },
      },
      certificate: {
        certificatechain: "-----BEGIN CERTIFICATE-----\npublic-chain\n-----END CERTIFICATE-----",
        publickey: "-----BEGIN PUBLIC KEY-----\npublic-key\n-----END PUBLIC KEY-----",
        privatekey: "-----BEGIN PRIVATE KEY-----\nprivate-key\n-----END PRIVATE KEY-----",
      },
    })
    const serialized = JSON.stringify(redacted)

    expect(serialized).toContain("mx1.ouro.bot")
    expect(serialized).toContain("20.10.114.197")
    expect(serialized).not.toContain("porkbun-api-key")
    expect(serialized).not.toContain("porkbun-secret-key")
    expect(serialized).not.toContain("private-key")
    expect(serialized).not.toContain("BEGIN PRIVATE KEY")
  })
})
