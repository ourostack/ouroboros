import type { ToolDefinition } from "./tools-base"
import { readStewardPolicy, updateStewardPolicy, type StewardPolicyMutation } from "../heart/steward-policy"

function arrayArgument(raw: string | undefined, label: string): string[] {
  if (!raw) throw new Error(`${label} is required`)
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${label} must be a JSON string array`)
  return value
}

export const stewardPolicyToolDefinition: ToolDefinition = {
  tool: {
    type: "function",
    function: {
      name: "steward_policy_manage",
      description: "Read or update the household steward's typed desired-state and routine-action policy. Updates require the current authenticated family request and exact policy version.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "set_desired_state", "grant_routine_action"] },
          expectedVersion: { type: "integer", minimum: 0 },
          key: { type: "string" },
          value: { type: "string" },
          provenance: { type: "string", enum: ["stated", "observed", "default", "installed_explicit_policy"] },
          source: { type: "string" },
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
    if (!ctx?.agentRoot) throw new Error("steward policy runtime is unavailable")
    if (args.action === "read") return JSON.stringify(readStewardPolicy(ctx.agentRoot))
    const actor = ctx.relationshipAuthorization?.actor
    if (!actor) throw new Error("steward policy mutation requires authenticated relationship authority")
    const expectedVersion = Number(args.expectedVersion)
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw new Error("expectedVersion must be a nonnegative integer")
    let mutation: StewardPolicyMutation
    if (args.action === "set_desired_state") {
      if (args.provenance !== "stated" && args.provenance !== "observed" && args.provenance !== "default") throw new Error("desired state provenance is invalid")
      mutation = { kind: "set_desired_state", key: args.key ?? "", value: args.value ?? "", provenance: args.provenance, source: args.source ?? "", ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}) }
    } else if (args.action === "grant_routine_action") {
      if (args.provenance !== "stated" && args.provenance !== "installed_explicit_policy") throw new Error("routine action provenance is invalid")
      mutation = {
        kind: "grant_routine_action",
        key: args.key ?? "",
        action: args.routineAction ?? "",
        targets: arrayArgument(args.targetsJson, "targetsJson"),
        maxCount: Number(args.maxCount),
        windowMs: Number(args.windowMs),
        verificationRequired: args.verificationRequired === "true",
        exclusions: arrayArgument(args.exclusionsJson, "exclusionsJson"),
        provenance: args.provenance,
        ...(args.expiresAt ? { expiresAt: args.expiresAt } : {}),
      }
    } else throw new Error("steward policy action is invalid")
    return JSON.stringify(updateStewardPolicy(ctx.agentRoot, { expectedVersion, actor, mutation }))
  },
  riskProfile: (args) => args.action === "read"
    ? { mutates: "none", risk: "low" }
    : { mutates: "durable_state_write", risk: "high", reason: "updates typed household steward policy under authenticated family authority" },
}
