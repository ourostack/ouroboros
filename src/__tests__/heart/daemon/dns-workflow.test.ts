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
    createRecord: (input: { domain: string; secrets: DnsWorkflowSecrets; record: DnsRecord }) => Promise<{ id?: string }>
    editRecord: (input: { domain: string; secrets: DnsWorkflowSecrets; id: string; record: DnsRecord }) => Promise<void>
    deleteRecord: (input: { domain: string; secrets: DnsWorkflowSecrets; id: string }) => Promise<void>
  }
  planDnsWorkflow: (input: { binding: DnsWorkflowBinding; currentRecords: DnsRecord[]; deleteExtraAllowedRecords?: boolean }) => {
    backup: { domain: string; records: DnsRecord[] }
    changes: Array<{ action: "create" | "update" | "delete"; record: DnsRecord; reason: string; currentRecord?: DnsRecord }>
    preservedRecords: DnsRecord[]
    certificateActions: Array<{ action: string; host: string; secretItem: string }>
  }
  planDnsRollback: (input: { binding: DnsWorkflowBinding; currentRecords: DnsRecord[]; backupRecords: DnsRecord[] }) => {
    backup: { domain: string; records: DnsRecord[] }
    changes: Array<{ action: "create" | "update" | "delete"; record: DnsRecord; reason: string; currentRecord?: DnsRecord }>
    preservedRecords: DnsRecord[]
    certificateActions: Array<{ action: string; host: string; secretItem: string }>
  }
  applyDnsWorkflowPlan: (input: {
    driver: {
      createRecord: (input: { domain: string; secrets: DnsWorkflowSecrets; record: DnsRecord }) => Promise<{ id?: string }>
      editRecord: (input: { domain: string; secrets: DnsWorkflowSecrets; id: string; record: DnsRecord }) => Promise<void>
      deleteRecord: (input: { domain: string; secrets: DnsWorkflowSecrets; id: string }) => Promise<void>
    }
    domain: string
    secrets: DnsWorkflowSecrets
    plan: {
      changes: Array<{ action: "create" | "update" | "delete"; record: DnsRecord; reason: string; currentRecord?: DnsRecord }>
    }
  }) => Promise<Array<{ action: "create" | "update" | "delete"; record: DnsRecord; id?: string }>>
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

  it("rejects malformed bindings before any provider or vault lookup", async () => {
    const { loadDnsWorkflowBinding } = await loadDnsWorkflowModule()

    expect(() => loadDnsWorkflowBinding(null)).toThrow("DNS workflow binding must be an object")
    expect(() => loadDnsWorkflowBinding({ ...ouroBotBinding, workflow: "mail" })).toThrow("workflow to dns")
    expect(() => loadDnsWorkflowBinding({ ...ouroBotBinding, driver: "dnsimple" })).toThrow("driver must be porkbun")
    expect(() => loadDnsWorkflowBinding({ ...ouroBotBinding, resources: { records: [] } })).toThrow("resource allowlist")
    expect(() => loadDnsWorkflowBinding({ ...ouroBotBinding, desired: {} })).toThrow("desired records")
    expect(() => loadDnsWorkflowBinding({ ...ouroBotBinding, domain: "   " })).toThrow("domain is required")
    expect(() => loadDnsWorkflowBinding({
      ...ouroBotBinding,
      resources: { records: [{ type: "SRV", name: "mx1" }] },
    })).toThrow("resources.records[0].type")
    expect(() => loadDnsWorkflowBinding({
      ...ouroBotBinding,
      desired: { records: [{ type: "A", name: "mx1", content: " " }] },
    })).toThrow("desired.records[0].content")
    expect(loadDnsWorkflowBinding({
      ...ouroBotBinding,
      desired: { records: [{ id: "desired-id", type: "A", name: "mx1", content: "20.10.114.197" }] },
      certificate: undefined,
    })).toMatchObject({
      desired: { records: [{ id: "desired-id", type: "A", name: "mx1", content: "20.10.114.197" }] },
    })
    expect(loadDnsWorkflowBinding({
      ...ouroBotBinding,
      certificate: {
        host: "mx1.ouro.bot",
        source: "acme-dns-01",
        storeItem: "runtime/mail/certificates/mx1.ouro.bot",
      },
    })).toMatchObject({ certificate: { source: "acme-dns-01" } })
    expect(loadDnsWorkflowBinding({
      ...ouroBotBinding,
      certificate: {
        host: "mx1.ouro.bot",
        storeItem: "runtime/mail/certificates/mx1.ouro.bot",
      },
    })).toMatchObject({ certificate: { source: "porkbun-ssl" } })
    expect(() => loadDnsWorkflowBinding({
      ...ouroBotBinding,
      certificate: {
        ...ouroBotBinding.certificate,
        source: "manual-upload",
      },
    })).toThrow("certificate.source must be porkbun-ssl or acme-dns-01")
  })

  it("uses Porkbun read-only GET endpoints with header auth for ping, DNS retrieve, and SSL retrieve", async () => {
    const { createPorkbunDnsDriver } = await loadDnsWorkflowModule()
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/ping")) {
        return Response.json({ status: "SUCCESS", credentialsValid: true })
      }
      if (url.endsWith("/dns/retrieve/ouro.bot")) {
        return Response.json({
          status: "SUCCESS",
          records: [
            { id: "mx-old", type: "MX", name: "ouro.bot", content: "ouro-bot.mail.protection.outlook.com", ttl: "600", prio: "0" },
            { id: "autodiscover", type: "CNAME", name: "autodiscover.ouro.bot", content: "autodiscover.outlook.com", ttl: 300, prio: null },
            { type: "A", name: "www", content: "203.0.113.12", prio: "" },
          ],
        })
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
    await expect(driver.retrieveRecords({ domain: "ouro.bot", secrets })).resolves.toEqual([
      { id: "mx-old", type: "MX", name: "@", content: "ouro-bot.mail.protection.outlook.com", ttl: 600, priority: 0 },
      { id: "autodiscover", type: "CNAME", name: "autodiscover", content: "autodiscover.outlook.com", ttl: 300 },
      { type: "A", name: "www", content: "203.0.113.12" },
    ])
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

  it("uses Porkbun mutation endpoints with redaction-friendly header auth and provider errors", async () => {
    const { createPorkbunDnsDriver } = await loadDnsWorkflowModule()
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/dns/create/ouro.bot")) return Response.json({ status: "SUCCESS", id: "created-a" })
      if (url.endsWith("/dns/create/no-id.bot")) return Response.json({ status: "SUCCESS" })
      if (url.endsWith("/dns/edit/ouro.bot/mx-old")) return Response.json({ status: "SUCCESS" })
      if (url.endsWith("/dns/delete/ouro.bot/stale")) return Response.json({ status: "SUCCESS" })
      if (url.endsWith("/dns/retrieve/empty.bot")) return Response.json({ status: "SUCCESS" })
      if (url.endsWith("/dns/retrieve/rate-limited.bot")) {
        return new Response(JSON.stringify({ status: "ERROR", message: "rate limit exceeded" }), { status: 429 })
      }
      return new Response(JSON.stringify({ status: "ERROR" }), { status: 500 })
    }) as unknown as typeof fetch
    const driver = createPorkbunDnsDriver({ baseUrl: "https://api.test/json/v3/", fetchImpl })
    const secrets = { apiKey: "porkbun-api-key", secretApiKey: "porkbun-secret-key" }

    await expect(driver.createRecord({ domain: "ouro.bot", secrets, record: { type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10 } }))
      .resolves.toEqual({ id: "created-a" })
    await expect(driver.createRecord({ domain: "no-id.bot", secrets, record: { type: "A", name: "mx1", content: "20.10.114.197" } }))
      .resolves.toEqual({})
    await expect(driver.editRecord({ domain: "ouro.bot", secrets, id: "mx-old", record: { type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10 } }))
      .resolves.toBeUndefined()
    await expect(driver.deleteRecord({ domain: "ouro.bot", secrets, id: "stale" }))
      .resolves.toBeUndefined()
    await expect(driver.retrieveRecords({ domain: "empty.bot", secrets }))
      .resolves.toEqual([])
    await expect(driver.retrieveRecords({ domain: "rate-limited.bot", secrets }))
      .rejects.toThrow("rate limit exceeded")
    await expect(driver.deleteRecord({ domain: "broken.bot", secrets, id: "stale" }))
      .rejects.toThrow("Porkbun request failed with status 500")

    const [createUrl, createInit] = vi.mocked(fetchImpl).mock.calls[0]
    expect(createUrl).toBe("https://api.test/json/v3/dns/create/ouro.bot")
    expect(createInit?.method).toBe("POST")
    expect(headerValue(createInit?.headers, "X-API-Key")).toBe("porkbun-api-key")
    expect(headerValue(createInit?.headers, "X-Secret-API-Key")).toBe("porkbun-secret-key")
    expect(JSON.parse(String(createInit?.body))).toEqual({
      type: "MX",
      name: "",
      content: "mx1.ouro.bot",
      ttl: 600,
      prio: 10,
    })
    expect(String(createInit?.body)).not.toContain("porkbun-api-key")
    expect(String(createInit?.body)).not.toContain("porkbun-secret-key")
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

    expect(planDnsWorkflow({
      binding: {
        ...ouroBotBinding,
        desired: { records: [currentRecords[0]] },
        certificate: undefined,
      },
      currentRecords: [currentRecords[0]],
    })).toMatchObject({
      changes: [],
      certificateActions: [],
    })

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

  it("ignores Porkbun priority zero on non-MX records during verification planning", async () => {
    const { planDnsWorkflow } = await loadDnsWorkflowModule()
    const plan = planDnsWorkflow({
      binding: {
        ...ouroBotBinding,
        desired: {
          records: [
            { type: "A", name: "mx1", content: "20.10.114.197", ttl: 600 },
            { type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none; rua=mailto:dmarc@ouro.bot", ttl: 600 },
          ],
        },
      },
      currentRecords: [
        { id: "a", type: "A", name: "mx1", content: "20.10.114.197", ttl: 600, priority: 0 },
        { id: "txt", type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none; rua=mailto:dmarc@ouro.bot", ttl: 600, priority: 0 },
      ],
    })

    expect(plan.changes).toEqual([])
  })

  it("creates sibling verification records without rewriting unrelated same-name TXT records", async () => {
    const { planDnsRollback, planDnsWorkflow } = await loadDnsWorkflowModule()
    const googleTxt = { id: "google", type: "TXT" as const, name: "@", content: "google-site-verification=keep-this", ttl: 600 }
    const spfTxt = { id: "spf", type: "TXT" as const, name: "@", content: "v=spf1 include:spf.protection.outlook.com -all", ttl: 600 }
    const domainTxt = { type: "TXT" as const, name: "@", content: "ms-domain-verification=abc", ttl: 3600 }
    const binding = {
      ...ouroBotBinding,
      resources: { records: [{ type: "TXT" as const, name: "@" }] },
      desired: { records: [spfTxt, domainTxt] },
      certificate: undefined,
    }

    const plan = planDnsWorkflow({
      binding,
      currentRecords: [googleTxt, spfTxt],
    })

    expect(plan.changes).toEqual([
      { action: "create", record: domainTxt, reason: "desired record is missing" },
    ])
    expect(plan.preservedRecords).toEqual([googleTxt])

    const rollbackPlan = planDnsRollback({
      binding,
      currentRecords: [googleTxt, spfTxt, { ...domainTxt, id: "domain" }],
      backupRecords: [googleTxt, spfTxt],
    })

    expect(rollbackPlan.changes).toEqual([
      {
        action: "delete",
        record: { ...domainTxt, id: "domain" },
        currentRecord: { ...domainTxt, id: "domain" },
        reason: "allowlisted record is absent from rollback backup",
      },
    ])
  })

  it("normalizes MX priority zero but still updates mismatched MX priorities", async () => {
    const { planDnsWorkflow } = await loadDnsWorkflowModule()
    const binding = {
      ...ouroBotBinding,
      desired: {
        records: [
          { type: "MX", name: "@", content: "mx1.ouro.bot", ttl: 600 },
        ],
      },
    }

    expect(planDnsWorkflow({
      binding,
      currentRecords: [
        { id: "mx", type: "MX", name: "@", content: "mx1.ouro.bot", ttl: 600, priority: 0 },
      ],
    }).changes).toEqual([])

    expect(planDnsWorkflow({
      binding,
      currentRecords: [
        { id: "mx", type: "MX", name: "@", content: "mx1.ouro.bot", ttl: 600 },
      ],
    }).changes).toEqual([])

    expect(planDnsWorkflow({
      binding: {
        ...binding,
        desired: {
          records: [
            { type: "MX", name: "@", content: "mx1.ouro.bot", ttl: 600, priority: 0 },
          ],
        },
      },
      currentRecords: [
        { id: "mx", type: "MX", name: "@", content: "mx1.ouro.bot", ttl: 600 },
      ],
    }).changes).toEqual([])

    expect(planDnsWorkflow({
      binding: {
        ...binding,
        desired: {
          records: [
            { type: "MX", name: "@", content: "mx1.ouro.bot", ttl: 600, priority: 10 },
          ],
        },
      },
      currentRecords: [
        { id: "mx", type: "MX", name: "@", content: "mx1.ouro.bot", ttl: 600 },
      ],
    }).changes).toEqual([
      expect.objectContaining({ action: "update", currentRecord: expect.objectContaining({ id: "mx" }) }),
    ])

    expect(planDnsWorkflow({
      binding,
      currentRecords: [
        { id: "mx", type: "MX", name: "@", content: "mx1.ouro.bot", ttl: 600, priority: 5 },
      ],
    }).changes).toEqual([
      expect.objectContaining({ action: "update", currentRecord: expect.objectContaining({ id: "mx" }) }),
    ])
  })

  it("plans and applies rollback changes only for allowlisted records", async () => {
    const { applyDnsWorkflowPlan, planDnsRollback, planDnsWorkflow } = await loadDnsWorkflowModule()
    const rollbackPlan = planDnsRollback({
      binding: ouroBotBinding,
      currentRecords: [
        { id: "mx-new", type: "MX", name: "@", content: "mx1.ouro.bot", priority: 10, ttl: 600 },
        { id: "mx1-a", type: "A", name: "mx1", content: "20.10.114.197", ttl: 600 },
        { id: "dmarc", type: "TXT", name: "_dmarc", content: "v=DMARC1; p=none", ttl: 600 },
        { id: "www", type: "A", name: "www", content: "203.0.113.12", ttl: 600 },
      ],
      backupRecords: currentRecords,
    })

    expect(rollbackPlan.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "update", record: expect.objectContaining({ type: "MX", name: "@", content: "ouro-bot.mail.protection.outlook.com" }) }),
      expect.objectContaining({ action: "delete", record: expect.objectContaining({ type: "A", name: "mx1" }) }),
      expect.objectContaining({ action: "delete", record: expect.objectContaining({ type: "TXT", name: "_dmarc" }) }),
    ]))
    expect(rollbackPlan.changes).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ record: expect.objectContaining({ name: "www" }) }),
    ]))

    const driver = {
      createRecord: vi.fn(async () => ({ id: "created" })),
      editRecord: vi.fn(async () => undefined),
      deleteRecord: vi.fn(async () => undefined),
    }
    await expect(applyDnsWorkflowPlan({
      driver,
      domain: "ouro.bot",
      secrets: { apiKey: "porkbun-api-key", secretApiKey: "porkbun-secret-key" },
      plan: rollbackPlan,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "update", id: "mx-new" }),
      expect.objectContaining({ action: "delete", id: "mx1-a" }),
      expect.objectContaining({ action: "delete", id: "dmarc" }),
    ]))
    expect(driver.editRecord).toHaveBeenCalledWith(expect.objectContaining({ id: "mx-new" }))
    expect(driver.deleteRecord).toHaveBeenCalledTimes(2)

    await expect(applyDnsWorkflowPlan({
      driver,
      domain: "ouro.bot",
      secrets: { apiKey: "porkbun-api-key", secretApiKey: "porkbun-secret-key" },
      plan: {
        backup: { domain: "ouro.bot", records: [] },
        changes: [{ action: "create", record: { type: "A", name: "mx1", content: "20.10.114.197" }, reason: "create without provider id" }],
        preservedRecords: [],
        certificateActions: [],
      },
    })).resolves.toEqual([
      { action: "create", record: { type: "A", name: "mx1", content: "20.10.114.197" }, id: "created" },
    ])
    driver.createRecord.mockResolvedValueOnce({})
    await expect(applyDnsWorkflowPlan({
      driver,
      domain: "ouro.bot",
      secrets: { apiKey: "porkbun-api-key", secretApiKey: "porkbun-secret-key" },
      plan: {
        backup: { domain: "ouro.bot", records: [] },
        changes: [{ action: "create", record: { type: "A", name: "mx1", content: "20.10.114.197" }, reason: "create without provider id" }],
        preservedRecords: [],
        certificateActions: [],
      },
    })).resolves.toEqual([
      { action: "create", record: { type: "A", name: "mx1", content: "20.10.114.197" } },
    ])

    await expect(applyDnsWorkflowPlan({
      driver,
      domain: "ouro.bot",
      secrets: { apiKey: "porkbun-api-key", secretApiKey: "porkbun-secret-key" },
      plan: {
        ...planDnsWorkflow({ binding: ouroBotBinding, currentRecords: [] }),
        changes: [{ action: "update", record: { type: "MX", name: "@", content: "mx1.ouro.bot" }, reason: "missing id" }],
      },
    })).rejects.toThrow("without provider record id")
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
    expect(redactDnsWorkflowArtifact(["safe", "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"]))
      .toEqual(["safe", "[redacted]"])
    expect(redactDnsWorkflowArtifact({ pem: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----" }))
      .toEqual({ pem: "[redacted]" })
    expect(redactDnsWorkflowArtifact("plain text")).toBe("plain text")
  })
})
