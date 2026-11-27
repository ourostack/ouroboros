import { emitNervesEvent } from "../../nerves/runtime"
import { BUTLER_AGENT_NAMES, type ButlerAgentName } from "../butler-agent"
import { isContainerRuntimePolicy } from "./container-runtime"

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

// The host folders never change with the Butler's name: the bundle stays in sanctuary.ouro on the live host. Only where the
// bundle, its psyche and the operator trust are mounted inside the container follows the name the image runs.
function expectedBinds(name: ButlerAgentName): readonly string[] {
  return [
    "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli:/home/ouro/.ouro-cli:rw",
    `/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro:/home/ouro/AgentBundles/${name}.ouro:rw`,
    "/boot/config/custom/ouro-events/spool:/run/ouro-events:ro",
    "/run/ouro-authority:/run/ouro-authority:ro",
    // The psyche folder read-only over the bundle. Releases up to alpha.978 create it, and a rollback to one recreates it,
    // so canonical-gateway accepts these binds with or without this row (gatewayBinds).
    `/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/psyche:/home/ouro/AgentBundles/${name}.ouro/psyche:ro`,
    // Operator-set grants, root-owned on the host and read-only inside the Butler (the Butler honours a grant only from here).
    `/mnt/user/appdata/ouro-butler/trust/sanctuary:/etc/ouro/trust/${name}:ro`,
    // The bundle sync deploy key, root-owned on the host and read-only inside the Butler. The key can push to the owner's repo.
    "/mnt/user/appdata/ouro-butler/sync:/run/ouro-sync:ro",
  ]
}

type ExpectedMount = readonly [string, string, boolean, string]
function expectedMounts(name: ButlerAgentName): readonly ExpectedMount[] {
  return [
    ["/mnt/user/appdata/ouro-butler/runtime/.ouro-cli", "/home/ouro/.ouro-cli", true, "rprivate"],
    ["/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro", `/home/ouro/AgentBundles/${name}.ouro`, true, "rprivate"],
    ["/boot/config/custom/ouro-events/spool", "/run/ouro-events", false, "rprivate"],
    ["/run/ouro-authority", "/run/ouro-authority", false, "rprivate"],
    ["/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro/psyche", `/home/ouro/AgentBundles/${name}.ouro/psyche`, false, "rprivate"],
    ["/mnt/user/appdata/ouro-butler/trust/sanctuary", `/etc/ouro/trust/${name}`, false, "rprivate"],
    ["/mnt/user/appdata/ouro-butler/sync", "/run/ouro-sync", false, "rprivate"],
  ]
}

const psycheTarget = (name: ButlerAgentName) => `/home/ouro/AgentBundles/${name}.ouro/psyche`
const SYNC_TARGET = "/run/ouro-sync"
/**
 * The canonical-gateway shapes for one Butler name: with and without the separate read-only psyche mount. With sync on,
 * the key mount is required. With sync off (the live Butler until the cutover, and a rollback to a release without the
 * mount) each shape is accepted with or without it.
 */
function gatewayBinds(syncEnabled: boolean, name: ButlerAgentName): ReadonlyArray<readonly string[]> {
  const all = expectedBinds(name)
  const shapes = [all, all.filter((bind) => !bind.includes(`:${psycheTarget(name)}:`))]
  return syncEnabled ? shapes : [...shapes, ...shapes.map((binds) => binds.filter((bind) => !bind.includes(`:${SYNC_TARGET}:`)))]
}
function gatewayMounts(syncEnabled: boolean, name: ButlerAgentName): ReadonlyArray<readonly ExpectedMount[]> {
  const all = expectedMounts(name)
  const shapes = [all, all.filter((mount) => mount[1] !== psycheTarget(name))]
  return syncEnabled ? shapes : [...shapes, ...shapes.map((mounts) => mounts.filter((mount) => mount[1] !== SYNC_TARGET))]
}
const preGatewayBinds = (name: ButlerAgentName) => expectedBinds(name).slice(0, 3)
const preGatewayMounts = (name: ButlerAgentName) => expectedMounts(name).slice(0, 3)
const LEGACY_ALPHA742_IMAGE = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d"
const LEGACY_ALPHA742_MOUNTS = expectedMounts("sanctuary").slice(0, 2)

const EXPECTED_EXTRA_PARAMS = "--restart=unless-stopped --user=10001:10001"
const EXPECTED_NAME = "ouro-butler"
// The release's own template, then main's copy, which templates carried before releases moved off pull requests.
const EXPECTED_TEMPLATE_URLS: ReadonlySet<string> = new Set([
  "https://github.com/ourostack/ouroboros/releases/latest/download/sanctuary.xml",
  "https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml",
])
const EXPECTED_ICON = "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png"
const EXACT_IMAGE = /^sha256:[a-f0-9]{64}$/u
const VERSION_REFERENCE = /^ghcr\.io\/ourostack\/ouroboros-butler:[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u
// The image names the Butler `butler` from M2 on; images from before the rename name it `sanctuary`. Either runs its one bundle.
const packageDaemonArgs = (name: ButlerAgentName) => ["/opt/ouro/dist/heart/daemon/daemon-entry.js", "--package-managed-agent", name]
const LEGACY_DAEMON_ARGS = ["/opt/ouro/dist/heart/daemon/daemon-entry.js"] as const
const LEGACY_ENTRYPOINT = ["node", ...LEGACY_DAEMON_ARGS] as const

export interface SanctuaryContainerAuditOptions {
  expectedImage: string
  expectedEnvironment: readonly string[]
  expectedImageReference?: string
  expectedIcon?: string
  mountContract: "canonical-pre-gateway" | "canonical-gateway" | "legacy-alpha742"
  /** The bundle's sync is on, so the deploy key must be mounted. */
  syncEnabled?: boolean
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
  syncEnabled?: boolean
}

export interface SanctuaryPersistentTemplateAuditInput {
  templateXml: string | Uint8Array
  runtimePolicyText: string
  expectedImageReference: string
  mountContract: SanctuaryContainerAuditOptions["mountContract"]
  syncEnabled?: boolean
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
    // The Butler name the container runs, from its own arguments: its bundle, psyche and trust must be mounted under that name.
    const name = BUTLER_AGENT_NAMES.find((candidate) => JSON.stringify(root.Args) === JSON.stringify(packageDaemonArgs(candidate))) ?? "sanctuary"
    const packageArgs = packageDaemonArgs(name)
    const acceptedMounts = mountContract === "legacy-alpha742" ? [LEGACY_ALPHA742_MOUNTS] : mountContract === "canonical-pre-gateway" ? [preGatewayMounts(name)] : gatewayMounts(options.syncEnabled === true, name)
    const expectedArgs = mountContract !== "legacy-alpha742" ? packageArgs : LEGACY_DAEMON_ARGS
    const expectedEntrypoint = mountContract !== "legacy-alpha742" ? ["node", ...packageArgs] : LEGACY_ENTRYPOINT
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
    const actualMounts = JSON.stringify(normalizedMounts.sort())
    if (normalizedMounts.some((mount) => mount === null)
      || !acceptedMounts.some((expectedMounts) => actualMounts === JSON.stringify(expectedMounts.map((mount) => [...mount]).sort()))) {
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

function auditTemplate(input: { templateXml: string | Uint8Array; runtimePolicyText: string; mountContract: SanctuaryContainerAuditOptions["mountContract"]; syncEnabled?: boolean }, expectedRepository: string, repositoryIsValid: boolean, repositoryViolation: string): string[] {
  const violations: string[] = []
  if (input.mountContract !== "canonical-pre-gateway" && input.mountContract !== "canonical-gateway") violations.push("unsupported template mount contract")
  // A template names no image arguments, so its binds may use either Butler name, but all under the same one.
  const acceptedBinds = BUTLER_AGENT_NAMES.flatMap((name) => input.mountContract === "canonical-pre-gateway" ? [preGatewayBinds(name)] : gatewayBinds(input.syncEnabled === true, name))
  const template = parseDockerManTemplateXml(input.templateXml)
  if (!template) violations.push("canonical DockerMan XML structure is invalid")
  let runtimePolicy: unknown
  try {
    runtimePolicy = JSON.parse(input.runtimePolicyText)
  } catch {
    runtimePolicy = null
  }
  if (!isContainerRuntimePolicy(runtimePolicy)) {
    violations.push("container runtime policy must be exactly scheduler=supercronic and updates=disabled, with an optional product module under /opt")
  }
  const configEntries = directChildren(template, "Config")
  const pathConfigs = configEntries.map((entry) => {
    const { Type: type, Target: target, Mode: mode } = entry.attributes
    return entry.form === "text" && type === "Path" && target && mode ? `${entry.text}:${target}:${mode}` : "invalid"
  })
  const actualBinds = JSON.stringify([...pathConfigs].sort())
  if (!acceptedBinds.some((expectedBinds) => configEntries.length === expectedBinds.length && actualBinds === JSON.stringify([...expectedBinds].sort()))) {
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
  if (!EXPECTED_TEMPLATE_URLS.has(singleTextChild(template, "TemplateURL") ?? "")) violations.push("template URL must equal the canonical release template")
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
