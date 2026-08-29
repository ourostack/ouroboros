import { emitNervesEvent } from "../../nerves/runtime"

const EXPECTED_BINDS = [
  "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli:/home/ouro/.ouro-cli:rw",
  "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro:/home/ouro/AgentBundles/sanctuary.ouro:rw",
  "/boot/config/custom/ouro-events/spool:/run/ouro-events:ro",
  "/mnt/user/appdata/sabnzbd/sabnzbd.ini:/run/sanctuary/sabnzbd.ini:ro",
] as const

const EXPECTED_MOUNTS = [
  ["/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", "/home/ouro/.ouro-cli", true],
  ["/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", "/home/ouro/AgentBundles/sanctuary.ouro", true],
  ["/boot/config/custom/ouro-events/spool", "/run/ouro-events", false],
  ["/mnt/user/appdata/sabnzbd/sabnzbd.ini", "/run/sanctuary/sabnzbd.ini", false],
] as const

const LEGACY_ALPHA742_IMAGE = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d"
const LEGACY_ALPHA742_BINDS = EXPECTED_BINDS.slice(0, 2)
const LEGACY_ALPHA742_MOUNTS = EXPECTED_MOUNTS.slice(0, 2)

const EXPECTED_EXTRA_PARAMS = "--restart=unless-stopped --user=10001:10001"

export interface SanctuaryContainerAuditOptions {
  expectedImage: string
  expectedEnvironment: readonly string[]
  mountContract?: "canonical" | "legacy-alpha742"
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
  const network = record(root?.NetworkSettings)
  if (!root || !config || !host) {
    violations.push("inspect payload must contain object Config and HostConfig records")
  } else {
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.expectedImage)) violations.push("expected image must be an exact local Docker image ID")
    const mountContract = options.mountContract ?? "canonical"
    if (mountContract === "legacy-alpha742" && options.expectedImage !== LEGACY_ALPHA742_IMAGE) violations.push("legacy mount exception requires the pinned alpha.742 image ID")
    const expectedBinds = mountContract === "legacy-alpha742" ? LEGACY_ALPHA742_BINDS : EXPECTED_BINDS
    const expectedMounts = mountContract === "legacy-alpha742" ? LEGACY_ALPHA742_MOUNTS : EXPECTED_MOUNTS
    if (config.Image !== options.expectedImage) violations.push("image does not match the reviewed exact local Docker image ID")
    if (root.Path !== "node") violations.push("effective container path must be node")
    if (JSON.stringify(root.Args) !== JSON.stringify(["/opt/ouro/dist/heart/daemon/daemon-entry.js"])) violations.push("effective container arguments must be the direct daemon entry")
    if (config.User !== "10001:10001") violations.push("container user must be 10001:10001")
    if (JSON.stringify(config.Entrypoint) !== JSON.stringify(["node", "/opt/ouro/dist/heart/daemon/daemon-entry.js"])) violations.push("entrypoint must be the direct daemon entry")
    if (!(config.Cmd === null || (Array.isArray(config.Cmd) && config.Cmd.length === 0))) violations.push("container command must be empty")
    const environment = stringArray(config.Env)
    if (!environment || JSON.stringify(environment) !== JSON.stringify(options.expectedEnvironment)) violations.push("container environment must exactly match the reviewed image environment")
    if (!(config.ExposedPorts === null || config.ExposedPorts === undefined || isEmptyRecord(config.ExposedPorts))) violations.push("container must expose no ports")
    if (host.NetworkMode !== "host") violations.push("network mode must be host")
    if (host.PidMode !== "") violations.push("PID namespace must be private")
    if (host.IpcMode !== "private") violations.push("IPC namespace must be private")
    if (host.Privileged !== false) violations.push("container must not be privileged")
    if (host.ReadonlyRootfs !== false) violations.push("root filesystem mode must match the reviewed runtime")
    if (!(host.SecurityOpt === null || (Array.isArray(host.SecurityOpt) && host.SecurityOpt.length === 0))) violations.push("container must set no security options")
    const restart = record(host.RestartPolicy)
    if (restart?.Name !== "unless-stopped" || restart.MaximumRetryCount !== 0) violations.push("restart policy must be unless-stopped")
    if (!isEmptyRecord(host.PortBindings)) violations.push("container must publish no ports")
    if (!Array.isArray(host.Devices) || host.Devices.length !== 0) violations.push("container must have no devices")
    if (!(host.CapAdd === null || (Array.isArray(host.CapAdd) && host.CapAdd.length === 0))) violations.push("container must add no capabilities")
    if (!(host.CapDrop === null || (Array.isArray(host.CapDrop) && host.CapDrop.length === 0))) violations.push("container must drop no capabilities")
    if (host.PublishAllPorts !== false) violations.push("container must not publish all exposed ports")
    if (!isEmptyRecord(network?.Ports)) violations.push("effective network ports must be empty")
    const binds = stringArray(host.Binds)
    if (!binds || JSON.stringify([...binds].sort()) !== JSON.stringify([...expectedBinds].sort())) violations.push("bind set does not match the selected Sanctuary mount contract")
    const mounts = Array.isArray(root.Mounts) ? root.Mounts : []
    const normalizedMounts = mounts.map((mount) => {
      const item = record(mount)
      return item && item.Type === "bind" && typeof item.RW === "boolean" && typeof item.Source === "string" && typeof item.Destination === "string"
        ? [item.Source, item.Destination, item.RW]
        : null
    })
    if (normalizedMounts.some((mount) => mount === null)
      || JSON.stringify(normalizedMounts.sort()) !== JSON.stringify(expectedMounts.map((mount) => [...mount]).sort())) {
      violations.push("effective mounts do not match the selected Sanctuary mount contract")
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

function tagValues(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, "gu"))]
    .map((match) => match[1]!)
}

function singleTag(xml: string, name: string): string | undefined {
  const values = tagValues(xml, name)
  return values.length === 1 ? values[0] : undefined
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
  const configOpenCount = [...input.templateXml.matchAll(/<Config\b/gu)].length
  const configEntries = [...input.templateXml.matchAll(/<Config\b([^>]*)>([^<]*)<\/Config>/gu)]
  const pathConfigs = configEntries
    .map((match) => {
      const type = match[1]!.match(/\bType="([^"]+)"/u)?.[1]
      const target = match[1]!.match(/\bTarget="([^"]+)"/u)?.[1]
      const mode = match[1]!.match(/\bMode="([^"]+)"/u)?.[1]
      return type === "Path" && target && mode ? `${match[2]}:${target}:${mode}` : "invalid"
    })
  if (
    configOpenCount !== 4
    || configEntries.length !== 4
    || JSON.stringify([...pathConfigs].sort()) !== JSON.stringify([...EXPECTED_BINDS].sort())
  ) {
    violations.push("template Config entries must equal the canonical four path binds")
  }
  const postArgsOpenCount = [...input.templateXml.matchAll(/<PostArgs\b/gu)].length
  const postArgs = [...input.templateXml.matchAll(/<PostArgs(?:(?:\s*\/>)|>([^<]*)<\/PostArgs>)/gu)]
  if (postArgsOpenCount !== 1 || postArgs.length !== 1 || (postArgs[0]?.[1] ?? "") !== "") {
    violations.push("template PostArgs must be present exactly once and empty")
  }
  const extraParams = singleTag(input.templateXml, "ExtraParams")
  if (extraParams !== EXPECTED_EXTRA_PARAMS) violations.push("template ExtraParams must equal the canonical user and restart flags")
  const repository = singleTag(input.templateXml, "Repository")
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.expectedImage)) violations.push("expected image must be an exact local Docker image ID")
  if (repository !== input.expectedImage) violations.push("image does not match the reviewed exact local Docker image ID")
  if (singleTag(input.templateXml, "Network") !== "host") violations.push("network mode must be host")
  if (singleTag(input.templateXml, "Privileged") !== "false") violations.push("container must not be privileged")
  return { ok: violations.length === 0, violations }
}
