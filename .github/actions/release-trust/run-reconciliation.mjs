import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { gunzipSync } from "node:zlib"

import { canonicalize } from "./canonicalize.mjs"
import {
  constructInceptionSealBody,
  constructInceptionSealStatement,
  validateFoundation,
  validateProtectedMergeSemantics,
} from "./protected-store.mjs"
import { validateExecutionClosure } from "./workflow-closure.mjs"

const RESULT_CEILING = 1000
const MAXIMUM_FIELD_BYTES = 1024 * 1024
const SHA1 = /^[a-f0-9]{40}$/
const SHA256 = /^[a-f0-9]{64}$/
const REPOSITORY = "ourostack/ouroboros"
const REPOSITORY_ID = "1169669354"
const REPOSITORY_NODE_ID = "R_kgDORbe86g"
const SEAL_WORKFLOW_PATH = ".github/workflows/release-trust-inception-seal.yml"
const AUTHORITY_PATHS = Object.freeze([
  "release/trust/release-trust-bootstrap-evidence.v1.json",
  "release/trust/release-trust-inception-authority.v1.json",
  "release/trust/release-trust-policy-head.v1.json",
])
const CARRIER_PATH = "release/trust/release-trust-inception-seal.v1.json"
const SIGNING_M0_PATHS = Object.freeze([
  "developer-id-pair-active-authority.v1.json",
  "developer-id-pair-canary-artifact-acquisition.v1.json",
  "developer-id-pair-canary-dispatch-authority.v1.json",
  "developer-id-pair-canary-dispatch-intent.v1.json",
  "developer-id-pair-canary-dispatch-observation.v1.json",
  "developer-id-pair-canary-receipt-body.v1.json",
  "developer-id-pair-canary-receipt-body.v1.sigstore.json",
  "developer-id-pair-canary-request.v1.json",
  "developer-id-pair-canary-run-binding.v1.json",
  "developer-id-pair-canary-verification.v1.json",
  "developer-id-provisioning-p12-secret-submission-receipt.v1.json",
  "developer-id-provisioning-password-secret-submission-receipt.v1.json",
  "developer-id-provisioning-receipt.v1.json",
  "developer-id-provisioning-variable-submission-receipt.v1.json",
])
const TRUST_TCB_PATHS = Object.freeze([
  ".github/actions/release-trust/canonicalize.mjs",
  ".github/actions/release-trust/protected-store.mjs",
  ".github/actions/release-trust/run-reconciliation.mjs",
  ".github/actions/release-trust/workflow-closure.mjs",
  "package.json",
  "package-lock.json",
])

const SECRET_WORKFLOWS = Object.freeze({
  "pair-canary": {
    workflowPath: ".github/workflows/developer-id-pair-canary.yml",
    driverPath: "native/developer-id-pair-canary/driver.c",
    closurePath: "release/trust/developer-id-pair-canary-execution-closure.v1.json",
    policyPath: "release/trust/developer-id-pair-canary-trust-policy.v1.json",
    authorityWorkflowHash: "pairCanaryWorkflowBlobSha256",
    authorityClosureHash: "pairCanaryExecutionClosureSha256",
    authorityPolicyHash: "pairCanaryTrustPolicySha256",
    driverKind: "secret",
    inputBindings: [
      ["requestBase64", "requestSha256", "json"],
      ["dispatchAuthorityBase64", "dispatchAuthoritySha256", "json"],
    ],
    correlationField: "dispatchCorrelationId",
  },
  signing: {
    workflowPath: ".github/workflows/developer-id-signing.yml",
    driverPath: "native/developer-id-signing/driver.c",
    closurePath: "release/trust/developer-id-signing-execution-closure.v1.json",
    policyPath: "release/trust/release-trust-policy.v1.json",
    authorityWorkflowHash: "signingWorkflowBlobSha256",
    authorityClosureHash: "signingExecutionClosureSha256",
    authorityPolicyHash: "initialPolicySha256",
    driverKind: "signing",
    inputBindings: [
      ["handoffControlBase64", "handoffSha256", "json"],
      ["m0EvidenceGzipBase64", "m0EvidenceGzipSha256", "bytes"],
      ["dispatchAttemptAuthorityBase64", "dispatchAttemptAuthoritySha256", "json"],
    ],
    correlationField: "dispatchCorrelationId",
    dispatchIdField: "dispatchId",
  },
})

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function sameExecutableIdentity(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
}

function hashStableExecutable(path, fileSystem) {
  if (!path.startsWith("/") || fileSystem.realpath(path) !== path) {
    throw new TypeError("system executable realpath is not canonical")
  }
  const pathBefore = fileSystem.lstat(path)
  if (!pathBefore.isFile() || (pathBefore.mode & 0o111) === 0) {
    throw new TypeError("system executable is not an executable regular file")
  }
  let descriptor
  try {
    descriptor = fileSystem.open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    const descriptorBefore = fileSystem.fstat(descriptor)
    if (!sameExecutableIdentity(pathBefore, descriptorBefore)) {
      throw new TypeError("system executable identity changed before measurement")
    }
    const digest = sha256(fileSystem.read(descriptor))
    const descriptorAfter = fileSystem.fstat(descriptor)
    const pathAfter = fileSystem.lstat(path)
    if (!sameExecutableIdentity(descriptorBefore, descriptorAfter)
      || !sameExecutableIdentity(descriptorAfter, pathAfter)) {
      throw new TypeError("system executable identity changed during measurement")
    }
    return digest
  } finally {
    if (descriptor !== undefined) fileSystem.close(descriptor)
  }
}

function resolveClangWithXcrun(xcrunPath, spawnProcess) {
  const result = spawnProcess(xcrunPath, ["--find", "clang"], {
    encoding: "utf8",
    env: {},
    stdio: ["ignore", "pipe", "pipe"],
  })
  const path = typeof result.stdout === "string" ? result.stdout.trim() : ""
  if (result.error !== undefined || result.status !== 0 || !path.startsWith("/")) {
    throw new TypeError("clang executable could not be resolved by xcrun")
  }
  return path
}

export function verifyLiveSystemExecutables({
  entries,
  currentNodeExecutable = process.execPath,
  resolveClang,
  spawn = spawnSync,
  fileSystem = {
    close: closeSync,
    fstat: fstatSync,
    lstat: lstatSync,
    open: openSync,
    read: readFileSync,
    realpath: realpathSync.native,
  },
} = {}) {
  if (!Array.isArray(entries) || typeof currentNodeExecutable !== "string"
    || (resolveClang !== undefined && typeof resolveClang !== "function")
    || typeof spawn !== "function") {
    throw new TypeError("live system executable evidence is invalid")
  }
  const executableEntries = entries.filter((entry) => entry?.kind === "system-executable")
  const evidence = new Map()
  for (const entry of executableEntries) {
    const command = basename(entry.realpath ?? "")
    if (!["clang", "node", "xcrun"].includes(command) || evidence.has(command)) {
      throw new TypeError("live system executable evidence is invalid")
    }
    evidence.set(command, entry)
  }
  if (evidence.size !== 3) throw new TypeError("live system executable evidence is incomplete")
  const node = evidence.get("node")
  const xcrun = evidence.get("xcrun")
  const clang = evidence.get("clang")
  if (fileSystem.realpath(currentNodeExecutable) !== node.realpath) {
    throw new TypeError("node executable identity does not match the closure")
  }
  for (const entry of [node, xcrun]) {
    if (!SHA256.test(entry.sha256 ?? "")
      || hashStableExecutable(entry.realpath, fileSystem) !== entry.sha256) {
      throw new TypeError("live system executable digest does not match the closure")
    }
  }
  const resolvedClang = resolveClang === undefined
    ? resolveClangWithXcrun(xcrun.realpath, spawn)
    : resolveClang(xcrun.realpath)
  if (fileSystem.realpath(resolvedClang) !== clang.realpath) {
    throw new TypeError("clang executable identity does not match the closure")
  }
  if (!SHA256.test(clang.sha256 ?? "")
    || hashStableExecutable(clang.realpath, fileSystem) !== clang.sha256) {
    throw new TypeError("live system executable digest does not match the closure")
  }
  return { ok: true }
}

export function normalizeWorkflowPath(value) {
  if (typeof value !== "string" || !value.startsWith(".github/workflows/") || value === ".github/workflows/") {
    throw new TypeError("workflow path must name a repository workflow")
  }
  const at = value.indexOf("@")
  if (at === -1) return value
  if (!value.endsWith("@main") || at !== value.length - "@main".length) {
    throw new TypeError("workflow path suffix must be literal @main")
  }
  return value.slice(0, -"@main".length)
}

export function verifyOidcWorkflowRef({ claim, repository, workflowPath, ref }) {
  const expected = `${repository}/${workflowPath}@${ref}`
  return claim === expected
    ? { ok: true }
    : { ok: false, code: "workflow_ref_mismatch" }
}

export function buildDispatchIntent({
  repository,
  workflowId,
  apiVersion,
  requestBytes,
  authorityBytes,
  bodyBytes,
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    || !Number.isSafeInteger(workflowId) || workflowId < 1
    || !/^\d{4}-\d{2}-\d{2}$/.test(apiVersion)
    || [requestBytes, authorityBytes, bodyBytes].some((value) => typeof value !== "string")) {
    throw new TypeError("invalid workflow dispatch authority")
  }
  return {
    method: "POST",
    url: `https://api.github.com/repos/${repository}/actions/workflows/${workflowId}/dispatches`,
    headers: {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": apiVersion,
    },
    requestBytes,
    requestSha256: sha256(requestBytes),
    authorityBytes,
    authoritySha256: sha256(authorityBytes),
    bodyBytes,
    bodySha256: sha256(bodyBytes),
    postAllowed: true,
  }
}

function retainedPage(page) {
  return {
    requestBytes: page.requestBytes,
    responseBytes: page.responseBytes,
    linkBytes: page.linkBytes,
    requestSha256: sha256(page.requestBytes),
    responseSha256: sha256(page.responseBytes),
    linkSha256: sha256(page.linkBytes),
  }
}

function runMatchesAuthority(run, authority) {
  if (!run || run.id !== authority.selfRunId
    || run.display_title !== authority.correlationTitle
    || run.workflow_id !== authority.workflowId
    || run.event !== "workflow_dispatch"
    || run.head_branch !== "main"
    || run.head_sha !== authority.headSha
    || run.run_attempt !== 1
    || !Number.isSafeInteger(run.id)) {
    return false
  }
  let normalizedPath
  try {
    normalizedPath = normalizeWorkflowPath(run.path)
  } catch {
    return false
  }
  if (normalizedPath !== authority.workflowPath) return false
  const createdAt = Date.parse(run.created_at)
  return Number.isFinite(createdAt)
    && createdAt >= authority.createdAtOrAfter
    && createdAt <= authority.createdAtOrBefore
}

export function scanWorkflowRuns({
  pages,
  correlationTitle,
  selfRunId,
  workflowId,
  workflowPath,
  headSha,
  inclusiveWindow,
}) {
  const createdAtOrAfter = Date.parse(inclusiveWindow?.createdAtOrAfter)
  const createdAtOrBefore = Date.parse(inclusiveWindow?.createdAtOrBefore)
  if (!Array.isArray(pages) || pages.length === 0 || typeof correlationTitle !== "string"
    || !Number.isSafeInteger(selfRunId) || selfRunId < 1
    || !Number.isSafeInteger(workflowId) || workflowId < 1
    || typeof workflowPath !== "string" || !SHA1.test(headSha ?? "")
    || !Number.isFinite(createdAtOrAfter) || !Number.isFinite(createdAtOrBefore)
    || createdAtOrAfter > createdAtOrBefore) {
    return { state: "incomplete" }
  }
  const retained = []
  const runs = []
  let observedTotal = null
  for (const page of pages) {
    if ([page?.requestBytes, page?.responseBytes, page?.linkBytes].some((value) => typeof value !== "string")) {
      return { state: "incomplete" }
    }
    retained.push(retainedPage(page))
    let decoded
    try {
      decoded = JSON.parse(page.responseBytes)
    } catch {
      return { state: "incomplete", pages: retained }
    }
    if (!Number.isSafeInteger(decoded.total_count) || decoded.total_count < 0 || !Array.isArray(decoded.workflow_runs)) {
      return { state: "incomplete", pages: retained }
    }
    if (decoded.total_count > RESULT_CEILING) {
      return {
        state: "ceiling_exceeded",
        ceiling: RESULT_CEILING,
        observedTotal: decoded.total_count,
        pages: retained,
      }
    }
    if (observedTotal === null) observedTotal = decoded.total_count
    if (observedTotal !== decoded.total_count) {
      return { state: "incomplete", pages: retained, observedTotal }
    }
    runs.push(...decoded.workflow_runs)
  }
  if (pages.at(-1).linkBytes !== "" || runs.length !== observedTotal) {
    return { state: "incomplete", pages: retained, observedTotal }
  }
  const matching = runs.filter((run) => runMatchesAuthority(run, {
    correlationTitle,
    selfRunId,
    workflowId,
    workflowPath,
    headSha,
    createdAtOrAfter,
    createdAtOrBefore,
  }))
  if (matching.length === 0) {
    return { state: "none", observedTotal, pages: retained }
  }
  if (matching.length > 1) {
    return { state: "multiple", observedTotal, pages: retained }
  }
  return { state: "unique", runId: matching[0].id, observedTotal, pages: retained }
}

export function reconcileDispatch(input) {
  if (input?.state !== "intent-persisted" || !input.intent) {
    throw new TypeError("reconciliation requires a persisted dispatch intent")
  }
  return {
    state: "dispatch-outcome-unknown",
    intent: input.intent,
    postAllowed: false,
  }
}

export function authorizeTerminalSupersession(input) {
  if (!input?.uniqueRunBinding) {
    return { ok: false, code: "unique_run_required" }
  }
  const terminal = input.terminalInspection
  if (!terminal
    || terminal.runId !== input.uniqueRunBinding.runId
    || terminal.runAttempt !== input.uniqueRunBinding.runAttempt
    || !["failure", "cancelled", "timed_out"].includes(terminal.conclusion)) {
    return { ok: false, code: "terminal_run_required" }
  }
  const inventory = input.artifactInventory
  if (!inventory || !Array.isArray(inventory.scans) || inventory.scans.length !== 2
    || inventory.scans.some((scan) => scan.complete !== true)
    || inventory.scans[0].artifactSetSha256 !== inventory.scans[1].artifactSetSha256) {
    return { ok: false, code: "artifact_inventory_incomplete" }
  }
  if (inventory.scans.some((scan) => scan.validCompleteArtifactIds?.length > 0)) {
    return { ok: false, code: "valid_artifact_exists" }
  }
  if (!Array.isArray(inventory.expiredUnavailableArtifactIds)
    || inventory.expiredUnavailableArtifactIds.length > 0) {
    return { ok: false, code: "artifact_inventory_ambiguous" }
  }
  return { ok: false, code: "verification_evidence_required" }
}

export function frameFields(fields) {
  const count = Buffer.alloc(4)
  count.writeUInt32BE(fields.length)
  const chunks = [count]
  for (const field of fields) {
    if (field.length > MAXIMUM_FIELD_BYTES) {
      throw new RangeError("driver field exceeds the fixed byte ceiling")
    }
    const length = Buffer.alloc(4)
    length.writeUInt32BE(field.length)
    chunks.push(length, field)
  }
  return Buffer.concat(chunks)
}

export function runNativeFrame(
  executable,
  fieldCount,
  environment = process.env,
  output = { stdout: process.stdout, stderr: process.stderr },
) {
  if (!Number.isSafeInteger(fieldCount) || fieldCount < 1 || fieldCount > 16) {
    throw new TypeError("native frame field count is invalid")
  }
  const fields = []
  let frame
  try {
    for (let ordinal = 1; ordinal <= fieldCount; ordinal += 1) {
      const name = `OURO_DRIVER_FIELD_${ordinal}`
      const value = environment[name]
      delete environment[name]
      if (typeof value !== "string" || value.length === 0) {
        throw new TypeError(`missing ${name}`)
      }
      fields.push(Buffer.from(value, "utf8"))
    }
    frame = frameFields(fields)
    const result = spawnSync(executable, ["--execute"], {
      input: frame,
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
    })
    output.stdout.write(result.stdout)
    output.stderr.write(result.stderr)
    if (result.error) throw result.error
    return result.status ?? 70
  } finally {
    if (frame) frame.fill(0)
    for (const field of fields) field.fill(0)
  }
}

function canonicalDocument(bytes, label) {
  let value
  try {
    value = JSON.parse(bytes)
  } catch {
    throw new TypeError(`${label} is not JSON`)
  }
  if (canonicalize(value) !== bytes) {
    throw new TypeError(`${label} is not exact JCS`)
  }
  return value
}

function readCanonical(root, path, label) {
  const bytes = readFileSync(join(root, path), "utf8")
  return { bytes, value: canonicalDocument(bytes, label), sha256: sha256(bytes) }
}

function readJson(root, path, label) {
  const bytes = readFileSync(join(root, path), "utf8")
  let value
  try {
    value = JSON.parse(bytes)
  } catch {
    throw new TypeError(`${label} is not JSON`)
  }
  return { bytes, value, sha256: sha256(bytes) }
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TypeError(`${label} is not canonical base64`)
  }
  const bytes = Buffer.from(value, "base64")
  if (bytes.length === 0 || bytes.toString("base64") !== value) {
    throw new TypeError(`${label} is not canonical base64`)
  }
  return bytes
}

function validateDispatchInputs(config, inputs) {
  if (!inputs || typeof inputs !== "object") throw new TypeError("workflow inputs are missing")
  const decoded = new Map()
  for (const [base64Field, hashField, kind] of config.inputBindings) {
    const bytes = decodeCanonicalBase64(inputs[base64Field], base64Field)
    try {
      if (!SHA256.test(inputs[hashField] ?? "") || sha256(bytes) !== inputs[hashField]) {
        throw new TypeError(`${base64Field} hash mismatch`)
      }
      decoded.set(base64Field, kind === "json"
        ? canonicalDocument(bytes.toString("utf8"), base64Field)
        : null)
    } finally {
      bytes.fill(0)
    }
  }
  const correlation = inputs[config.correlationField]
  if (typeof correlation !== "string" || correlation.length === 0 || correlation.length > 128) {
    throw new TypeError("dispatch correlation is invalid")
  }
  const authorityField = config.inputBindings.at(-1)[0]
  const authority = decoded.get(authorityField)
  if (authority?.dispatchCorrelationId !== correlation) {
    throw new TypeError("dispatch correlation authority mismatch")
  }
  if (config.dispatchIdField) {
    const dispatchId = inputs[config.dispatchIdField]
    if (typeof dispatchId !== "string" || dispatchId.length === 0 || authority.dispatchId !== dispatchId) {
      throw new TypeError("dispatch identity authority mismatch")
    }
  }
  return decoded
}

function validateMainRunEnvironment(config, environment) {
  const runId = Number(environment.GITHUB_RUN_ID)
  if (environment.GITHUB_REPOSITORY !== REPOSITORY
    || environment.GITHUB_REPOSITORY_ID !== REPOSITORY_ID
    || environment.GITHUB_REF !== "refs/heads/main"
    || !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID ?? "")
    || !Number.isSafeInteger(runId)
    || environment.GITHUB_RUN_ATTEMPT !== "1"
    || !SHA1.test(environment.GITHUB_SHA ?? "")
    || environment.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${config.workflowPath}@refs/heads/main`
    || environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA) {
    throw new TypeError("secret workflow is not exact protected main")
  }
}

function validateProtectedTrust(config, root, systemExecutableVerifier) {
  const authority = readCanonical(
    root,
    "release/trust/release-trust-inception-authority.v1.json",
    "inception authority",
  )
  const head = readCanonical(
    root,
    "release/trust/release-trust-policy-head.v1.json",
    "release trust head",
  )
  const closure = readCanonical(root, config.closurePath, "execution closure")
  const policy = readCanonical(root, config.policyPath, "trust policy")
  const foundation = readJson(
    root,
    "release/trust/sigstore-foundation.v1.json",
    "Sigstore foundation",
  )
  const workflowBytes = readFileSync(join(root, config.workflowPath), "utf8")
  const driverBytes = readFileSync(join(root, config.driverPath))
  const checkedOutFileBytesByPath = Object.fromEntries([
    ...TRUST_TCB_PATHS.map((path) => [path, readFileSync(join(root, path))]),
    [config.driverPath, driverBytes],
  ])
  const systemExecutableEvidenceByCommand = Object.fromEntries(
    closure.value.entries
      .filter((entry) => entry.kind === "system-executable")
      .map((entry) => [entry.realpath.split("/").at(-1), {
        realpath: entry.realpath,
        sha256: entry.sha256,
        designatedRequirementSha256: entry.designatedRequirementSha256,
      }]),
  )
  const value = authority.value
  if (value.schemaVersion !== 1
    || value.authorityKind !== "one-time-protected-main-trust-inception-v1"
    || value.repository !== REPOSITORY
    || value.repositoryDatabaseId !== Number(REPOSITORY_ID)
    || value.repositoryNodeId !== REPOSITORY_NODE_ID
    || value[config.authorityWorkflowHash] !== sha256(workflowBytes)
    || value[config.authorityClosureHash] !== closure.sha256
    || value[config.authorityPolicyHash] !== policy.sha256
    || value.pairCanaryFoundationSha256 !== foundation.sha256) {
    throw new TypeError("workflow authority does not bind exact protected bytes")
  }
  if (head.value.schemaVersion !== 1
    || head.value.revision !== 1
    || head.value.priorHeadSha256 !== null
    || head.value.activation?.kind !== "inception"
    || head.value.activation.authoritySha256 !== authority.sha256
    || head.value.activePolicyVersion !== 1
    || head.value.activePolicySha256 !== value.initialPolicySha256) {
    throw new TypeError("release trust head is not the sealed inception head")
  }
  const closureResult = validateExecutionClosure({
    closure: closure.value,
    workflowPath: config.workflowPath,
    workflowBytes,
    driverPath: config.driverPath,
    driverBytes,
    driverKind: config.driverKind,
    checkedOutFileBytesByPath,
    systemExecutableEvidenceByCommand,
  })
  if (!closureResult.ok) {
    throw new TypeError("execution closure is incomplete")
  }
  if (typeof systemExecutableVerifier !== "function"
    || systemExecutableVerifier({ entries: closure.value.entries })?.ok !== true) {
    throw new TypeError("live system executable evidence is invalid")
  }
  const foundationResult = validateFoundation(foundation.value)
  if (!foundationResult.ok) throw new TypeError(`Sigstore foundation rejected: ${foundationResult.code}`)
}

export function admitSecretWorkflow(kind, {
  environment = process.env,
  root = process.cwd(),
  systemExecutableVerifier = verifyLiveSystemExecutables,
  trustVerifier = () => false,
} = {}) {
  const config = SECRET_WORKFLOWS[kind]
  if (!config) throw new TypeError("unknown secret workflow")
  validateMainRunEnvironment(config, environment)
  const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"))
  validateDispatchInputs(config, event.inputs)
  validateProtectedTrust(config, root, systemExecutableVerifier)
  if (typeof trustVerifier !== "function" || trustVerifier({ kind, config, event, environment, root }) !== true) {
    throw new TypeError("cryptographic verification evidence required")
  }
  return { ok: true }
}

function exactCommitment(commitment, domain, request) {
  return Boolean(commitment
    && commitment.scheme === "sha256-jcs-one-time-nonce-v1"
    && commitment.domain === domain
    && commitment.transactionId === request.transactionId
    && commitment.attemptId === request.attemptId
    && commitment.pairGenerationId === request.pairGenerationId
    && commitment.nonceBase64 === request.commitmentNonceBase64
    && commitment.nonceSha256 === request.commitmentNonceSha256
    && /^[A-Za-z0-9_-]{43}$/.test(commitment.digestBase64Url ?? ""))
}

function validateCommitmentAuthority(request, label) {
  const identifiers = [request?.transactionId, request?.attemptId, request?.pairGenerationId]
  const nonce = decodeCanonicalBase64(request?.commitmentNonceBase64, "commitmentNonceBase64")
  try {
    if (identifiers.some((value) => typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value))
      || !SHA256.test(request?.commitmentNonceSha256 ?? "")
      || sha256(nonce) !== request.commitmentNonceSha256
      || !exactCommitment(request.p12SecretCommitment, "ouro-developer-id-p12-b64-v1", request)
      || !exactCommitment(request.passwordSecretCommitment, "ouro-developer-id-p12-password-v1", request)) {
      throw new TypeError(`${label} native plan authority is invalid`)
    }
  } finally {
    nonce.fill(0)
  }
}

function isSafeSigningAsset(asset) {
  if (!asset || typeof asset !== "object"
    || typeof asset.assetPath !== "string" || asset.assetPath.length === 0 || asset.assetPath.length > 1024
    || asset.assetPath.startsWith("/") || asset.assetPath.includes("\\")
    || asset.assetPath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    || !/^[A-Za-z0-9._/-]+$/.test(asset.assetPath)
    || typeof asset.signingIdentifier !== "string"
    || !/^[A-Za-z0-9._-]+$/.test(asset.signingIdentifier)
    || canonicalize(asset.requiredArches) !== canonicalize(["arm64", "x86_64"])) {
    return false
  }
  return true
}

function signingIdentityFromM0(event, handoff) {
  const compressed = decodeCanonicalBase64(event.inputs.m0EvidenceGzipBase64, "m0EvidenceGzipBase64")
  let contentBytes
  try {
    contentBytes = gunzipSync(compressed, { maxOutputLength: 131072 })
    const content = canonicalDocument(contentBytes.toString("utf8"), "M0 evidence content")
    if (content?.schemaVersion !== 1 || !Array.isArray(content.files)
      || canonicalize(content.files.map((file) => file?.path)) !== canonicalize(SIGNING_M0_PATHS)
      || sha256(contentBytes) !== handoff.m0EvidenceBundleContentSha256
      || sha256(compressed) !== handoff.m0EvidenceBundleGzipSha256) {
      throw new TypeError("signing M0 evidence authority is invalid")
    }
    const values = new Map(content.files.map((file) => [file.path, file.value]))
    const receipt = values.get("developer-id-provisioning-receipt.v1.json")
    const variables = values.get("developer-id-provisioning-variable-submission-receipt.v1.json")
    const verification = values.get("developer-id-pair-canary-verification.v1.json")
    const activePair = values.get("developer-id-pair-active-authority.v1.json")
    const team = receipt?.identity?.teamIdentifier
    const commonName = receipt?.identity?.applicationCommonName
    const expectedVariables = [
      { name: "OURO_DEVELOPER_ID_TEAM_ID", value: team },
      { name: "OURO_DEVELOPER_ID_APPLICATION_CN", value: commonName },
    ]
    if (typeof team !== "string" || !/^[A-Za-z0-9._-]+$/.test(team)
      || typeof commonName !== "string" || !/^[\x20-\x21\x23-\x5b\x5d-\x7e]+$/.test(commonName)
      || receipt.pairGenerationId !== handoff.pairGenerationId
      || variables.pairGenerationId !== handoff.pairGenerationId
      || canonicalize(variables.variables) !== canonicalize(expectedVariables)
      || verification.pairGenerationId !== handoff.pairGenerationId
      || canonicalize(verification.p12SecretCommitment) !== canonicalize(handoff.p12SecretCommitment)
      || canonicalize(verification.passwordSecretCommitment) !== canonicalize(handoff.passwordSecretCommitment)
      || activePair.pairGenerationId !== handoff.pairGenerationId
      || canonicalize(activePair) !== canonicalize(handoff.activePair)
      || sha256(canonicalize(receipt)) !== handoff.provisioningReceiptSha256
      || sha256(canonicalize(verification)) !== handoff.canaryVerificationSha256) {
      throw new TypeError("signing M0 identity authority is invalid")
    }
    return { team, commonName }
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError("signing M0 evidence authority is invalid")
  } finally {
    compressed.fill(0)
    if (contentBytes) contentBytes.fill(0)
  }
}

function signingPlanFields(event, decoded) {
  const handoff = decoded.get("handoffControlBase64")
  const authority = decoded.get("dispatchAttemptAuthorityBase64")
  const nonceBase64 = handoff?.p12SecretCommitment?.nonceBase64
  const request = {
    transactionId: authority?.transactionId,
    attemptId: authority?.attemptId,
    pairGenerationId: handoff?.pairGenerationId,
    commitmentNonceBase64: nonceBase64,
    commitmentNonceSha256: handoff?.commitmentNonceSha256,
    p12SecretCommitment: handoff?.p12SecretCommitment,
    passwordSecretCommitment: handoff?.passwordSecretCommitment,
  }
  if (handoff?.schemaVersion !== 1 || authority?.schemaVersion !== 1
    || handoff.dispatchAttemptId !== authority.attemptId
    || handoff.dispatchCorrelationId !== authority.dispatchCorrelationId
    || handoff.pairGenerationId !== authority.pairGenerationId
    || authority.handoffSha256 !== event.inputs.handoffSha256
    || handoff.m0EvidenceBundleGzipSha256 !== event.inputs.m0EvidenceGzipSha256
    || handoff.p12SecretCommitment?.nonceSha256 !== handoff.commitmentNonceSha256
    || handoff.passwordSecretCommitment?.nonceBase64 !== nonceBase64
    || !Array.isArray(handoff.intendedNativeAssets)
    || handoff.intendedNativeAssets.length === 0 || handoff.intendedNativeAssets.length > 16
    || handoff.intendedNativeAssets.some((asset) => !isSafeSigningAsset(asset))) {
    throw new TypeError("signing native plan authority is invalid")
  }
  const paths = handoff.intendedNativeAssets.map((asset) => asset.assetPath)
  if (new Set(paths).size !== paths.length
    || paths.some((path, index) => index > 0
      && Buffer.compare(Buffer.from(paths[index - 1]), Buffer.from(path)) >= 0)) {
    throw new TypeError("signing native asset authority is invalid")
  }
  validateCommitmentAuthority(request, "signing")
  const identity = signingIdentityFromM0(event, handoff)
  const assets = frameFields(handoff.intendedNativeAssets.flatMap((asset) => [
    Buffer.from(asset.assetPath, "utf8"),
    Buffer.from(asset.signingIdentifier, "utf8"),
  ]))
  return [
    Buffer.from(request.transactionId, "utf8"),
    Buffer.from(request.attemptId, "utf8"),
    Buffer.from(request.pairGenerationId, "utf8"),
    Buffer.from(request.commitmentNonceBase64, "utf8"),
    Buffer.from(request.p12SecretCommitment.digestBase64Url, "ascii"),
    Buffer.from(request.passwordSecretCommitment.digestBase64Url, "ascii"),
    Buffer.from(identity.team, "utf8"),
    Buffer.from(identity.commonName, "utf8"),
    assets,
  ]
}

export function materializeNativePlan(kind, outputPath, {
  environment = process.env,
  root = process.cwd(),
  systemExecutableVerifier = verifyLiveSystemExecutables,
  trustVerifier = () => false,
  fileSystem = {
    close: closeSync,
    fsync: fsyncSync,
    open: openSync,
    unlink: unlinkSync,
    write: writeSync,
  },
} = {}) {
  if (!SECRET_WORKFLOWS[kind]) throw new TypeError("unknown native plan kind")
  admitSecretWorkflow(kind, { environment, root, systemExecutableVerifier, trustVerifier })
  const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"))
  const decoded = validateDispatchInputs(SECRET_WORKFLOWS[kind], event.inputs)
  let descriptor
  let plan
  let fields = []
  try {
    if (kind === "pair-canary") {
      const request = decoded.get("requestBase64")
      validateCommitmentAuthority(request, "pair canary")
      fields = [
        Buffer.from(request.transactionId, "utf8"),
        Buffer.from(request.attemptId, "utf8"),
        Buffer.from(request.pairGenerationId, "utf8"),
        Buffer.from(request.commitmentNonceBase64, "utf8"),
        Buffer.from(request.p12SecretCommitment.digestBase64Url, "ascii"),
        Buffer.from(request.passwordSecretCommitment.digestBase64Url, "ascii"),
      ]
    } else {
      fields = signingPlanFields(event, decoded)
    }
    plan = frameFields(fields)
    descriptor = fileSystem.open(outputPath, "wx", 0o600)
    let offset = 0
    while (offset < plan.length) {
      const written = fileSystem.write(descriptor, plan, offset, plan.length - offset)
      if (!Number.isSafeInteger(written) || written < 1) throw new TypeError("native plan write was incomplete")
      offset += written
    }
    fileSystem.fsync(descriptor)
  } catch (error) {
    if (descriptor !== undefined) {
      fileSystem.close(descriptor)
      descriptor = undefined
      fileSystem.unlink(outputPath)
    }
    throw error
  } finally {
    if (descriptor !== undefined) fileSystem.close(descriptor)
    if (plan) plan.fill(0)
    for (const field of fields) field.fill(0)
  }
  return { ok: true }
}

export function createGitHubAuthorityClient({ environment = process.env, fetcher = globalThis.fetch } = {}) {
  const token = environment.GITHUB_TOKEN
  if (typeof token !== "string" || token.length === 0 || typeof fetcher !== "function") {
    throw new TypeError("GitHub authority client credentials are unavailable")
  }
  return {
    async get(path) {
      if (typeof path !== "string"
        || !(path === `/repos/${REPOSITORY}` || path.startsWith(`/repos/${REPOSITORY}/`))) {
        throw new TypeError("GitHub authority request path is invalid")
      }
      const response = await fetcher(`https://api.github.com${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
      })
      if (!response || response.status !== 200 || typeof response.json !== "function") {
        throw new TypeError("GitHub authority request failed")
      }
      return response.json()
    },
  }
}

function auditResponseBody(exchange, label) {
  try {
    return JSON.parse(Buffer.from(exchange.response.bodyBase64, "base64").toString("utf8"))
  } catch {
    throw new TypeError(`${label} audit response is invalid`)
  }
}

async function acquirePagedReviews(client, pullRequestNumber) {
  const pages = []
  for (let page = 1; page <= 10; page += 1) {
    const body = await client.get(
      `/repos/${REPOSITORY}/pulls/${pullRequestNumber}/reviews?per_page=100&page=${page}`,
    )
    if (!Array.isArray(body) || body.length > 100) throw new TypeError("GitHub review page is invalid")
    pages.push(body)
    if (body.length < 100) return pages
  }
  throw new TypeError("GitHub review result ceiling exceeded")
}

async function acquirePagedChecks(client, sha) {
  const pages = []
  let acquired = 0
  for (let page = 1; ; page += 1) {
    const body = await client.get(
      `/repos/${REPOSITORY}/commits/${sha}/check-runs?per_page=100&page=${page}`,
    )
    if (!Number.isSafeInteger(body?.total_count) || body.total_count < 1 || body.total_count > 1000
      || !Array.isArray(body.check_runs) || body.check_runs.length > 100) {
      throw new TypeError("GitHub check page is invalid")
    }
    pages.push(body)
    acquired += body.check_runs.length
    if (acquired === body.total_count) return pages
    if (acquired > body.total_count || body.check_runs.length !== 100) {
      throw new TypeError("GitHub check pagination is invalid")
    }
  }
}

function inspectGitHubTree(tree, expectedOid) {
  if (tree?.sha !== expectedOid || tree.truncated !== false || !Array.isArray(tree.tree)) {
    throw new TypeError("GitHub tree is incomplete")
  }
  const leaves = tree.tree.filter((entry) => entry?.type !== "tree")
  if (leaves.some((entry) => typeof entry.path !== "string" || entry.path.length === 0
    || entry.path.includes("\0") || !/^[0-7]{6}$/.test(entry.mode ?? "")
    || !["blob", "commit"].includes(entry.type) || !SHA1.test(entry.sha ?? ""))
    || new Set(leaves.map((entry) => entry.path)).size !== leaves.length) {
    throw new TypeError("GitHub tree entry is invalid")
  }
  const listing = Buffer.concat(leaves.map((entry) => (
    Buffer.from(`${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\0`, "utf8")
  )))
  return {
    entries: new Map(leaves.map((entry) => [entry.path, {
      mode: entry.mode,
      type: entry.type,
      sha: entry.sha,
    }])),
    treeSha256: sha256(listing),
  }
}

async function acquireProtectedMerge(client, repository, protection, sha, pullRequestNumber) {
  const [pullRequest, commit, reviews, checks] = await Promise.all([
    client.get(`/repos/${REPOSITORY}/pulls/${pullRequestNumber}`),
    client.get(`/repos/${REPOSITORY}/commits/${sha}`),
    acquirePagedReviews(client, pullRequestNumber),
    acquirePagedChecks(client, sha),
  ])
  const treeOid = commit?.commit?.tree?.sha
  if (!SHA1.test(treeOid ?? "")) throw new TypeError("GitHub merge tree is invalid")
  const tree = inspectGitHubTree(
    await client.get(`/repos/${REPOSITORY}/git/trees/${treeOid}?recursive=1`),
    treeOid,
  )
  const merge = {
    sha,
    treeOid,
    treeSha256: tree.treeSha256,
    parentShas: commit?.parents?.map((parent) => parent?.sha),
    pullRequestNumber,
  }
  if (!validateProtectedMergeSemantics({
    merge,
    repository,
    pullRequest,
    commit,
    reviews,
    checks,
    protection,
  }).ok) {
    throw new TypeError("GitHub protected merge is invalid")
  }
  return { merge, entries: tree.entries }
}

function requireAuthorityOnlyTreeChange(implementationEntries, authorityEntries) {
  const paths = new Set([...implementationEntries.keys(), ...authorityEntries.keys()])
  const changed = [...paths].filter((path) => canonicalize(implementationEntries.get(path) ?? null)
    !== canonicalize(authorityEntries.get(path) ?? null))
  if (canonicalize(changed.sort()) !== canonicalize([...AUTHORITY_PATHS].sort())
    || AUTHORITY_PATHS.some((path) => implementationEntries.has(path)
      || authorityEntries.get(path)?.type !== "blob")
    || authorityEntries.has(CARRIER_PATH)) {
    throw new TypeError("authority merge tree contains non-authority changes")
  }
}

export async function verifyInceptionSealSigningAuthority({
  body,
  bytes,
  environment,
  root,
  githubClient,
}) {
  try {
    const client = githubClient ?? createGitHubAuthorityClient({ environment })
    if (!client || typeof client.get !== "function") return false
    const bootstrapEvidence = readCanonical(root, AUTHORITY_PATHS[0], "bootstrap evidence")
    const authority = readCanonical(root, AUTHORITY_PATHS[1], "inception authority")
    const policyHead = readCanonical(root, AUTHORITY_PATHS[2], "release trust head")
    const historicalProtection = auditResponseBody(
      body.authorityMergeAuditEvidence?.branchProtection,
      "authority branch protection",
    )
    const repository = await client.get(`/repos/${REPOSITORY}`)
    const [implementation, authorityMerge] = await Promise.all([
      acquireProtectedMerge(
        client,
        repository,
        auditResponseBody(
          bootstrapEvidence.value.content?.githubAuditEvidence?.branchProtection,
          "bootstrap branch protection",
        ),
        body.bootstrapMergeSha,
        bootstrapEvidence.value.content?.bootstrapPullRequestNumber,
      ),
      acquireProtectedMerge(
        client,
        repository,
        historicalProtection,
        body.authorityMergeSha,
        body.authorityMergePullRequestNumber,
      ),
    ])
    requireAuthorityOnlyTreeChange(implementation.entries, authorityMerge.entries)
    const requiredMembers = {
      signingWorkflowSha256: authority.value.signingWorkflowBlobSha256,
      signingClosureSha256: authority.value.signingExecutionClosureSha256,
      pairCanaryWorkflowSha256: authority.value.pairCanaryWorkflowBlobSha256,
      pairCanaryClosureSha256: authority.value.pairCanaryExecutionClosureSha256,
      sealWorkflowSha256: authority.value.inceptionSealWorkflowBlobSha256,
      sealClosureSha256: authority.value.inceptionSealExecutionClosureSha256,
      initialPolicySha256: authority.value.initialPolicySha256,
      pairCanaryPolicySha256: authority.value.pairCanaryTrustPolicySha256,
      foundationSha256: authority.value.pairCanaryFoundationSha256,
    }
    const expected = constructInceptionSealBody({
      implementationMerge: implementation.merge,
      authorityArtifacts: {
        bootstrapEvidence: { value: bootstrapEvidence.value, bytes: bootstrapEvidence.bytes },
        authority: { value: authority.value, bytes: authority.bytes },
        policyHead: { value: policyHead.value, bytes: policyHead.bytes },
        requiredMembers,
      },
      authorityMerge: {
        ...authorityMerge.merge,
        auditEvidence: body.authorityMergeAuditEvidence,
      },
      createdAt: body.createdAt,
    })
    return expected.bytes === bytes.toString("utf8")
      && expected.value.authorityMergeSha === environment.GITHUB_SHA
  } catch {
    return false
  }
}

function validateSealRunEnvironment(environment) {
  const runId = Number(environment.GITHUB_RUN_ID)
  if (environment.GITHUB_REPOSITORY !== REPOSITORY
    || environment.GITHUB_REPOSITORY_ID !== REPOSITORY_ID
    || environment.GITHUB_REF !== "refs/heads/main"
    || !/^[1-9]\d*$/.test(environment.GITHUB_RUN_ID ?? "")
    || !Number.isSafeInteger(runId)
    || environment.GITHUB_RUN_ATTEMPT !== "1"
    || !SHA1.test(environment.GITHUB_SHA ?? "")
    || environment.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${SEAL_WORKFLOW_PATH}@refs/heads/main`
    || environment.GITHUB_WORKFLOW_SHA !== environment.GITHUB_SHA) {
    throw new TypeError("inception seal workflow is not exact protected main")
  }
}

function validateSealBody(root, environment, bytes) {
  const body = canonicalDocument(bytes.toString("utf8"), "inception seal body")
  const expectedKeys = [
    "authorityMergeAuditEvidence",
    "authorityMergeAuditEvidenceSha256",
    "authorityMergePullRequestNumber",
    "authorityMergeSha",
    "authorityMergeTreeSha256",
    "authorityPath",
    "authorityReferencesEarlierBootstrapMerge",
    "authoritySha256",
    "bootstrapEvidencePath",
    "bootstrapEvidenceSha256",
    "bootstrapMergeSha",
    "bootstrapTreeSha256",
    "createdAt",
    "headPath",
    "headSha256",
    "noSecretSigningPublishOrInstalledRuntimeEffectBeforeSeal",
    "policyPath",
    "policySha256",
    "repository",
    "repositoryDatabaseId",
    "repositoryNodeId",
    "schemaVersion",
  ]
  if (canonicalize(Object.keys(body).sort()) !== canonicalize(expectedKeys)
    || body.schemaVersion !== 1
    || body.repository !== REPOSITORY
    || body.repositoryDatabaseId !== Number(REPOSITORY_ID)
    || body.repositoryNodeId !== REPOSITORY_NODE_ID
    || body.authorityMergeSha !== environment.GITHUB_SHA
    || !SHA1.test(body.authorityMergeSha ?? "")
    || !SHA1.test(body.bootstrapMergeSha ?? "")
    || body.bootstrapMergeSha === body.authorityMergeSha
    || !Number.isSafeInteger(body.authorityMergePullRequestNumber)
    || body.authorityMergePullRequestNumber < 1
    || ![body.authorityMergeTreeSha256, body.bootstrapTreeSha256].every((value) => SHA256.test(value ?? ""))
    || body.authorityReferencesEarlierBootstrapMerge !== true
    || body.noSecretSigningPublishOrInstalledRuntimeEffectBeforeSeal !== true
    || typeof body.authorityMergeAuditEvidence !== "object"
    || body.authorityMergeAuditEvidence === null
    || Array.isArray(body.authorityMergeAuditEvidence)
    || body.authorityMergeAuditEvidenceSha256 !== sha256(canonicalize(body.authorityMergeAuditEvidence))
    || typeof body.createdAt !== "string"
    || !Number.isFinite(Date.parse(body.createdAt))
    || new Date(body.createdAt).toISOString() !== body.createdAt) {
    throw new TypeError("inception seal body is not exact authority-merge evidence")
  }
  const paths = {
    authorityPath: "release/trust/release-trust-inception-authority.v1.json",
    bootstrapEvidencePath: "release/trust/release-trust-bootstrap-evidence.v1.json",
    headPath: "release/trust/release-trust-policy-head.v1.json",
    policyPath: "release/trust/release-trust-policy.v1.json",
  }
  for (const [field, path] of Object.entries(paths)) {
    if (body[field] !== path || body[field.replace("Path", "Sha256")] !== sha256(readFileSync(join(root, path)))) {
      throw new TypeError("inception seal body does not bind checked-out authority bytes")
    }
  }
  const authority = readCanonical(root, paths.authorityPath, "inception authority").value
  const head = readCanonical(root, paths.headPath, "release trust head").value
  if (authority.bootstrapMergeSha !== body.bootstrapMergeSha
    || authority.bootstrapEvidenceSha256 !== body.bootstrapEvidenceSha256
    || authority.initialPolicySha256 !== body.policySha256
    || head.activation?.authoritySha256 !== body.authoritySha256
    || head.activePolicySha256 !== body.policySha256) {
    throw new TypeError("inception seal body authority graph is inconsistent")
  }
  return body
}

export async function materializeSealInput(outputPath, statementOutputPathOrOptions, maybeOptions = {}) {
  const statementOutputPath = typeof statementOutputPathOrOptions === "string"
    ? statementOutputPathOrOptions
    : undefined
  const options = typeof statementOutputPathOrOptions === "string"
    ? maybeOptions
    : (statementOutputPathOrOptions ?? {})
  const {
    environment = process.env,
    root = process.cwd(),
    trustVerifier = verifyInceptionSealSigningAuthority,
    githubClient,
    fileSystem = {
    close: closeSync,
    fsync: fsyncSync,
    open: openSync,
    unlink: unlinkSync,
    write: writeSync,
    },
  } = options
  validateSealRunEnvironment(environment)
  const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, "utf8"))
  const bytes = decodeCanonicalBase64(event.inputs?.sealBodyBase64, "sealBodyBase64")
  let bodyDescriptor
  let statementDescriptor
  let statementBytes
  try {
    if (!SHA256.test(event.inputs?.sealBodySha256 ?? "")
      || sha256(bytes) !== event.inputs.sealBodySha256) {
      throw new TypeError("inception seal body hash mismatch")
    }
    const body = validateSealBody(root, environment, bytes)
    if (typeof trustVerifier !== "function"
      || await trustVerifier({
        event,
        body,
        bytes: Buffer.from(bytes),
        environment,
        root,
        githubClient,
      }) !== true) {
      throw new TypeError("cryptographic verification evidence required")
    }
    statementBytes = statementOutputPath === undefined
      ? undefined
      : Buffer.from(constructInceptionSealStatement({
        sealBody: { value: body, bytes: bytes.toString("utf8") },
      }).bytes)
    bodyDescriptor = fileSystem.open(outputPath, "wx", 0o600)
    fileSystem.write(bodyDescriptor, bytes)
    fileSystem.fsync(bodyDescriptor)
    if (statementOutputPath !== undefined) {
      statementDescriptor = fileSystem.open(statementOutputPath, "wx", 0o600)
      fileSystem.write(statementDescriptor, statementBytes)
      fileSystem.fsync(statementDescriptor)
    }
  } catch (error) {
    if (statementDescriptor !== undefined) {
      fileSystem.close(statementDescriptor)
      statementDescriptor = undefined
      fileSystem.unlink(statementOutputPath)
    }
    if (bodyDescriptor !== undefined) {
      fileSystem.close(bodyDescriptor)
      bodyDescriptor = undefined
      fileSystem.unlink(outputPath)
    }
    throw error
  } finally {
    if (statementDescriptor !== undefined) fileSystem.close(statementDescriptor)
    if (bodyDescriptor !== undefined) fileSystem.close(bodyDescriptor)
    if (statementBytes) statementBytes.fill(0)
    bytes.fill(0)
  }
  return { ok: true }
}

export function isDirectInvocation(argv, moduleUrl) {
  return argv[1]
    && moduleUrl === pathToFileURL(argv[1]).href
}

export async function runCli(
  args,
  output = { stdout: process.stdout, stderr: process.stderr },
  operations = { admitSecretWorkflow, materializeNativePlan, materializeSealInput, runNativeFrame },
) {
  try {
    if (args[0] === "frame-native" && args.length === 3) {
      return operations.runNativeFrame(args[1], Number(args[2]), process.env, output)
    }
    if (args[0] === "admit-secret-workflow" && args.length === 2) {
      operations.admitSecretWorkflow(args[1])
      return 0
    }
    if (args[0] === "materialize-seal-input" && (args.length === 2 || args.length === 3)) {
      await operations.materializeSealInput(args[1], args[2])
      return 0
    }
    if (args[0] === "materialize-native-plan" && args.length === 3) {
      operations.materializeNativePlan(args[1], args[2])
      return 0
    }
    output.stderr.write(
      "usage: run-reconciliation.mjs frame-native <executable> <field-count> | "
      + "admit-secret-workflow <pair-canary|signing> | materialize-native-plan <kind> <output> | "
      + "materialize-seal-input <body-output> [statement-output]\n",
    )
    return 64
  } catch (error) {
    output.stderr.write(`${error instanceof Error ? error.message : "release trust command failed"}\n`)
    return 65
  }
}

export async function runDirectInvocation(argv, moduleUrl, cli, setExitCode) {
  if (!isDirectInvocation(argv, moduleUrl)) return false
  setExitCode(await cli(argv.slice(2)))
  return true
}

export function setProcessExitCode(code) {
  process.exitCode = code
}

await runDirectInvocation(
  process.argv,
  import.meta.url,
  runCli,
  setProcessExitCode,
)
