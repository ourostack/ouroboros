import { emitNervesEvent } from "../../nerves/runtime"

interface DockerManTemplateElement {
  name: string
  attributes: Record<string, string>
  form: "empty" | "text"
  text: string
}

interface DockerManTemplateDocument {
  root: { name: "Container"; attributes: { version: "2" } }
  children: DockerManTemplateElement[]
}

const { parseDockerManTemplateXml } = require("../../../deploy/unraid/docker-man-template-xml.cjs") as { parseDockerManTemplateXml(input: string | Uint8Array): DockerManTemplateDocument | null }

const EXPECTED_BINDS = [
  "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli:/home/ouro/.ouro-cli:rw",
  "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro:/home/ouro/AgentBundles/sanctuary.ouro:rw",
  "/boot/config/custom/ouro-events/spool:/run/ouro-events:ro",
  "/run/ouro-authority:/run/ouro-authority:ro",
] as const

const EXPECTED_MOUNTS = [
  ["/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", "/home/ouro/.ouro-cli", true, "rprivate"],
  ["/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", "/home/ouro/AgentBundles/sanctuary.ouro", true, "rprivate"],
  ["/boot/config/custom/ouro-events/spool", "/run/ouro-events", false, "rprivate"],
  ["/run/ouro-authority", "/run/ouro-authority", false, "rprivate"],
] as const

const PRE_GATEWAY_BINDS = EXPECTED_BINDS.slice(0, 3)
const PRE_GATEWAY_MOUNTS = EXPECTED_MOUNTS.slice(0, 3)
const LEGACY_ALPHA742_IMAGE = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d"
const LEGACY_ALPHA742_MOUNTS = EXPECTED_MOUNTS.slice(0, 2)

const EXPECTED_EXTRA_PARAMS = "--restart=unless-stopped --user=10001:10001"
const EXPECTED_NAME = "ouro-butler"
const EXPECTED_TEMPLATE_URL = "https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml"
const EXPECTED_ICON = "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png"
const EXACT_IMAGE = /^sha256:[a-f0-9]{64}$/u
const VERSION_REFERENCE = /^ghcr\.io\/ourostack\/ouroboros-butler:[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u
const PACKAGE_DAEMON_ARGS = ["/opt/ouro/dist/heart/daemon/daemon-entry.js", "--package-managed-agent", "sanctuary"] as const
const PACKAGE_ENTRYPOINT = ["node", ...PACKAGE_DAEMON_ARGS] as const
const LEGACY_DAEMON_ARGS = ["/opt/ouro/dist/heart/daemon/daemon-entry.js"] as const
const LEGACY_ENTRYPOINT = ["node", ...LEGACY_DAEMON_ARGS] as const

export interface SanctuaryContainerAuditOptions {
  expectedImage: string
  expectedEnvironment: readonly string[]
  expectedImageReference?: string
  expectedIcon?: string
  mountContract: "canonical-pre-gateway" | "canonical-gateway" | "legacy-alpha742"
}

export interface SanctuaryContainerAuditResult {
  ok: boolean
  violations: string[]
}

export interface SanctuaryStagedAuditInput {
  templateXml: string | Uint8Array
  runtimePolicyText: string
  expectedImage: string
  mountContract: SanctuaryContainerAuditOptions["mountContract"]
}

export interface SanctuaryPersistentTemplateAuditInput {
  templateXml: string | Uint8Array
  runtimePolicyText: string
  expectedImageReference: string
  mountContract: SanctuaryContainerAuditOptions["mountContract"]
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
    if (!EXACT_IMAGE.test(options.expectedImage)) violations.push("expected image must be an exact local Docker image ID")
    const mountContract = options.mountContract
    if (mountContract !== "canonical-pre-gateway" && mountContract !== "canonical-gateway" && mountContract !== "legacy-alpha742") violations.push("unsupported mount contract")
    if (mountContract === "legacy-alpha742" && options.expectedImage !== LEGACY_ALPHA742_IMAGE) violations.push("legacy mount exception requires the pinned alpha.742 image ID")
    const expectedMounts = mountContract === "legacy-alpha742" ? LEGACY_ALPHA742_MOUNTS : mountContract === "canonical-pre-gateway" ? PRE_GATEWAY_MOUNTS : EXPECTED_MOUNTS
    const expectedArgs = mountContract !== "legacy-alpha742" ? PACKAGE_DAEMON_ARGS : LEGACY_DAEMON_ARGS
    const expectedEntrypoint = mountContract !== "legacy-alpha742" ? PACKAGE_ENTRYPOINT : LEGACY_ENTRYPOINT
    if (root.Image !== options.expectedImage) violations.push("image does not match the reviewed exact local Docker image ID")
    if (root.Path !== "node") violations.push("effective container path must be node")
    if (JSON.stringify(root.Args) !== JSON.stringify(expectedArgs)) violations.push("effective container arguments must be the reviewed direct daemon entry")
    if (config.User !== "10001:10001") violations.push("container user must be 10001:10001")
    if (JSON.stringify(config.Entrypoint) !== JSON.stringify(expectedEntrypoint)) violations.push("entrypoint must be the reviewed direct daemon entry")
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
    if (mountContract !== "legacy-alpha742" && root.Name !== `/${EXPECTED_NAME}`) violations.push("container name must be /ouro-butler")
    if (mountContract !== "legacy-alpha742") {
      if (!options.expectedImageReference || !VERSION_REFERENCE.test(options.expectedImageReference)) violations.push("expected image reference must be the canonical package-version tag")
      if (config.Image !== options.expectedImageReference) violations.push("configured image must equal the canonical package-version tag")
      if (options.expectedIcon !== EXPECTED_ICON) violations.push("expected icon must equal the canonical template icon")
      const labels = record(config.Labels)
      if (labels?.["net.unraid.docker.managed"] !== "dockerman") violations.push("container must carry the DockerMan managed label")
      if (labels?.["net.unraid.docker.icon"] !== options.expectedIcon) violations.push("container icon label must equal the canonical template icon")
      if (labels && Object.prototype.hasOwnProperty.call(labels, "net.unraid.docker.webui")) violations.push("container must not carry a DockerMan WebUI label")
    }
    const mounts = Array.isArray(root.Mounts) ? root.Mounts : []
    const normalizedMounts = mounts.map((mount) => {
      const item = record(mount)
      return item && item.Type === "bind" && typeof item.RW === "boolean" && typeof item.Source === "string" && typeof item.Destination === "string" && item.Propagation === "rprivate"
        ? [item.Source, item.Destination, item.RW, item.Propagation]
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

function directChildren(document: DockerManTemplateDocument | null, name: string): DockerManTemplateElement[] {
  return document?.children.filter((child) => child.name === name) ?? []
}

function singleTextChild(document: DockerManTemplateDocument | null, name: string): string | undefined {
  const children = directChildren(document, name)
  const child = children.length === 1 ? children[0] : undefined
  return child?.form === "text" && Object.keys(child.attributes).length === 0 ? child.text : undefined
}

function auditTemplate(input: { templateXml: string | Uint8Array; runtimePolicyText: string; mountContract: SanctuaryContainerAuditOptions["mountContract"] }, expectedRepository: string, repositoryIsValid: boolean, repositoryViolation: string): string[] {
  const violations: string[] = []
  if (input.mountContract !== "canonical-pre-gateway" && input.mountContract !== "canonical-gateway") violations.push("unsupported template mount contract")
  const expectedBinds = input.mountContract === "canonical-pre-gateway" ? PRE_GATEWAY_BINDS : EXPECTED_BINDS
  const template = parseDockerManTemplateXml(input.templateXml)
  if (!template) violations.push("canonical DockerMan XML structure is invalid")
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
  const configEntries = directChildren(template, "Config")
  const pathConfigs = configEntries.map((entry) => {
    const { Type: type, Target: target, Mode: mode } = entry.attributes
    return entry.form === "text" && type === "Path" && target && mode ? `${entry.text}:${target}:${mode}` : "invalid"
  })
  if (
    configEntries.length !== expectedBinds.length
    || JSON.stringify([...pathConfigs].sort()) !== JSON.stringify([...expectedBinds].sort())
  ) {
    violations.push("template Config entries must equal the canonical path binds")
  }
  const postArgs = directChildren(template, "PostArgs")
  if (postArgs.length !== 1 || postArgs[0]!.text !== "" || Object.keys(postArgs[0]!.attributes).length !== 0) {
    violations.push("template PostArgs must be present exactly once and empty")
  }
  const extraParams = singleTextChild(template, "ExtraParams")
  if (extraParams !== EXPECTED_EXTRA_PARAMS) violations.push("template ExtraParams must equal the canonical user and restart flags")
  const repository = singleTextChild(template, "Repository")
  if (!repositoryIsValid) violations.push(repositoryViolation)
  if (repository !== expectedRepository) violations.push("template repository does not match the reviewed image identity")
  if (singleTextChild(template, "Name") !== EXPECTED_NAME) violations.push("template technical name must be exactly ouro-butler")
  if (singleTextChild(template, "TemplateURL") !== EXPECTED_TEMPLATE_URL) violations.push("template URL must equal the canonical release template")
  if (singleTextChild(template, "Icon") !== EXPECTED_ICON) violations.push("template icon must equal the canonical release icon")
  const webUi = directChildren(template, "WebUI")
  if (webUi.length !== 1 || webUi[0]!.form !== "empty" || Object.keys(webUi[0]!.attributes).length !== 0) violations.push("template WebUI must be present exactly once and empty")
  if (singleTextChild(template, "Network") !== "host") violations.push("network mode must be host")
  if (singleTextChild(template, "Privileged") !== "false") violations.push("container must not be privileged")
  return violations
}

export function auditSanctuaryStagedFiles(input: SanctuaryStagedAuditInput): SanctuaryContainerAuditResult {
  const violations = auditTemplate(input, input.expectedImage, EXACT_IMAGE.test(input.expectedImage), "expected image must be an exact local Docker image ID")
  return { ok: violations.length === 0, violations }
}

export function auditSanctuaryPersistentTemplate(input: SanctuaryPersistentTemplateAuditInput): SanctuaryContainerAuditResult {
  const violations = auditTemplate(input, input.expectedImageReference, VERSION_REFERENCE.test(input.expectedImageReference), "expected image reference must be the canonical package-version tag")
  return { ok: violations.length === 0, violations }
}
