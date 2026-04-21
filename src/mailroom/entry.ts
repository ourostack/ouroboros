import * as fs from "node:fs"
import { BlobServiceClient } from "@azure/storage-blob"
import { DefaultAzureCredential } from "@azure/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { AzureBlobMailroomStore } from "./blob-store"
import { FileMailroomStore } from "./file-store"
import type { MailroomStore } from "./file-store"
import { startMailroomIngress, type MailroomIngressServers } from "./smtp-ingress"
import type { MailroomRegistry } from "./core"

interface MailroomEntryArgs {
  registryPath?: string
  registryBase64?: string
  storePath?: string
  azureAccountUrl?: string
  azureContainer: string
  azureManagedIdentityClientId?: string
  smtpPort: number
  httpPort: number
  host: string
}

const KEY_VALUE_ARGS = new Map([
  ["registry", "--registry"],
  ["registry-base64", "--registry-base64"],
  ["store", "--store"],
  ["azure-account-url", "--azure-account-url"],
  ["azure-container", "--azure-container"],
  ["azure-managed-identity-client-id", "--azure-managed-identity-client-id"],
  ["smtp-port", "--smtp-port"],
  ["http-port", "--http-port"],
  ["host", "--host"],
])

function expandKeyValueArgs(args: string[]): string[] {
  const expanded: string[] = []
  for (const arg of args) {
    const equalsIndex = arg.indexOf("=")
    if (!arg.startsWith("--") && equalsIndex > 0) {
      const key = arg.slice(0, equalsIndex).trim()
      const flag = KEY_VALUE_ARGS.get(key)
      if (flag) {
        expanded.push(flag, arg.slice(equalsIndex + 1))
        continue
      }
    }
    expanded.push(arg)
  }
  return expanded
}

function optionalValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function optionalNumber(args: string[], flag: string, fallback: number): number {
  const index = args.indexOf(flag)
  if (index === -1) return fallback
  const value = Number.parseInt(args[index + 1] ?? "", 10)
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${flag} must be a TCP port`)
  }
  return value
}

function optionalString(args: string[], flag: string, fallback: string): string {
  return optionalValue(args, flag) ?? fallback
}

export function parseMailroomEntryArgs(args: string[]): MailroomEntryArgs {
  const expanded = expandKeyValueArgs(args)
  const storePath = optionalValue(expanded, "--store")
  const azureAccountUrl = optionalValue(expanded, "--azure-account-url")
  if (!storePath && !azureAccountUrl) {
    throw new Error("Missing --store or --azure-account-url")
  }
  const registryPath = optionalValue(expanded, "--registry")
  const registryBase64 = optionalValue(expanded, "--registry-base64")
  if (!registryPath && !registryBase64) {
    throw new Error("Missing --registry or --registry-base64")
  }
  const parsed = {
    ...(registryPath ? { registryPath } : {}),
    ...(registryBase64 ? { registryBase64 } : {}),
    ...(storePath ? { storePath } : {}),
    ...(azureAccountUrl ? { azureAccountUrl } : {}),
    azureContainer: optionalString(expanded, "--azure-container", "mailroom"),
    ...(optionalValue(expanded, "--azure-managed-identity-client-id") ? { azureManagedIdentityClientId: optionalValue(expanded, "--azure-managed-identity-client-id") } : {}),
    smtpPort: optionalNumber(expanded, "--smtp-port", 2525),
    httpPort: optionalNumber(expanded, "--http-port", 8080),
    host: optionalString(expanded, "--host", "0.0.0.0"),
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_entry_args_parsed",
    message: "mailroom entry args parsed",
    meta: { registryPath: parsed.registryPath ?? null, registryBase64: parsed.registryBase64 ? "present" : null, storePath: parsed.storePath ?? null, azureAccountUrl: parsed.azureAccountUrl ?? null, azureContainer: parsed.azureContainer, azureManagedIdentityClientId: parsed.azureManagedIdentityClientId ? "present" : null, smtpPort: parsed.smtpPort, httpPort: parsed.httpPort },
  })
  return parsed
}

function createStore(parsed: MailroomEntryArgs): MailroomStore {
  if (parsed.azureAccountUrl) {
    const credential = parsed.azureManagedIdentityClientId
      ? new DefaultAzureCredential({ managedIdentityClientId: parsed.azureManagedIdentityClientId })
      : new DefaultAzureCredential()
    return new AzureBlobMailroomStore({
      serviceClient: new BlobServiceClient(parsed.azureAccountUrl, credential),
      containerName: parsed.azureContainer,
    })
  }
  return new FileMailroomStore({ rootDir: parsed.storePath! })
}

function readRegistry(parsed: MailroomEntryArgs): MailroomRegistry {
  if (parsed.registryBase64) {
    return JSON.parse(Buffer.from(parsed.registryBase64, "base64").toString("utf-8")) as MailroomRegistry
  }
  return JSON.parse(fs.readFileSync(parsed.registryPath!, "utf-8")) as MailroomRegistry
}

export function runMailroomEntry(args: string[] = process.argv.slice(2)): MailroomIngressServers {
  const parsed = parseMailroomEntryArgs(args)
  const registry = readRegistry(parsed)
  const servers = startMailroomIngress({
    registry,
    store: createStore(parsed),
    smtpPort: parsed.smtpPort,
    httpPort: parsed.httpPort,
    host: parsed.host,
  })
  emitNervesEvent({
    component: "senses",
    event: "senses.mail_entry_started",
    message: "mailroom entry started",
    meta: { domain: registry.domain, smtpPort: parsed.smtpPort, httpPort: parsed.httpPort },
  })
  return servers
}

/* v8 ignore start -- exercised by packaged/container entrypoint smoke rather than in-process unit tests. @preserve */
if (require.main === module) {
  runMailroomEntry()
}
/* v8 ignore stop */
