import { test } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import { checkCard } from "./cards.mts";
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
