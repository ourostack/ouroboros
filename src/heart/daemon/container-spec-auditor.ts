import { emitNervesEvent } from "../../nerves/runtime"

const EXPECTED_BINDS = [
  "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli:/home/ouro/.ouro-cli:rw",
  "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro:/home/ouro/AgentBundles/sanctuary.ouro:rw",
] as const

const EXPECTED_MOUNTS = [
  ["/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", "/home/ouro/.ouro-cli"],
  ["/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", "/home/ouro/AgentBundles/sanctuary.ouro"],
] as const

const EXPECTED_EXTRA_PARAMS = "--restart=unless-stopped --user=10001:10001"

export interface SanctuaryContainerAuditOptions {
  expectedImage: string
}

export interface SanctuaryContainerAuditResult {
  ok: boolean
  violations: string[]
}

export interface SanctuaryStagedAuditInput {
  templateXml: string
  runtimePolicyText: string
  expectedImage: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? value : null
}

function isEmptyRecord(value: unknown): boolean {
  const candidate = record(value)
  return candidate !== null && Object.keys(candidate).length === 0
}

export function auditSanctuaryContainerSpec(
  value: unknown,
  options: SanctuaryContainerAuditOptions,
): SanctuaryContainerAuditResult {
  const violations: string[] = []
  const root = record(value)
  const config = record(root?.Config)
  const host = record(root?.HostConfig)
  if (!root || !config || !host) {
    violations.push("inspect payload must contain object Config and HostConfig records")
  } else {
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.expectedImage)) violations.push("expected image must be an exact local Docker image ID")
    if (config.Image !== options.expectedImage) violations.push("image does not match the reviewed exact local Docker image ID")
    if (config.User !== "10001:10001") violations.push("container user must be 10001:10001")
    if (JSON.stringify(config.Entrypoint) !== JSON.stringify(["node", "/opt/ouro/dist/heart/daemon/daemon-entry.js"])) violations.push("entrypoint must be the direct daemon entry")
    if (!(config.Cmd === null || (Array.isArray(config.Cmd) && config.Cmd.length === 0))) violations.push("container command must be empty")
    const environment = stringArray(config.Env)
    if (!environment || !environment.includes("HOME=/home/ouro")) violations.push("HOME must be /home/ouro")
    if (!(config.ExposedPorts === null || config.ExposedPorts === undefined || isEmptyRecord(config.ExposedPorts))) violations.push("container must expose no ports")
    if (host.NetworkMode !== "host") violations.push("network mode must be host")
    if (host.Privileged !== false) violations.push("container must not be privileged")
    const restart = record(host.RestartPolicy)
    if (restart?.Name !== "unless-stopped" || restart.MaximumRetryCount !== 0) violations.push("restart policy must be unless-stopped")
    if (!isEmptyRecord(host.PortBindings)) violations.push("container must publish no ports")
    if (!Array.isArray(host.Devices) || host.Devices.length !== 0) violations.push("container must have no devices")
    if (!(host.CapAdd === null || (Array.isArray(host.CapAdd) && host.CapAdd.length === 0))) violations.push("container must add no capabilities")
    const binds = stringArray(host.Binds)
    if (!binds || JSON.stringify([...binds].sort()) !== JSON.stringify([...EXPECTED_BINDS].sort())) violations.push("bind set must equal the canonical two writable roots")
    const mounts = Array.isArray(root.Mounts) ? root.Mounts : []
    const normalizedMounts = mounts.map((mount) => {
      const item = record(mount)
      return item && item.Type === "bind" && item.RW === true && typeof item.Source === "string" && typeof item.Destination === "string"
        ? [item.Source, item.Destination]
        : null
    })
    if (normalizedMounts.some((mount) => mount === null)
      || JSON.stringify(normalizedMounts.sort()) !== JSON.stringify(EXPECTED_MOUNTS.map((mount) => [...mount]).sort())) {
      violations.push("effective mounts must equal the canonical two writable bind mounts")
    }
  }
  const result = { ok: violations.length === 0, violations }
  if (result.ok) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.container_spec_audit_end",
      message: "Sanctuary container spec audit passed",
      meta: { violationCount: 0 },
    })
  } else {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.container_spec_audit_error",
      message: "Sanctuary container spec audit failed",
      meta: { violationCount: violations.length },
    })
  }
  return result
}

function tag(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`, "u"))
  return match?.[1]
}

export function auditSanctuaryStagedFiles(input: SanctuaryStagedAuditInput): SanctuaryContainerAuditResult {
  const violations: string[] = []
  let runtimePolicy: unknown
  try {
    runtimePolicy = JSON.parse(input.runtimePolicyText)
  } catch {
    runtimePolicy = null
  }
  const policy = record(runtimePolicy)
  if (policy?.scheduler !== "supercronic" || policy.updates !== "disabled" || Object.keys(policy).sort().join(",") !== "scheduler,updates") {
    violations.push("container runtime policy must be exactly scheduler=supercronic and updates=disabled")
  }
  const pathConfigs = [...input.templateXml.matchAll(/<Config\b([^>]*)>([^<]*)<\/Config>/gu)]
    .filter((match) => /\bType="Path"/u.test(match[1]!))
    .map((match) => {
      const target = match[1]!.match(/\bTarget="([^"]+)"/u)?.[1]
      const mode = match[1]!.match(/\bMode="([^"]+)"/u)?.[1]
      return target && mode ? `${match[2]}:${target}:${mode}` : "invalid"
    })
  if (input.templateXml.match(/<Config\b[^>]*\bType="(?:Port|Device)"/u)) violations.push("template must not declare ports or devices")
  const extraParams = tag(input.templateXml, "ExtraParams")
  if (extraParams !== EXPECTED_EXTRA_PARAMS) violations.push("template ExtraParams must equal the canonical user and restart flags")
  const spec = {
    Config: {
      User: extraParams === EXPECTED_EXTRA_PARAMS ? "10001:10001" : "",
      Image: tag(input.templateXml, "Repository"),
      Entrypoint: ["node", "/opt/ouro/dist/heart/daemon/daemon-entry.js"],
      Cmd: [],
      Env: ["HOME=/home/ouro"],
      ExposedPorts: null,
    },
    HostConfig: {
      NetworkMode: tag(input.templateXml, "Network"),
      Privileged: tag(input.templateXml, "Privileged") === "true",
      RestartPolicy: { Name: extraParams === EXPECTED_EXTRA_PARAMS ? "unless-stopped" : "", MaximumRetryCount: 0 },
      Binds: pathConfigs,
      PortBindings: {},
      Devices: [],
      CapAdd: null,
    },
    Mounts: pathConfigs.map((bind) => {
      const [source, destination, mode] = bind.split(":")
      return { Type: "bind", Source: source, Destination: destination, RW: mode === "rw" }
    }),
  }
  const specResult = auditSanctuaryContainerSpec(spec, { expectedImage: input.expectedImage })
  return { ok: violations.length === 0 && specResult.ok, violations: [...violations, ...specResult.violations] }
}
