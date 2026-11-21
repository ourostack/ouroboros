import { test } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import { checkCard, checkDeclaredBy } from "./cards.mts";
import type { Door, DoorCard, GroupCard } from "./types.mts";

const groups: GroupCard[] = [{ id: "agent", when: "Talk to and steer a running Ouro agent." }];

function door(overrides: Partial<Door> = {}, card: Partial<DoorCard> = {}): Door {
  const id = overrides.id ?? "mcp:ask";
  return {
    id,
    kind: "mcp",
    product: "harness",
    name: "ask",
    description: "Ask the agent something.",
    file: "src/heart/mcp/mcp-server.ts",
    line: 654,
    evidence: { readOnly: true },
    ...overrides,
    card: {
      id,
      group: "agent",
      when: "Ask the agent a question and wait for its answer in this turn.",
      effect: "read",
      errors: [{ code: "agent-unreachable", means: "The agent's daemon isn't running.", fix: "Run ouro up, then ask again." }],
      ...card,
    },
  };
}

const ctx = { groups, others: [] as Door[] };

test("a valid card has no reasons", () => {
  deepEqual(checkCard(door(), ctx), []);
});

test("when over 200 characters or with a newline is weak", () => {
  ok(checkCard(door({}, { when: "word ".repeat(50) }), ctx).includes("when: not one line of 6 to 200 characters"));
  ok(checkCard(door({}, { when: "Ask the agent a question\nand wait for it." }), ctx).includes("when: not one line of 6 to 200 characters"));
});

test("when made only of the door's own name and description words is weak", () => {
  const reasons = checkCard(door({ name: "ask", description: "Ask the agent" }, { when: "Use when you need to ask the agent" }), ctx);
  ok(reasons.includes("when: fewer than 3 words beyond the door's own name and description"), reasons.join("; "));
});

test("two doors sharing a when skeleton are weak", () => {
  const ask = door({}, { when: "Use this to ask" });
  const status = door({ id: "mcp:status", name: "status" }, { when: "Use this to status" });
  const others = [ask, status];
  ok(checkCard(ask, { groups, others }).includes("when: same skeleton as mcp:status"));
  ok(checkCard(status, { groups, others }).includes("when: same skeleton as mcp:ask"));
});

test("an unknown group is weak", () => {
  ok(checkCard(door({}, { group: "nope" }), ctx).includes("group: no group card named nope"));
});

test("a group whose own when line is weak makes the door weak", () => {
  const reasons = checkCard(door(), { groups: [{ id: "agent", when: "agent" }], others: [] });
  ok(reasons.includes("group: agent has a weak when line"), reasons.join("; "));
});

test("no errors is weak for an mcp door", () => {
  ok(checkCard(door({}, { errors: [] }), ctx).includes("errors: none declared"));
});

test("an error whose fix repeats its meaning is weak", () => {
  const reasons = checkCard(door({}, { errors: [{ code: "agent-unreachable", means: "The agent is down.", fix: "The agent is down." }] }), ctx);
  ok(reasons.includes("errors[0]: fix repeats means"));
});

test("a code that isn't kebab-case is weak", () => {
  const reasons = checkCard(door({}, { errors: [{ code: "AgentDown", means: "The agent is down.", fix: "Run ouro up." }] }), ctx);
  ok(reasons.includes("errors[0]: code is not kebab-case"));
});

test("one error set on more than 3 doors is weak", () => {
  const four = ["ask", "status", "catchup", "delegate"].map((name) => door({ id: `mcp:${name}`, name }));
  for (const d of four) {
    ok(checkCard(d, { groups, others: four }).includes("errors: same set as 3 other doors"), d.id);
  }
  const three = four.slice(0, 3);
  ok(!checkCard(three[0]!, { groups, others: three }).some((r) => r.startsWith("errors: same set")));
});

test("read without evidence is weak", () => {
  ok(checkCard(door({ evidence: {} }), ctx).includes("effect: read without evidence"));
});

test("read with evidence of mutation is weak", () => {
  const reasons = checkCard(door({ evidence: { mutates: "external_side_effect" } }), ctx);
  ok(reasons.includes("effect: read, but the code mutates (external_side_effect)"));
});

test("consequential without confirm is weak", () => {
  ok(checkCard(door({ evidence: {} }, { effect: "consequential" }), ctx).includes("confirm: required for consequential"));
});

test("a card whose id differs from the door's is weak", () => {
  ok(checkCard(door({}, { id: "mcp:other" }), ctx).includes("id: card says mcp:other"));
});

test("a write card on a door the code calls read-only is weak", () => {
  ok(checkCard(door({}, { effect: "write" }), ctx).includes("effect: write, but the code says read-only"));
});

test("an effect outside the consent classes is weak", () => {
  ok(checkCard(door({}, { effect: "maybe" as never }), ctx).includes("effect: not one of read, write, consequential, person-only"));
});

test("error sets compare whatever order their cards are in", () => {
  const a = { code: "agent-unreachable", means: "The agent's daemon isn't running.", fix: "Run ouro up, then ask again." };
  const b = { code: "bad-question", means: "The question was empty.", fix: "Ask with a question." };
  const four = ["ask", "status", "catchup", "delegate"].map((name, i) => door({ id: `mcp:${name}`, name }, { errors: i % 2 ? [a, b] : [b, a] }));
  ok(checkCard(four[0]!, { groups, others: four }).includes("errors: same set as 3 other doors"));
});

test("an error code the handler never raises is weak", () => {
  const reasons = checkCard(door({ evidence: { readOnly: true, raises: [] } }), ctx);
  ok(reasons.includes("errors[0]: code agent-unreachable is never raised in src/heart/mcp/mcp-server.ts"), reasons.join("; "));
});

test("an error code the handler raises passes", () => {
  deepEqual(checkCard(door({ evidence: { readOnly: true, raises: ["agent-unreachable"] } }), ctx), []);
});

test("a door the code also reaches by another word must list that alias on its card", () => {
  const stop = { id: "cli:stop", kind: "cli" as const, name: "stop", aliases: ["down"] };
  ok(checkCard(door(stop), ctx).includes("aliases: the code also accepts down; list it on the card"));
  deepEqual(checkCard(door(stop, { aliases: ["down"] }), ctx), []);
});

test("an in-turn tool's card and its approval policy must agree both ways", () => {
  const tool = (effect: DoorCard["effect"], approval: boolean) =>
    door({ id: "tool:restart", kind: "tool", name: "restart", evidence: { approval, mutates: "external_side_effect" } }, { effect, ...(effect === "consequential" ? { confirm: "Restart it now?" } : {}) });
  deepEqual(checkCard(tool("consequential", true), ctx), []);
  deepEqual(checkCard(tool("write", false), ctx), []);
  ok(checkCard(tool("consequential", false), ctx).includes("effect: consequential, but the code never asks for approval (no approvalPolicy)"));
  ok(checkCard(tool("write", true), ctx).includes("effect: write, but the code asks for approval; say consequential"));
  // read with approval keeps its own reason, once.
  deepEqual(checkCard(tool("read", true), ctx), ["effect: read, but the code mutates (external_side_effect)", "effect: read, but the code asks for approval"]);
  // Other kinds may be consequential without a policy: the CLI asks through its gate.
  deepEqual(checkCard(door({}, { effect: "consequential", confirm: "Ask it?" }), { groups, others: [] }).filter((r) => r.includes("approval")), []);
});

test("an approval prompt is weak unless its tool's card is valid, consequential and has its question", () => {
  const prompt = (card: Partial<DoorCard>) => door({ id: "approval:restart", kind: "approval", name: "restart", declaredBy: "tool:restart", evidence: { approval: true } }, { id: "tool:restart", ...card });
  deepEqual(checkDeclaredBy(prompt({ effect: "consequential", confirm: "Restart it now?" }), false), []);
  deepEqual(checkDeclaredBy(prompt({ effect: "write" }), true), [
    "card: tool:restart is weak",
    "effect: the code asks for approval here, but tool:restart says write",
    "confirm: required for consequential",
  ]);
});
