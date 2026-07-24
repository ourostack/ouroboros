import { createHash } from "node:crypto"

import { canonicalize } from "./canonicalize.mjs"

const SHA256 = /^[a-f0-9]{64}$/
const SHA1 = /^[a-f0-9]{40}$/
const EXECUTION_IDENTITY_FIELDS = Object.freeze({
  action: "uses",
  "checked-out-file": "path",
  container: "image",
  download: "url",
  "system-executable": "realpath",
})

const TRUST_TCB_PATHS = Object.freeze([
  ".github/actions/release-trust/canonicalize.mjs",
  ".github/actions/release-trust/protected-store.mjs",
  ".github/actions/release-trust/run-reconciliation.mjs",
  ".github/actions/release-trust/workflow-closure.mjs",
  "package.json",
  "package-lock.json",
])

const EXECUTION_PLANS = Object.freeze({
  secret: Object.freeze({
    workflowPath: ".github/workflows/developer-id-pair-canary.yml",
    driverPath: "native/developer-id-pair-canary/driver.c",
    systemCommands: Object.freeze(["clang", "node", "xcrun"]),
    runCommands: Object.freeze([
      "npm ci --ignore-scripts",
      "node .github/actions/release-trust/run-reconciliation.mjs admit-secret-workflow pair-canary",
      "/usr/bin/xcrun clang -std=c17 -Wall -Wextra -Werror native/developer-id-pair-canary/driver.c -framework Security -framework CoreFoundation -o native/developer-id-pair-canary/driver",
      "/usr/bin/xcrun clang -std=c17 -Wall -Wextra -Werror native/developer-id-pair-canary/driver.c -framework Security -framework CoreFoundation -o developer-id-pair-canary-input",
      "node .github/actions/release-trust/run-reconciliation.mjs materialize-native-plan pair-canary developer-id-pair-canary-native-plan.v1.bin",
      "node .github/actions/release-trust/run-reconciliation.mjs frame-native native/developer-id-pair-canary/driver 4",
    ]),
  }),
  signing: Object.freeze({
    workflowPath: ".github/workflows/developer-id-signing.yml",
    driverPath: "native/developer-id-signing/driver.c",
    systemCommands: Object.freeze(["clang", "node", "xcrun"]),
    runCommands: Object.freeze([
      "npm ci --ignore-scripts",
      "node .github/actions/release-trust/run-reconciliation.mjs admit-secret-workflow signing",
      "/usr/bin/xcrun clang -std=c17 -Wall -Wextra -Werror native/developer-id-signing/driver.c -framework Security -framework CoreFoundation -o native/developer-id-signing/driver",
      "node .github/actions/release-trust/run-reconciliation.mjs materialize-native-plan signing developer-id-signing-native-plan.v1.bin",
      "node .github/actions/release-trust/run-reconciliation.mjs frame-native native/developer-id-signing/driver 2",
    ]),
  }),
})

function fail(code, details = {}) {
  return { ok: false, code, ...details }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function executionIdentity(entry) {
  return entry[EXECUTION_IDENTITY_FIELDS[entry.kind]]
}

function compareExecutionEntries(left, right) {
  return Buffer.compare(
    Buffer.from(`${left.kind}\0${executionIdentity(left)}`, "utf8"),
    Buffer.from(`${right.kind}\0${executionIdentity(right)}`, "utf8"),
  )
}

function declaredWorkflowActions(workflowBytes) {
  const actions = []
  for (const match of workflowBytes.matchAll(/^\s*uses:\s*(\S+)\s*$/gm)) {
    const action = /^([^\s@]+\/[^\s@]+)@([a-f0-9]{40})$/.exec(match[1])
    if (!action || action[1].includes("/.github/workflows/")) {
      throw new TypeError("workflow action is not an immutable action")
    }
    actions.push(`${action[1]}@${action[2]}`)
  }
  return actions.sort()
}

function declaredWorkflowRuns(workflowBytes) {
  return [...workflowBytes.matchAll(/^\s*run:\s*([^\n]+)\s*$/gm)].map((match) => match[1].trim())
}

function exactRecordKeys(record, expected, label) {
  const actual = Object.keys(record).sort()
  const wanted = [...expected].sort()
  if (canonicalize(actual) !== canonicalize(wanted)) {
    const missing = wanted.find((key) => !actual.includes(key))
    throw new TypeError(missing ? `${label} is missing ${missing}` : `unexpected ${label}`)
  }
}

export function buildExecutionClosure({
  workflowPath,
  workflowBytes,
  driverPath,
  driverBytes,
  driverKind,
  checkedOutFileBytesByPath,
  systemExecutableEvidenceByCommand,
}) {
  const plan = EXECUTION_PLANS[driverKind]
  if (typeof workflowPath !== "string" || !workflowPath.startsWith(".github/workflows/")
    || typeof workflowBytes !== "string"
    || typeof driverPath !== "string" || driverPath.length === 0
    || !(Buffer.isBuffer(driverBytes) || typeof driverBytes === "string")
    || !plan || !checkedOutFileBytesByPath || Array.isArray(checkedOutFileBytesByPath)
    || !systemExecutableEvidenceByCommand || Array.isArray(systemExecutableEvidenceByCommand)) {
    throw new TypeError("execution closure generator input is invalid")
  }
  if (workflowPath !== plan.workflowPath || driverPath !== plan.driverPath) {
    throw new TypeError("execution closure workflow plan mismatch")
  }
  const workflowActions = declaredWorkflowActions(workflowBytes)
  if (workflowActions.length === 0) {
    throw new TypeError("execution closure workflow has no immutable actions")
  }
  if (canonicalize(declaredWorkflowRuns(workflowBytes)) !== canonicalize(plan.runCommands)) {
    throw new TypeError("execution closure workflow commands do not match the operation plan")
  }
  const checkedPaths = [...TRUST_TCB_PATHS, driverPath]
  exactRecordKeys(checkedOutFileBytesByPath, checkedPaths, "checked-out evidence")
  exactRecordKeys(systemExecutableEvidenceByCommand, plan.systemCommands, "system executable evidence")

  const driverSha256 = sha256(driverBytes)
  if (sha256(checkedOutFileBytesByPath[driverPath]) !== driverSha256) {
    throw new TypeError("checked-out evidence does not bind the driver source")
  }
  const contractRole = `${driverKind}-driver-contract`
  const sourceRole = `${driverKind}-driver-source`
  const normalizedEntries = workflowActions.map((value) => {
    const at = value.lastIndexOf("@")
    return { kind: "action", uses: value.slice(0, at), commitSha: value.slice(at + 1) }
  })
  normalizedEntries.push(...checkedPaths.map((path) => ({
    kind: "checked-out-file",
    path,
    sha256: sha256(checkedOutFileBytesByPath[path]),
    role: path === driverPath ? sourceRole : contractRole,
  })))
  for (const command of plan.systemCommands) {
    const evidence = systemExecutableEvidenceByCommand[command]
    if (!evidence || typeof evidence.realpath !== "string" || !evidence.realpath.startsWith("/")
      || evidence.realpath.split("/").at(-1) !== command
      || !SHA256.test(evidence.sha256 ?? "")
      || !(evidence.designatedRequirementSha256 === null
        || SHA256.test(evidence.designatedRequirementSha256 ?? ""))) {
      throw new TypeError(`system executable evidence is invalid for ${command}`)
    }
    normalizedEntries.push({ kind: "system-executable", ...evidence })
  }
  normalizedEntries.sort(compareExecutionEntries)
  const driverPathField = driverKind === "secret" ? "secretDriverPath" : "signingDriverPath"
  const driverHashField = driverKind === "secret" ? "secretDriverSha256" : "signingDriverSha256"
  const body = {
    schemaVersion: 1,
    workflowPath,
    workflowBlobSha256: sha256(workflowBytes),
    entries: normalizedEntries,
    entriesUtf8ByteSortedByKindAndIdentity: true,
    allActionsPinnedByFullCommitSha: true,
    allContainersPinnedByDigest: true,
    allDownloadsHashVerifiedBeforeExecution: true,
    noReusableWorkflowOrUndeclaredExecution: true,
    [driverPathField]: driverPath,
    [driverHashField]: driverSha256,
  }
  return { ...body, closureSha256: sha256(canonicalize(body)) }
}

export function validateExecutionClosure(input) {
  try {
    const expected = buildExecutionClosure({ ...input, entries: input.closure?.entries })
    return canonicalize(input.closure) === canonicalize(expected)
      ? { ok: true }
      : fail("execution_closure_mismatch")
  } catch {
    return fail("execution_closure_mismatch")
  }
}

export function verifyWorkflowClosure({ requiredPaths, members, execution = [] }) {
  if (!Array.isArray(requiredPaths) || !Array.isArray(members)) {
    return fail("closure_invalid")
  }
  const required = new Set(requiredPaths)
  if (required.size !== requiredPaths.length) {
    return fail("closure_required_path_duplicate")
  }
  const seen = new Set()
  for (const member of members) {
    if (!member || typeof member.path !== "string" || !SHA256.test(member.sha256 ?? "")) {
      return fail("closure_member_invalid")
    }
    if (seen.has(member.path)) {
      return fail("closure_member_duplicate", { path: member.path })
    }
    seen.add(member.path)
    if (!required.has(member.path)) {
      return fail("closure_member_unexpected", { path: member.path })
    }
  }
  for (const path of requiredPaths) {
    if (!seen.has(path)) {
      return fail("closure_member_missing", { path })
    }
  }
  for (const [index, member] of members.entries()) {
    if (member.path !== requiredPaths[index]) {
      return fail("closure_member_order_invalid", { path: member.path })
    }
  }
  if (!Array.isArray(execution)) {
    return fail("closure_execution_invalid")
  }
  for (const entry of execution) {
    if (!entry || typeof entry.kind !== "string" || typeof entry.identity !== "string") {
      return fail("closure_execution_invalid")
    }
    if (entry.kind === "reusable-workflow" || entry.kind === "undeclared") {
      return fail("closure_execution_forbidden")
    }
    if (entry.kind === "action" && !/^[a-f0-9]{40}$/.test(entry.ref ?? "")) {
      return fail("closure_action_unpinned")
    }
    if (entry.kind === "container" && !/^sha256:[a-f0-9]{64}$/.test(entry.digest ?? "")) {
      return fail("closure_container_unpinned")
    }
    if (entry.kind === "download" && !SHA256.test(entry.sha256 ?? "")) {
      return fail("closure_download_unverified")
    }
    if (!["action", "container", "download", "local"].includes(entry.kind)) {
      return fail("closure_execution_forbidden")
    }
  }
  return { ok: true }
}

function equalRecord(left, right) {
  const leftKeys = Object.keys(left ?? {}).sort()
  const rightKeys = Object.keys(right ?? {}).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
}

export function verifyPolicyChain(input) {
  if (!input || !equalRecord(input.requiredInceptionMembers, input.inceptionAuthority?.namedMembers)) {
    return fail("inception_member_mismatch")
  }
  const foundation = input.foundation
  if (!foundation || !foundation.fulcioRoots?.length || !foundation.ctLogs?.length || !foundation.rekorLogs?.length) {
    return fail("foundation_incomplete")
  }
  if (input.freshPairAuthority !== true) {
    return fail("fresh_pair_required")
  }
  if (input.terminalNoValidArtifactListing !== true) {
    return fail("terminal_artifact_authority_required")
  }
  if (!Array.isArray(input.transitions)) {
    return fail("rotation_chain_invalid")
  }

  let expectedPrior = input.inceptionHead
  for (const transition of input.transitions) {
    if (transition.prior !== expectedPrior || transition.predecessorSignatureVerified !== true) {
      return fail("rotation_chain_incomplete")
    }
    if (transition.signingPolicySha256 !== transition.predecessorPolicySha256) {
      return fail("successor_self_authorized")
    }
    expectedPrior = transition.successor
  }
  if (expectedPrior !== input.activeHead) {
    return fail("rotation_chain_incomplete")
  }
  return fail("verification_evidence_required")
}
