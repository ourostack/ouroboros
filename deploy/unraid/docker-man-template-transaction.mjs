#!/usr/local/bin/node

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, constants, fchmodSync, fchownSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import xmlValidator from "./docker-man-template-xml.cjs"

const TARGET_PATH = "/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml"
const JOURNAL_PATH = "/boot/config/custom/ouro-butler/docker-man-template-transaction.json"
const TEMPLATE_URL = "https://raw.githubusercontent.com/ourostack/ouroboros/main/deploy/unraid/sanctuary.xml"
const ICON = "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png"
const COMMUNITY_APPS_ENTRY_PATH = "/usr/local/emhttp/plugins/community.applications/include/exec.php"
const COMMUNITY_APPS_HELPER_PATH = "/usr/local/emhttp/plugins/community.applications/include/previous_apps_helpers.php"
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u
const CONTAINER_ID = /^[0-9a-f]{64}$/u
const VERSION_TAG = /^ghcr\.io\/ourostack\/ouroboros-butler:[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u
const JELLYFIN_STATES = new Set(["created", "running", "paused", "restarting", "removing", "exited", "dead"])
const JELLYFIN_FORMAT = '{"name":{{json .Name}},"containerId":{{json .Id}},"imageId":{{json .Image}},"state":{{json .State.Status}},"restartCount":{{json .RestartCount}}}'
const AUTHORITY_INSTALL_STEPS = ["freeze-resident", "stage-authority", "verify-token-rotation", "transfer-cursor", "remove-resident-token", "start-gateway", "configure-resident", "start-resident", "verify-install"]
const AUTHORITY_ROLLBACK_STEPS = ["freeze-resident", "retire-registrations", "reconcile-executions", "stop-gateway", "end-epoch", "restore-token-cursor", "restore-resident", "verify-rollback"]

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value
}

function exactKeys(value, expected, label) {
  const keys = Object.keys(value).sort()
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) throw new Error(`${label} has unexpected fields`)
}

function validateJellyfinState(raw, label = "Jellyfin checkpoint") {
  const value = object(raw, label)
  exactKeys(value, ["containerId", "imageId", "state", "restartCount"], label)
  if (!CONTAINER_ID.test(value.containerId) || !IMAGE_ID.test(value.imageId) || !JELLYFIN_STATES.has(value.state) || !Number.isSafeInteger(value.restartCount) || value.restartCount < 0) throw new Error(`${label} is invalid`)
  return { containerId: value.containerId, imageId: value.imageId, state: value.state, restartCount: value.restartCount }
}

export function inspectCurrentJellyfinState() {
  let inspected
  try {
    inspected = JSON.parse(execFileSync("/usr/bin/docker", ["container", "inspect", "--format", JELLYFIN_FORMAT, "jellyfin"], { encoding: "utf8", maxBuffer: 65_536, stdio: ["ignore", "pipe", "ignore"] }).trim())
  } catch {
    throw new Error("Jellyfin container inspection failed")
  }
  const value = object(inspected, "Jellyfin container inspection")
  exactKeys(value, ["name", "containerId", "imageId", "state", "restartCount"], "Jellyfin container inspection")
  if (value.name !== "/jellyfin") throw new Error("Jellyfin container identity is invalid")
  return validateJellyfinState({ containerId: value.containerId, imageId: value.imageId, state: value.state, restartCount: value.restartCount })
}

function assertJellyfinUnchanged(expected) {
  const current = inspectCurrentJellyfinState()
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("Jellyfin changed during the Butler transaction")
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`
}

function recordDigest(record) {
  const { digest: _ignored, ...unsigned } = record
  return digest(Buffer.from(JSON.stringify(unsigned)))
}

function directChildren(document, name) {
  return document.children.filter((child) => child.name === name)
}

function singleTextChild(document, name) {
  const children = directChildren(document, name)
  if (children.length !== 1 || children[0].form !== "text" || Object.keys(children[0].attributes).length !== 0) throw new Error(`template ${name} must appear exactly once as plain text`)
  return children[0].text
}

function templateIdentity(bytes, expectedRepository) {
  const document = xmlValidator.parseDockerManTemplateXml(bytes)
  if (!document) throw new Error("canonical DockerMan XML structure is invalid")
  const identity = {
    name: singleTextChild(document, "Name"),
    repository: singleTextChild(document, "Repository"),
    templateUrl: singleTextChild(document, "TemplateURL"),
    icon: singleTextChild(document, "Icon"),
  }
  if (identity.name !== "ouro-butler" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/u.test(identity.name)) throw new Error("template technical name is invalid")
  if (identity.repository !== expectedRepository || !VERSION_TAG.test(identity.repository)) throw new Error("template version reference is invalid")
  if (identity.templateUrl !== TEMPLATE_URL || identity.icon !== ICON) throw new Error("template identity is invalid")
  const webUi = directChildren(document, "WebUI")
  if (webUi.length !== 1 || webUi[0].form !== "empty" || Object.keys(webUi[0].attributes).length !== 0) throw new Error("template WebUI must be exactly empty")
  return identity
}

function validateDirectory(path, expectedUid, expectedGid) {
  const metadata = lstatSync(path)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== expectedUid || metadata.gid !== expectedGid || (metadata.mode & 0o777) !== 0o700 || realpathSync(path) !== resolve(path)) throw new Error("transaction parent is unsafe")
}

function validateRegularFile(path, expectedUid, expectedGid, label) {
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== expectedUid || metadata.gid !== expectedGid || (metadata.mode & 0o777) !== 0o600) throw new Error(`${label} metadata is invalid`)
  return metadata
}

function metadataIfPresent(path) {
  try {
    return lstatSync(path)
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

export function isSafeRecoveryTemporaryMetadata(metadata, expectedUid, expectedGid) {
  return Boolean(metadata
    && typeof metadata.isFile === "function"
    && typeof metadata.isSymbolicLink === "function"
    && metadata.isFile()
    && !metadata.isSymbolicLink()
    && metadata.uid === expectedUid
    && metadata.gid === expectedGid
    && (metadata.mode & 0o777) === 0o600)
}

function paths(options = {}) {
  const targetPath = options.targetPath ?? TARGET_PATH
  const journalPath = options.journalPath ?? JOURNAL_PATH
  const expectedUid = options.expectedUid ?? 0
  const expectedGid = options.expectedGid ?? 0
  return {
    targetPath,
    journalPath,
    templateParent: dirname(targetPath),
    journalParent: dirname(journalPath),
    targetTemporary: `${dirname(targetPath)}/.${basename(targetPath)}.ouro-transaction.tmp`,
    journalTemporary: `${dirname(journalPath)}/.${basename(journalPath)}.ouro-transaction.tmp`,
    expectedUid,
    expectedGid,
  }
}

function validateTemplateParent(state, allowTemporaryResidue = false) {
  validateDirectory(state.templateParent, state.expectedUid, state.expectedGid)
  const matches = readdirSync(state.templateParent).filter((entry) => entry.toLowerCase() === basename(state.targetPath).toLowerCase())
  if (matches.length > 1 || (matches.length === 1 && matches[0] !== basename(state.targetPath))) throw new Error("case-folded DockerMan template name is ambiguous")
  if (!allowTemporaryResidue && metadataIfPresent(state.targetTemporary)) throw new Error("template transaction temporary state is ambiguous")
}

function validateJournalParent(state, allowTemporaryResidue = false) {
  validateDirectory(state.journalParent, state.expectedUid, state.expectedGid)
  if (!allowTemporaryResidue && metadataIfPresent(state.journalTemporary)) throw new Error("template transaction temporary state is ambiguous")
}

function validateParents(state, allowTemporaryResidue = false) {
  validateTemplateParent(state, allowTemporaryResidue)
  validateJournalParent(state, allowTemporaryResidue)
}

function ensureJournalParent(state) {
  if (!metadataIfPresent(state.journalParent)) {
    const parent = dirname(state.journalParent)
    validateDirectory(parent, state.expectedUid, state.expectedGid)
    mkdirSync(state.journalParent, { mode: 0o700 })
    syncDirectory(parent)
  }
  validateJournalParent(state)
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}

function atomicWrite(path, temporaryPath, bytes, metadata) {
  const fd = openSync(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, metadata.mode)
  try {
    writeFileSync(fd, bytes)
    fchmodSync(fd, metadata.mode)
    fchownSync(fd, metadata.uid, metadata.gid)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temporaryPath, path)
  syncDirectory(dirname(path))
}

function deleteDurably(path) {
  unlinkSync(path)
  syncDirectory(dirname(path))
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || Buffer.from(value, "base64").toString("base64") !== value) throw new Error("template transaction journal prior bytes are invalid")
  return Buffer.from(value, "base64")
}

function validateJournalRecord(raw, state) {
  const record = object(raw, "template transaction journal")
  exactKeys(record, ["schemaVersion", "state", "target", "priorTemplate", "priorTemplateDigest", "targetTemplateDigest", "canonicalVersionTag", "reviewedManifestDigest", "rollbackImageId", "targetImageId", "jellyfin", "digest", ...(Object.hasOwn(record, "authority") ? ["authority"] : [])], "template transaction journal")
  if (Object.hasOwn(record, "authority")) validateAuthorityHandoff(record.authority, record)
  if (record.schemaVersion !== 1 || !["rollback", "committing"].includes(record.state)) throw new Error("template transaction journal state is invalid")
  const target = object(record.target, "template transaction journal target")
  exactKeys(target, ["path", "name", "templateUrl", "icon"], "template transaction journal target")
  if (target.path !== state.targetPath || target.name !== "ouro-butler" || target.templateUrl !== TEMPLATE_URL || target.icon !== ICON) throw new Error("template transaction journal target is invalid")
  const prior = object(record.priorTemplate, "template transaction journal prior template")
  exactKeys(prior, ["present", "bytesBase64", "metadata"], "template transaction journal prior template")
  if (typeof prior.present !== "boolean") throw new Error("template transaction journal prior presence is invalid")
  let priorBytes = null
  if (prior.present) {
    priorBytes = decodeCanonicalBase64(prior.bytesBase64)
    const metadata = object(prior.metadata, "template transaction journal prior metadata")
    exactKeys(metadata, ["uid", "gid", "mode"], "template transaction journal prior metadata")
    if (metadata.uid !== state.expectedUid || metadata.gid !== state.expectedGid || metadata.mode !== 0o600 || record.priorTemplateDigest !== digest(priorBytes)) throw new Error("template transaction journal prior metadata is invalid")
  } else if (prior.bytesBase64 !== null || prior.metadata !== null || record.priorTemplateDigest !== null) {
    throw new Error("template transaction journal absent prior state is invalid")
  }
  if (!VERSION_TAG.test(record.canonicalVersionTag) || !IMAGE_ID.test(record.reviewedManifestDigest) || !IMAGE_ID.test(record.rollbackImageId) || !IMAGE_ID.test(record.targetImageId) || record.rollbackImageId === record.targetImageId || !IMAGE_ID.test(record.targetTemplateDigest)) throw new Error("template transaction journal release identity is invalid")
  const jellyfin = validateJellyfinState(record.jellyfin, "template transaction journal Jellyfin checkpoint")
  if (!IMAGE_ID.test(record.digest) || record.digest !== recordDigest(record)) throw new Error("template transaction journal digest is invalid")
  return { ...record, jellyfin, priorBytes }
}

function readJournal(state) {
  if (!metadataIfPresent(state.journalPath)) return null
  validateRegularFile(state.journalPath, state.expectedUid, state.expectedGid, "template transaction journal")
  let parsed
  try { parsed = JSON.parse(readFileSync(state.journalPath, "utf8")) } catch { throw new Error("template transaction journal JSON is invalid") }
  return validateJournalRecord(parsed, state)
}

function writeJournal(record, state) {
  const complete = { ...record, digest: recordDigest(record) }
  atomicWrite(state.journalPath, state.journalTemporary, Buffer.from(`${JSON.stringify(complete)}\n`), { uid: state.expectedUid, gid: state.expectedGid, mode: 0o600 })
  return complete
}

function currentTargetDigest(state) {
  if (!metadataIfPresent(state.targetPath)) return null
  validateRegularFile(state.targetPath, state.expectedUid, state.expectedGid, "DockerMan template")
  return digest(readFileSync(state.targetPath))
}

function inspectRecoveryTemporary(state) {
  validateParents(state, true)
  const residues = [state.targetTemporary, state.journalTemporary]
    .map((path) => ({ path, metadata: metadataIfPresent(path) }))
    .filter((entry) => entry.metadata)
  if (residues.length === 0) return null
  if (residues.length !== 1) throw new Error("template transaction recovery temporary state is ambiguous")
  const residue = residues[0]
  if (!isSafeRecoveryTemporaryMetadata(residue.metadata, state.expectedUid, state.expectedGid)) throw new Error("template transaction recovery temporary file is unsafe")
  const journalMetadata = metadataIfPresent(state.journalPath)
  if (journalMetadata) readJournal(state)
  if (residue.path === state.targetTemporary) {
    if (!journalMetadata) throw new Error("template transaction recovery target temporary file is orphaned")
    const journal = readJournal(state)
    const installedDigest = currentTargetDigest(state)
    const allowedDigests = [journal.targetTemplateDigest, journal.priorTemplateDigest]
    if (!(allowedDigests.includes(installedDigest) || (!journal.priorTemplate.present && installedDigest === null))) throw new Error("template transaction recovery target state is ambiguous")
  }
  return residue
}

function cleanupRecoveryTemporary(state) {
  const residue = inspectRecoveryTemporary(state)
  if (!residue) return
  deleteDurably(residue.path)
}

function publicJournalRecord(result) {
  if (!result) return null
  const { priorBytes: _ignored, ...record } = result
  return record
}

export function inspectDockerManTemplateTransactionRecoveryIdentity(options = {}) {
  const state = paths(options)
  inspectRecoveryTemporary(state)
  const current = readJournal(state)
  const jellyfin = inspectCurrentJellyfinState()
  if (current && JSON.stringify(jellyfin) !== JSON.stringify(current.jellyfin)) throw new Error("Jellyfin changed during the Butler transaction")
  return publicJournalRecord(current)
}

export function inspectDockerManTemplateTransactionForRecovery(options = {}) {
  const state = paths(options)
  const expected = inspectDockerManTemplateTransactionRecoveryIdentity(options)
  cleanupRecoveryTemporary(state)
  const current = inspectDockerManTemplateTransaction(options)
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("template transaction changed during recovery")
  return current
}

export function inspectDockerManTemplateTransaction(options = {}) {
  const state = paths(options)
  validateParents(state)
  return publicJournalRecord(readJournal(state))
}

function validateTemplateSource(input, state) {
  validateTemplateParent(state)
  if (metadataIfPresent(state.targetPath)) validateRegularFile(state.targetPath, state.expectedUid, state.expectedGid, "DockerMan template")
  validateDirectory(dirname(input.sourceTemplatePath), state.expectedUid, state.expectedGid)
  validateRegularFile(input.sourceTemplatePath, state.expectedUid, state.expectedGid, "source template")
  if (!VERSION_TAG.test(input.canonicalVersionTag) || !IMAGE_ID.test(input.reviewedManifestDigest) || !IMAGE_ID.test(input.rollbackImageId) || !IMAGE_ID.test(input.targetImageId) || input.rollbackImageId === input.targetImageId) throw new Error("reviewed release identity is invalid")
  const sourceBytes = readFileSync(input.sourceTemplatePath)
  const identity = templateIdentity(sourceBytes, input.canonicalVersionTag)
  return { sourceBytes, identity }
}

export function prepareDockerManTemplateTransaction(input, options = {}) {
  const state = paths(options)
  const { sourceBytes, identity } = validateTemplateSource(input, state)
  const jellyfin = inspectCurrentJellyfinState()
  ensureJournalParent(state)
  const existing = readJournal(state)
  if (existing) {
    if (existing.canonicalVersionTag !== input.canonicalVersionTag || existing.reviewedManifestDigest !== input.reviewedManifestDigest || existing.rollbackImageId !== input.rollbackImageId || existing.targetImageId !== input.targetImageId || existing.targetTemplateDigest !== digest(sourceBytes) || currentTargetDigest(state) !== existing.targetTemplateDigest || JSON.stringify(existing.jellyfin) !== JSON.stringify(jellyfin)) throw new Error("pending template transaction does not match the reviewed release")
    const { priorBytes: _ignored, ...record } = existing
    return record
  }
  let priorTemplate
  let priorTemplateDigest = null
  if (metadataIfPresent(state.targetPath)) {
    const metadata = validateRegularFile(state.targetPath, state.expectedUid, state.expectedGid, "DockerMan template")
    const bytes = readFileSync(state.targetPath)
    priorTemplateDigest = digest(bytes)
    priorTemplate = { present: true, bytesBase64: bytes.toString("base64"), metadata: { uid: metadata.uid, gid: metadata.gid, mode: metadata.mode & 0o777 } }
  } else {
    priorTemplate = { present: false, bytesBase64: null, metadata: null }
  }
  const unsigned = {
    schemaVersion: 1,
    state: "rollback",
    target: { path: state.targetPath, name: identity.name, templateUrl: identity.templateUrl, icon: identity.icon },
    priorTemplate,
    priorTemplateDigest,
    targetTemplateDigest: digest(sourceBytes),
    canonicalVersionTag: input.canonicalVersionTag,
    reviewedManifestDigest: input.reviewedManifestDigest,
    rollbackImageId: input.rollbackImageId,
    targetImageId: input.targetImageId,
    jellyfin,
  }
  const record = writeJournal(unsigned, state)
  options.checkpoint?.("after-template-journal")
  atomicWrite(state.targetPath, state.targetTemporary, sourceBytes, { uid: state.expectedUid, gid: state.expectedGid, mode: 0o600 })
  options.checkpoint?.("after-template-replacement")
  return record
}

export function markDockerManTemplateTransactionCommitting(options = {}) {
  const state = paths(options)
  validateParents(state)
  const current = readJournal(state)
  if (!current) throw new Error("template transaction journal is absent")
  requireActiveAuthority(current, state)
  if (currentTargetDigest(state) !== current.targetTemplateDigest) throw new Error("installed DockerMan template does not match the transaction")
  assertJellyfinUnchanged(current.jellyfin)
  if (current.state === "committing") {
    const { priorBytes: _ignored, ...record } = current
    return record
  }
  const { priorBytes: _ignored, digest: _digest, ...record } = current
  const committing = writeJournal({ ...record, state: "committing" }, state)
  options.checkpoint?.("after-template-committing")
  return committing
}

export function rollbackDockerManTemplateTransaction(options = {}) {
  const state = paths(options)
  validateParents(state)
  const current = readJournal(state)
  if (!current) return false
  if (current.authority && current.authority.state !== "retired") throw new Error("authority epoch must be retired before template rollback")
  const installedDigest = currentTargetDigest(state)
  assertJellyfinUnchanged(current.jellyfin)
  if (current.priorTemplate.present) {
    if (installedDigest !== current.targetTemplateDigest && installedDigest !== current.priorTemplateDigest) throw new Error("installed DockerMan template cannot be safely restored")
    if (installedDigest !== current.priorTemplateDigest) atomicWrite(state.targetPath, state.targetTemporary, current.priorBytes, current.priorTemplate.metadata)
  } else if (installedDigest !== null) {
    if (installedDigest !== current.targetTemplateDigest) throw new Error("installed DockerMan template cannot be safely removed")
    deleteDurably(state.targetPath)
  }
  options.checkpoint?.("after-template-restore")
  deleteDurably(state.journalPath)
  return true
}

function validateFinalProof(proof, record, state) {
  const root = object(proof, "final install proof")
  const container = object(root.container, "final container proof")
  const labels = object(container.labels, "final container labels")
  if (container.name !== "/ouro-butler" || container.imageId !== record.targetImageId || container.imageReference !== record.canonicalVersionTag || container.running !== true || container.healthy !== true || container.autostart !== true) throw new Error("final container proof is invalid")
  if (labels["net.unraid.docker.managed"] !== "dockerman" || labels["net.unraid.docker.icon"] !== record.target.icon || Object.prototype.hasOwnProperty.call(labels, "net.unraid.docker.webui")) throw new Error("final container install labels are invalid")
  const bundle = object(root.bundle, "final bundle proof")
  const bundleData = object(bundle.data, "final bundle proof data")
  if (bundle.ok !== true || bundleData.parity !== "exact" || bundleData.journalState !== "absent" || bundleData.ready !== true) throw new Error("final bundle proof is invalid")
  const dockerMan = object(root.dockerMan, "final DockerMan proof")
  if (dockerMan.templatePath !== state.targetPath || dockerMan.name !== "ouro-butler" || dockerMan.repository !== record.canonicalVersionTag || dockerMan.templateUrl !== record.target.templateUrl || dockerMan.icon !== record.target.icon) throw new Error("final DockerMan proof is invalid")
  const communityApps = object(root.communityApps, "final Community Apps proof")
  const inlineImplementation = communityApps.stateModel === "previous-apps-inline-v1" && communityApps.entryPath === COMMUNITY_APPS_ENTRY_PATH && communityApps.entryFunction === "previous_apps" && communityApps.implementationPath === COMMUNITY_APPS_ENTRY_PATH && communityApps.implementationSymbol === "previous_apps"
  const helperImplementation = communityApps.stateModel === "previous-apps-helper-v1" && communityApps.entryPath === COMMUNITY_APPS_ENTRY_PATH && communityApps.entryFunction === "previous_apps" && communityApps.implementationPath === COMMUNITY_APPS_HELPER_PATH && communityApps.implementationSymbol === "PreviousAppsHelpers::collectDockerApplications"
  const recognizedImplementation = inlineImplementation || helperImplementation
  if (communityApps.installed !== true || communityApps.name !== "ouro-butler" || communityApps.repository !== record.canonicalVersionTag || communityApps.templateUrl !== record.target.templateUrl || !recognizedImplementation) throw new Error("final Community Apps proof is invalid")
  const jellyfin = validateJellyfinState(root.jellyfin, "final Jellyfin proof")
  if (JSON.stringify(jellyfin) !== JSON.stringify(record.jellyfin)) throw new Error("final Jellyfin proof is invalid")
}

export function commitDockerManTemplateTransaction(proof, options = {}) {
  const state = paths(options)
  validateParents(state)
  const current = readJournal(state)
  if (!current) return false
  requireActiveAuthority(current, state)
  if (current.state !== "committing" || currentTargetDigest(state) !== current.targetTemplateDigest) throw new Error("template transaction is not ready to commit")
  validateFinalProof(proof, current, state)
  assertJellyfinUnchanged(current.jellyfin)
  deleteDurably(state.journalPath)
  return true
}

function requireActiveAuthority(current, state) {
  const document = xmlValidator.parseDockerManTemplateXml(readFileSync(state.targetPath))
  const gateway = document?.children.some((child) => child.name === "Config" && child.attributes.Target === "/run/ouro-authority")
  if ((gateway || current.authority) && current.authority?.state !== "active") throw new Error("authority handoff is not verified")
}

function validateAuthorityPlan(raw) {
  const plan = object(raw, "authority handoff plan")
  exactKeys(plan, ["schemaVersion", "epochId", "packageDigest", "publicKeyDigest", "botId", "ownerUserId", "ownerChatId", "predecessorContract", "targetContract"], "authority handoff plan")
  if (plan.schemaVersion !== 1 || !/^[A-Za-z0-9_-]{1,128}$/u.test(plan.epochId) || !IMAGE_ID.test(plan.packageDigest) || (plan.publicKeyDigest !== null && !IMAGE_ID.test(plan.publicKeyDigest))
    || !["botId", "ownerUserId", "ownerChatId"].every((key) => typeof plan[key] === "string" && /^[1-9][0-9]*$/u.test(plan[key]))
    || plan.ownerUserId !== plan.ownerChatId || plan.predecessorContract !== "canonical-pre-gateway" || plan.targetContract !== "canonical-gateway") throw new Error("authority handoff plan is invalid")
  return plan
}

function authorityEffectIdentity(record, effect) {
  return digest(Buffer.from(JSON.stringify([record.targetImageId, record.rollbackImageId, record.reviewedManifestDigest, record.authority.plan, effect.direction, effect.step, effect.beforeDigest, effect.afterDigest])))
}

function validateAuthorityHandoff(raw, record) {
  const handoff = object(raw, "authority handoff")
  exactKeys(handoff, ["plan", "state", "completed", "rollbackCompleted", "pending", "cancelled"], "authority handoff")
  validateAuthorityPlan(handoff.plan)
  if (!["installing", "active", "retiring", "retired"].includes(handoff.state) || !Array.isArray(handoff.completed) || !Array.isArray(handoff.rollbackCompleted) || !Array.isArray(handoff.cancelled)) throw new Error("authority handoff state is invalid")
  const validateEffect = (effect, direction, step) => {
    object(effect, "authority effect")
    exactKeys(effect, ["direction", "step", "effectId", "beforeDigest", "afterDigest"], "authority effect")
    if (effect.direction !== direction || effect.step !== step || !IMAGE_ID.test(effect.beforeDigest) || !IMAGE_ID.test(effect.afterDigest) || effect.beforeDigest === effect.afterDigest
      || effect.effectId !== authorityEffectIdentity(record, effect)) throw new Error("authority effect identity is invalid")
  }
  for (const [direction, entries, steps] of [["install", handoff.completed, AUTHORITY_INSTALL_STEPS], ["rollback", handoff.rollbackCompleted, AUTHORITY_ROLLBACK_STEPS]]) {
    if (entries.length > steps.length) throw new Error("authority effect order is invalid")
    entries.forEach((effect, index) => validateEffect(effect, direction, steps[index]))
  }
  const rollback = handoff.state === "retiring" || handoff.state === "retired"
  if (handoff.cancelled.length > 1 || (handoff.cancelled.length !== 0 && !rollback)) throw new Error("authority cancelled effect is invalid")
  for (const effect of handoff.cancelled) validateEffect(effect, "install", AUTHORITY_INSTALL_STEPS[handoff.completed.length])
  if ((!rollback && handoff.rollbackCompleted.length !== 0) || (handoff.state === "active" && handoff.completed.length !== AUTHORITY_INSTALL_STEPS.length)
    || (handoff.state === "retired" && handoff.rollbackCompleted.length !== AUTHORITY_ROLLBACK_STEPS.length)) throw new Error("authority terminal handoff is invalid")
  if (handoff.pending !== null) {
    if (handoff.state === "active" || handoff.state === "retired") throw new Error("authority terminal handoff has a pending effect")
    const steps = rollback ? AUTHORITY_ROLLBACK_STEPS : AUTHORITY_INSTALL_STEPS
    const completed = rollback ? handoff.rollbackCompleted : handoff.completed
    validateEffect(handoff.pending, rollback ? "rollback" : "install", steps[completed.length])
  }
  return handoff
}

function writeAuthorityHandoff(record, authority, state) {
  const { priorBytes: _bytes, digest: _digest, ...unsigned } = record
  const next = { ...unsigned, authority }
  validateAuthorityHandoff(authority, next)
  return writeJournal(next, state)
}

export function beginDockerManAuthorityHandoff(plan, options = {}) {
  validateAuthorityPlan(plan)
  const state = paths(options)
  validateParents(state)
  const current = readJournal(state)
  if (!current || (!current.authority && current.state !== "rollback")) throw new Error("authority handoff requires the prepared deployment transaction")
  assertJellyfinUnchanged(current.jellyfin)
  if (current.authority) {
    if (JSON.stringify(current.authority.plan) !== JSON.stringify(plan)) throw new Error("authority handoff plan changed")
    return current.authority
  }
  return writeAuthorityHandoff(current, { plan, state: "installing", completed: [], rollbackCompleted: [], cancelled: [], pending: null }, state).authority
}

async function withAuthorityLease(options, work) {
  const state = paths(options)
  validateParents(state)
  const withLease = options.withLease ?? (await import("../../dist/mind/session-transaction.js")).withSessionTurnLease
  return withLease(state.journalPath, () => work(state), { timeoutMs: 0, confinementRoot: state.journalParent })
}

export async function runDockerManAuthorityEffect(name, effect, options = {}) {
  return withAuthorityLease(options, (state) => runAuthorityEffectLocked(name, effect, state))
}

export async function beginDockerManAuthorityRollback(readback, options = {}) {
  return withAuthorityLease(options, (state) => beginAuthorityRollbackLocked(readback, state))
}

async function beginAuthorityRollbackLocked(readback, state) {
    const current = readJournal(state)
    if (!current?.authority) throw new Error("authority handoff is absent")
    const handoff = current.authority
    if (handoff.state === "retired" || handoff.state === "retiring") return handoff
    const pending = handoff.pending
    const observed = pending ? await readback() : null
    if (pending && observed !== pending.beforeDigest && observed !== pending.afterDigest) throw new Error("authority pending effect is ambiguous")
    if (readJournal(state).digest !== current.digest) throw new Error("authority transaction changed during recovery")
    assertJellyfinUnchanged(current.jellyfin)
    return writeAuthorityHandoff(current, {
      ...handoff, state: "retiring", pending: null,
      completed: pending && observed === pending.afterDigest ? [...handoff.completed, pending] : handoff.completed,
      cancelled: pending && observed === pending.beforeDigest ? [...handoff.cancelled, pending] : handoff.cancelled,
    }, state).authority
}

async function runAuthorityEffectLocked(name, effect, state) {
  let current = readJournal(state)
  if (!current?.authority) throw new Error("authority handoff is absent")
  assertJellyfinUnchanged(current.jellyfin)
  const direction = name.startsWith("rollback:") ? "rollback" : "install"
  const step = direction === "rollback" ? name.slice("rollback:".length) : name
  const steps = direction === "rollback" ? AUTHORITY_ROLLBACK_STEPS : AUTHORITY_INSTALL_STEPS
  if (!steps.includes(step)) throw new Error("authority handoff step is invalid")
  if (!IMAGE_ID.test(effect.beforeDigest) || !IMAGE_ID.test(effect.afterDigest) || effect.beforeDigest === effect.afterDigest) throw new Error("authority effect identity is invalid")
  let handoff = current.authority
  if (direction === "install" && ["retiring", "retired"].includes(handoff.state)) throw new Error("authority handoff is retiring")
  const expected = { direction, step, beforeDigest: effect.beforeDigest, afterDigest: effect.afterDigest }
  const intent = { ...expected, effectId: authorityEffectIdentity(current, expected) }
  const completedKey = direction === "install" ? "completed" : "rollbackCompleted"
  const completed = handoff[completedKey]
  const prior = completed.find((entry) => entry.step === step)
  if (prior) {
    if (prior.effectId !== intent.effectId || await effect.readback() !== prior.afterDigest) throw new Error("authority completed effect changed")
    return prior
  }
  if (steps[completed.length] !== step) throw new Error("authority handoff effect order is invalid")
  if (handoff.pending && handoff.pending.effectId !== intent.effectId) throw new Error("authority pending effect changed; recovery is required before rollback")
  if (!handoff.pending) {
    handoff = { ...handoff, state: direction === "rollback" ? "retiring" : "installing", pending: intent }
    current = writeAuthorityHandoff(current, handoff, state)
  }
  const observed = await effect.readback()
  if (observed !== intent.beforeDigest && observed !== intent.afterDigest) throw new Error("authority handoff effect is ambiguous")
  if (observed === intent.beforeDigest) await effect.apply(intent.effectId)
  if (await effect.readback() !== intent.afterDigest) throw new Error("authority handoff effect readback failed")
  const latest = readJournal(state)
  if (latest.digest !== current.digest) throw new Error("authority transaction changed during effect")
  assertJellyfinUnchanged(latest.jellyfin)
  const entries = [...completed, intent]
  handoff = { ...handoff, [completedKey]: entries, pending: null, state: entries.length === steps.length ? direction === "install" ? "active" : "retired" : direction === "install" ? "installing" : "retiring" }
  writeAuthorityHandoff(latest, handoff, state)
  return intent
}

export function verifyDockerManTemplateTransactionJellyfin(options = {}) {
  const state = paths(options)
  validateParents(state)
  const current = readJournal(state)
  if (!current) throw new Error("template transaction journal is absent")
  assertJellyfinUnchanged(current.jellyfin)
  return true
}

export function decideDockerManTemplateRecovery(record, evidence) {
  const state = record?.state
  const bundle = evidence?.bundleJournalState
  const production = evidence?.production
  if (!["rollback", "committing"].includes(state) || !["absent", "rollback", "committing"].includes(bundle) || !["rollback-exact", "target-exact-committing", "target-exact-ready", "adoption-source-exact", "adoption-target-exact-ready", "adoption-evidence-exact-stopped"].includes(production)) throw new Error("template transaction recovery evidence is invalid")
  if (bundle === "rollback" && production === "rollback-exact") return "rollback-both"
  if (state === "committing" && bundle === "committing" && production === "target-exact-committing") {
    const inspection = evidence?.inspection
    if (inspection?.ok !== true || inspection?.data?.parity !== "exact" || inspection?.data?.journalState !== "committing" || inspection?.data?.ready !== false) throw new Error("template transaction recovery inspection is invalid")
    return "finish-bundle-commit"
  }
  if (state === "committing" && bundle === "absent" && production === "target-exact-ready") {
    const inspection = evidence?.inspection
    if (inspection?.ok !== true || inspection?.data?.parity !== "exact" || inspection?.data?.journalState !== "absent" || inspection?.data?.ready !== true) throw new Error("template transaction recovery inspection is invalid")
    return "finish-template-commit"
  }
  if (bundle === "absent" && production === "rollback-exact") return "restore-prior-template"
  if (state === "rollback" && bundle === "absent" && production === "adoption-source-exact") return "restore-prior-template"
  if (state === "rollback" && bundle === "absent" && production === "adoption-target-exact-ready") {
    const inspection = evidence?.inspection
    if (inspection?.ok !== true || inspection?.data?.parity !== "exact" || inspection?.data?.journalState !== "absent" || inspection?.data?.ready !== true) throw new Error("template transaction recovery inspection is invalid")
    return "roll-forward-adoption"
  }
  if (state === "rollback" && bundle === "absent" && production === "adoption-evidence-exact-stopped") return "quarantine-adoption"
  throw new Error("template and bundle transaction topology is incompatible")
}

function parseArguments(argv) {
  const [operation, ...rest] = argv
  const values = new Map()
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]
    const value = rest[index + 1]
    if (!flag?.startsWith("--") || !value || values.has(flag)) throw new Error("template transaction arguments are invalid")
    values.set(flag, value)
  }
  return { operation, values }
}

function readRootJson(path, label) {
  validateRegularFile(path, 0, 0, label)
  try { return JSON.parse(readFileSync(path, "utf8")) } catch { throw new Error(`${label} JSON is invalid`) }
}

export function runDockerManTemplateTransactionCli(argv, options = {}, write = (text) => process.stdout.write(text)) {
  const { operation, values } = parseArguments(argv)
  if (operation?.startsWith("authority-") && values.size === 0) {
    return runRootLifecycle(operation, options).then((result) => write(`${JSON.stringify(result)}\n`))
  }
  let result
  if (operation === "prepare" && values.size === 5) {
    result = prepareDockerManTemplateTransaction({
      sourceTemplatePath: values.get("--source-template"),
      canonicalVersionTag: values.get("--version-tag"),
      reviewedManifestDigest: values.get("--manifest-digest"),
      rollbackImageId: values.get("--rollback-image-id"),
      targetImageId: values.get("--target-image-id"),
    }, options)
  } else if (operation === "mark-committing" && values.size === 0) {
    ensureJournalParent(paths(options))
    result = markDockerManTemplateTransactionCommitting(options)
  } else if (operation === "rollback" && values.size === 0) {
    ensureJournalParent(paths(options))
    result = { rolledBack: rollbackDockerManTemplateTransaction(options) }
  } else if (operation === "commit" && values.size === 1 && values.get("--proof")) {
    ensureJournalParent(paths(options))
    result = { committed: commitDockerManTemplateTransaction(readRootJson(values.get("--proof"), "final install proof"), options) }
  } else if (operation === "status" && values.size === 0) {
    ensureJournalParent(paths(options))
    result = inspectDockerManTemplateTransaction(options)
  } else if (operation === "recover-status" && values.size === 0) {
    const state = paths(options)
    if (!metadataIfPresent(state.journalParent)) {
      inspectCurrentJellyfinState()
      ensureJournalParent(state)
    }
    result = inspectDockerManTemplateTransactionForRecovery(options)
  } else if (operation === "recovery-identity" && values.size === 0) {
    const state = paths(options)
    if (!metadataIfPresent(state.journalParent)) {
      inspectCurrentJellyfinState()
      result = null
    } else {
      result = inspectDockerManTemplateTransactionRecoveryIdentity(options)
    }
  } else if (operation === "recovery-action" && values.size === 1 && values.get("--evidence")) {
    ensureJournalParent(paths(options))
    const record = inspectDockerManTemplateTransaction(options)
    if (!record) throw new Error("template transaction journal is absent")
    result = { action: decideDockerManTemplateRecovery(record, readRootJson(values.get("--evidence"), "template recovery evidence")) }
  } else if (operation === "verify-jellyfin" && values.size === 0) {
    result = { unchanged: verifyDockerManTemplateTransactionJellyfin(options) }
  } else if (operation === "jellyfin-status" && values.size === 0) {
    result = inspectCurrentJellyfinState()
  } else {
    throw new Error("Usage: docker-man-template-transaction.mjs <prepare|mark-committing|rollback|commit|status|recover-status|recovery-identity|recovery-action|verify-jellyfin|jellyfin-status> [fixed operation arguments]")
  }
  write(`${JSON.stringify(result)}\n`)
}

async function runRootLifecycle(operation, options) {
  const selected = {
    "authority-install": AUTHORITY_INSTALL_STEPS.slice(0, 6),
    "authority-activate": AUTHORITY_INSTALL_STEPS.slice(6),
    "authority-retire": AUTHORITY_ROLLBACK_STEPS.slice(0, 6).map((step) => `rollback:${step}`),
    "authority-restore": AUTHORITY_ROLLBACK_STEPS.slice(6).map((step) => `rollback:${step}`),
  }[operation]
  if (!selected) throw new Error("authority lifecycle operation is invalid")
  return withAuthorityLease(options, async (state) => {
  let record = readJournal(state)
  if (!record) throw new Error("authority lifecycle requires the prepared deployment transaction")
  const RootLifecycle = options.RootLifecycle ?? (await import("../../dist/heart/daemon/sanctuary-authority-root-lifecycle.js")).SanctuaryAuthorityRootLifecycle
  const lifecycle = new RootLifecycle(record, options.rootLifecycleOptions)
  beginDockerManAuthorityHandoff(lifecycle.plan(), options)
  record = readJournal(state)
  if (["authority-install", "authority-activate"].includes(operation) && ["retiring", "retired"].includes(record.authority.state)) throw new Error("authority epoch is retiring or retired")
  if (operation === "authority-activate" && record.authority.completed.length < 6) throw new Error("gateway installation must finish before resident activation")
  if (operation === "authority-restore" && record.authority.rollbackCompleted.length < 6) throw new Error("authority retirement must finish before resident restoration")
  if (operation === "authority-retire") {
    const pending = record.authority.pending
    await beginAuthorityRollbackLocked(pending ? lifecycle.effect(pending.step).readback : null, state)
  }
  for (const name of selected) {
    const rollback = name.startsWith("rollback:")
    const step = rollback ? name.slice("rollback:".length) : name
    const current = readJournal(state).authority
    // Completed historical effects may have intentionally changed at later
    // steps (a frozen resident becomes running). Recheck the next real boundary,
    // never replay earlier physical work merely to reproduce a historical hash.
    if (current[rollback ? "rollbackCompleted" : "completed"].some((entry) => entry.step === step)) continue
    await runAuthorityEffectLocked(name, lifecycle.effect(name), state)
  }
  return readJournal(state).authority
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await runDockerManTemplateTransactionCli(process.argv.slice(2))
