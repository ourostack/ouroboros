import { emitNervesEvent } from "../../nerves/runtime"

const EXPECTED_BINDS = [
  "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli:/home/ouro/.ouro-cli:rw",
  "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro:/home/ouro/AgentBundles/sanctuary.ouro:rw",
] as const

const EXPECTED_MOUNTS = [
  ["/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", "/home/ouro/.ouro-cli"],
  ["/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", "/home/ouro/AgentBundles/sanctuary.ouro"],
] as const

export interface SanctuaryContainerAuditOptions {
  expectedImage: string
}

export interface SanctuaryContainerAuditResult {
  ok: boolean
  violations: string[]
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
    if (!/^ouro-butler@sha256:[a-f0-9]{64}$/u.test(options.expectedImage)) violations.push("expected image must be an immutable ouro-butler digest")
    if (config.Image !== options.expectedImage) violations.push("image does not match the reviewed immutable digest")
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
  emitNervesEvent({
    level: result.ok ? "info" : "error",
    component: "daemon",
    event: result.ok ? "daemon.container_spec_audit_end" : "daemon.container_spec_audit_error",
    message: result.ok ? "Sanctuary container spec audit passed" : "Sanctuary container spec audit failed",
    meta: { violationCount: violations.length },
  })
  return result
}
