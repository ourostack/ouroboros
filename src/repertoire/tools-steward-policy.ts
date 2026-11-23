import { withCode, type ToolDefinition } from "./tools-base"
import { assertNotReplayIdentity, readStewardPolicy, updateStewardPolicy, type StewardPolicyMutation } from "../heart/steward-policy"
import { emitNervesEvent } from "../nerves/runtime"

function arrayArgument(raw: string | undefined, label: string): string[] {
  if (!raw) throw new Error(withCode(`${label} is required`, "bad-argument"))
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(withCode(`${label} must be a JSON string array`, "bad-argument"))
  return value
}

export const stewardPolicyToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "steward_policy_manage",
      description: "Read or update the household steward's typed desired-state and routine-action policy. Updates require the current authenticated owner Telegram request and fresh authorization. Replay identities can't update it. correct_provenance (key, source, correction) fixes a wrong attribution on an existing desired state: it replaces the recorded source, records the correction note and leaves an audit row, and the value stays as it was; a value changes through set_desired_state. expectedVersion is optional; omit it to apply against the current policy version, or supply a version from read for explicit stale-write detection.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "set_desired_state", "grant_routine_action", "correct_provenance"] },
          expectedVersion: { type: "integer", minimum: 0, description: "Optional version returned by read. When omitted, the runtime uses the current policy version." },
          key: { type: "string" },
          value: { type: "string" },
          provenance: { type: "string", enum: ["stated", "observed", "default", "installed_explicit_policy"] },
          source: { type: "string", description: "Who or what stated this. For correct_provenance, the corrected attribution that replaces the recorded source." },
          correction: { type: "string", description: "correct_provenance only: required note naming what is being corrected and why." },
          routineAction: { type: "string" },
          targetsJson: { type: "string", description: "JSON array of exact target names" },
          maxCount: { type: "integer", minimum: 1 },
          windowMs: { type: "integer", minimum: 1 },
          verificationRequired: { type: "boolean" },
          exclusionsJson: { type: "string", description: "JSON array of exact excluded target names" },
          expiresAt: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  handler: (args, ctx) => {
    if (!ctx?.agentRoot) throw new Error(withCode("steward policy runtime is unavailable", "runtime-unavailable"))
    if (!ctx.relationshipAuthorization) throw new Error(withCode("steward policy access requires authenticated relationship authority", "relationship-authority-required"))
    if (args.action === "read") {
      emitNervesEvent({ component: "repertoire", event: "repertoire.steward_policy_tool_call", message: "read steward policy", meta: { action: "read" } })
      return JSON.stringify(readStewardPolicy(ctx.agentRoot))
    }
    const relationship = ctx.relationshipAuthorization
    const actor = relationship.actor
    if (!actor) throw new Error(withCode("steward policy mutation requires authenticated relationship authority", "relationship-authority-required"))
    const { friendId, trustLevel, sessionEventId } = actor
    const { profileId, requestId } = relationship
    assertNotReplayIdentity(ctx.agentRoot, [friendId, ctx.delegatedCommand?.delegateFriendId])
    const sessionKey = ctx.currentSession?.key
    const delegated = ctx.delegatedCommand
    // Two ways to hold owner authority: the owner's own Telegram turn, or a delegated
    // command the A2A server admitted (grant checked, owner already notified).
    const sessionMatches = () => delegated
      ? ctx.currentSession?.channel === "a2a" && ctx.delegatedCommand === delegated
        && friendId === delegated.principalFriendId && requestId === delegated.commandId
        && sessionEventId === `a2a-delegated:${delegated.commandId}`
      : ctx.currentSession?.friendId === friendId && ctx.currentSession.channel === "telegram"
    if (trustLevel !== "family" || profileId !== "sanctuary-owner" || typeof requestId !== "string" || !requestId.trim()
      || typeof sessionKey !== "string" || !sessionKey.trim() || !sessionEventId.trim()
      || !sessionMatches() || ctx.currentExternalEvent) {
      throw new Error(withCode(delegated
        ? "steward policy mutation requires a current admitted delegated owner command"
        : "steward policy mutation requires a current authenticated owner Telegram request and session", "owner-request-required"))
    }
    const sourceFor = (raw: string | undefined): string => delegated
      ? `${delegated.principalName} via ${delegated.delegateName} (delegated)${raw?.trim() ? `: ${raw.trim()}` : ""}`
      : raw ?? ""
    const expectedVersion = args.expectedVersion === undefined ? undefined : Number(args.expectedVersion)
    if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) throw new Error(withCode("expectedVersion must be a nonnegative integer", "bad-argument"))
    let mutation: StewardPolicyMutation
    if (args.action === "set_desired_state") {
      if (args.provenance !== "stated" && args.provenance !== "observed" && args.provenance !== "default") throw new Error(withCode("desired state provenance is invalid", "bad-argument"))
      mutation = { kind: "set_desired_state", key: args.key ?? "", value: args.value ?? "", provenance: args.provenance, source: sourceFor(args.source), ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}) }
    } else if (args.action === "correct_provenance") {
      mutation = { kind: "correct_provenance", key: args.key ?? "", source: sourceFor(args.source), correction: args.correction ?? "" }
    } else if (args.action === "grant_routine_action") {
      if (args.provenance !== "stated" && args.provenance !== "installed_explicit_policy") throw new Error(withCode("routine action provenance is invalid", "bad-argument"))
      const targets = arrayArgument(args.targetsJson, "targetsJson")
      const exclusions = arrayArgument(args.exclusionsJson, "exclusionsJson")
      const verificationRequired: unknown = args.verificationRequired
      if (verificationRequired !== true) throw new Error(withCode("verificationRequired must be true", "bad-argument"))
      mutation = {
        kind: "grant_routine_action",
        key: args.key ?? "",
        action: args.routineAction ?? "",
        targets,
        maxCount: Number(args.maxCount),
        windowMs: Number(args.windowMs),
        verificationRequired,
        exclusions,
        provenance: args.provenance,
        ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
      }
    } else throw new Error(withCode("steward policy action is invalid", "bad-argument"))
    const agentRoot = ctx.agentRoot
    return Promise.resolve(relationship.authorizeTool("steward_policy_manage", args)).then((authorization) => {
      if (!authorization.allowed) throw new Error(withCode(`steward policy authorization denied: ${authorization.reason}`, "authorization-denied"))
      if (typeof authorization.profileVersion !== "number" || !Number.isSafeInteger(authorization.profileVersion) || authorization.profileVersion < 1 || !authorization.receiptId.trim()) {
        throw new Error(withCode("steward policy owner authorization is not versioned", "authorization-unversioned"))
      }
      if (ctx.relationshipAuthorization !== relationship || relationship.profileId !== profileId || relationship.requestId !== requestId
        || relationship.actor?.friendId !== friendId || relationship.actor.trustLevel !== trustLevel || relationship.actor.sessionEventId !== sessionEventId
        || ctx.currentSession?.key !== sessionKey || !sessionMatches() || ctx.currentExternalEvent) {
        throw new Error(withCode("steward policy owner authorization or session changed before mutation", "authorization-changed"))
      }
      const versionBefore = readStewardPolicy(agentRoot).version
      const result = updateStewardPolicy(agentRoot, {
        expectedVersion: expectedVersion ?? readStewardPolicy(agentRoot).version,
        actor: {
          friendId, trustLevel, sessionEventId,
          authorization: { profileId, requestId, sessionKey, receiptId: authorization.receiptId, profileVersion: authorization.profileVersion },
          ...(delegated ? { delegatedVia: { delegateFriendId: delegated.delegateFriendId, delegateDid: delegated.delegateDid, noticeId: delegated.noticeId } } : {}),
        },
        mutation,
      })
      emitNervesEvent({ component: "repertoire", event: "repertoire.steward_policy_tool_call", message: "updated steward policy", meta: { action: args.action } })
      if (mutation.kind === "set_desired_state" && result.version === versionBefore) {
        // A same-value restatement writes nothing; the entry is necessarily present.
        const existing = result.desiredStates[mutation.key]!
        return JSON.stringify({ ...result, unchanged: true, note: `already recorded as ${existing.value} (source: ${existing.source})` })
      }
      return JSON.stringify(result)
    })
  },
  ax: { id: "tool:steward_policy_manage", group: "turn-steward", when: "Pick this to read or change what the household steward keeps on or may restart, when the owner states it in this turn.", effect: "write", errors: [
    { code: "runtime-unavailable", means: "The runtime gave this turn no agent home, so there is no policy to open.", fix: "Report it to the owner; this is a runtime fault, not something to retry." },
    { code: "relationship-authority-required", means: "This turn has no authenticated relationship, such as the owner's Telegram chat, behind it.", fix: "Don't retry here; the policy is read or changed only in an authenticated owner conversation." },
    { code: "owner-request-required", means: "A change needs the owner's own current Telegram request, or an admitted delegated command, and this turn is neither.", fix: "Read the policy instead, or ask the owner to state the change in their Telegram chat." },
    { code: "bad-argument", means: "action, provenance, expectedVersion, a JSON list or verificationRequired isn't an allowed value; the text names it.", fix: "Correct the argument the text names; send targetsJson and exclusionsJson as JSON arrays of names." },
    { code: "authorization-denied", means: "The owner's authorization for this exact change was refused; the text gives the reason.", fix: "Tell the owner what was refused and why, and change nothing." },
    { code: "authorization-unversioned", means: "The authorization came back without a profile version or receipt, so the change can't be audited.", fix: "Report it to the owner; don't retry the change." },
    { code: "authorization-changed", means: "The owner's session or authorization changed while the change was being checked.", fix: "Read the policy again and redo the change in the owner's current turn." },
  ] },
  riskProfile: (args) => args.action === "read"
    ? { mutates: "none", risk: "low" }
    : { mutates: "durable_state_write", risk: "high", reason: "updates typed household steward policy under current authenticated owner authority" },
}
