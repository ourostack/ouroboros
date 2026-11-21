// Approval prompts found from code: a policy that asks, one that never does, one hidden behind a spread, and a resolver.
declare const extra: Record<string, unknown>

export const approvalTools = [
  {
    tool: { type: "function", function: { name: "restart_box", description: "Restart the box.", parameters: {} } },
    handler: () => { throw new Error("box-unreachable") },
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "restarts" },
    approvalPolicy: () => ({ kind: "required", policyId: "box.restart", actionClass: "box", requiresSoleCall: true }),
  },
  {
    tool: { type: "function", function: { name: "list_contacts", description: "List contacts.", parameters: {} } },
    handler: () => "[]",
    riskProfile: { mutates: "none", risk: "low" },
    approvalPolicy: () => ({ kind: "not_required" }),
  },
  {
    tool: { type: "function", function: { name: "resume_queue", description: "Resume the queue.", parameters: {} } },
    handler: () => "resumed",
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "spends" },
    approvalPolicy: sharedPolicy,
  },
  {
    tool: { type: "function", function: { name: "send_mail", description: "Send mail.", parameters: {} } },
    handler: () => "sent",
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "sends" },
  },
  {
    tool: { type: "function", function: { name: "hidden_policy", description: "Policy set elsewhere.", parameters: {} } },
    handler: () => "ok",
    ...extra,
  },
]

function sharedPolicy() {
  return { kind: "required" }
}

export function classify(name: string) {
  if (name !== "restart_box") return "policy"
  if (name === "not_a_tool") return "nothing"
  return name === "restart_box" ? "grant" : "policy"
}

export function decidesNothing(name: string) {
  return name.length
}
