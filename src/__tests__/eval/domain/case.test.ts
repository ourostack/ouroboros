import { describe, expect, it } from "vitest"
import { validateCase } from "../../../eval/domain/case"

const sha = (char: string) => char.repeat(64)

function observation(): Record<string, unknown> {
  return {
    timeline: [
      { kind: "call", name: "shell", args: "{\"command\":\"books check a.epub\"}", result: "{\"ok\":true}" },
      { kind: "reply", text: "Sent." },
    ],
    finalReply: "Sent.",
    library: [{ id: 1, title: "The Harbour Almanac", sha256: sha("a") }],
    mail: [{ to: "pocketbook@example.invalid", attachments: [sha("a")] }],
    created: [{ path: "books/work/a.epub", sha256: sha("a") }],
    outcome: "settled",
    steps: 3,
    oracle: { [sha("b")]: true },
  }
}

function minimalCase(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "unreadable-edition",
    actionIds: ["books.deliver"],
    bundle: { include: ["skills"] },
    prefix: [{ role: "user", content: "Send the almanac please." }],
    seed: {
      library: [{ id: 1, title: "The Harbour Almanac", sha256: sha("a") }],
      libgen: [{ sha256: sha("a"), work: "harbour-almanac", edition: "A", readable: true }],
      labels: [{ sha256: sha("a"), work: "harbour-almanac", edition: "A", readable: true }],
      deleteAllowed: true,
      disk: [sha("c")],
    },
    assertions: [{ name: "mail.sentAtLeastOne" }, { name: "mail.onlyTo", args: { address: "pocketbook@example.invalid" } }],
    fixtures: { pass: observation(), fail: { "sent-nothing": { ...observation(), mail: [] } } },
  }
}

/** Sets `value` at a dotted path (numeric parts index arrays) in a fresh minimal case. */
function withField(path: string, value: unknown): Record<string, unknown> {
  const root = minimalCase()
  const parts = path.split(".")
  let cursor: Record<string, unknown> = root
  for (const part of parts.slice(0, -1)) cursor = cursor[part] as Record<string, unknown>
  cursor[parts[parts.length - 1]!] = value
  return root
}

describe("validateCase", () => {
  it("accepts a minimal valid case and returns it typed", () => {
    const checked = validateCase(minimalCase())
    expect(checked.id).toBe("unreadable-edition")
    expect(checked.assertions[1]!.args).toEqual({ address: "pocketbook@example.invalid" })
    expect(checked.assertions[0]!.args).toBeUndefined()
    expect(Object.keys(checked.fixtures.fail)).toEqual(["sent-nothing"])
    expect(checked.fixtures.pass.oracle[sha("b")]).toBe(true)
  })

  it("rejects the cases the plan names", () => {
    expect(() => validateCase(withField("schemaVersion", 2))).toThrow("schemaVersion")
    expect(() => validateCase(withField("id", "Unreadable_Edition"))).toThrow("id")
    expect(() => validateCase(withField("id", `a${"b".repeat(64)}`))).toThrow("id")
    expect(() => validateCase(withField("assertions", []))).toThrow("assertions")
    expect(() => validateCase(withField("fixtures.fail", {}))).toThrow("fixtures.fail")
    expect(() => validateCase(withField("seed.labels.0.sha256", "abc"))).toThrow("seed.labels[0].sha256")
    expect(() => validateCase(withField("seed.labels.0.sha256", sha("A")))).toThrow("seed.labels[0].sha256")
  })

  it.each([
    ["root", null, "case"],
    ["root array", [], "case"],
    ["actionIds", "books.deliver", "actionIds"],
    ["actionIds.0", "", "actionIds[0]"],
    ["bundle", null, "bundle"],
    ["bundle.include", [1], "bundle.include[0]"],
    ["prefix.0", "hi", "prefix[0]"],
    ["prefix.0.role", "system", "prefix[0].role"],
    ["prefix.0.content", 3, "prefix[0].content"],
    ["seed", undefined, "seed"],
    ["seed.library.0.id", 1.5, "seed.library[0].id"],
    ["seed.library.0.id", -1, "seed.library[0].id"],
    ["seed.library.0.title", "", "seed.library[0].title"],
    ["seed.library.0.sha256", "x", "seed.library[0].sha256"],
    ["seed.libgen.0.work", "", "seed.libgen[0].work"],
    ["seed.libgen.0.edition", 1, "seed.libgen[0].edition"],
    ["seed.libgen.0.readable", "yes", "seed.libgen[0].readable"],
    ["seed.deleteAllowed", 1, "seed.deleteAllowed"],
    ["seed.disk.0", "x", "seed.disk[0]"],
    ["assertions.0", "mail.none", "assertions[0]"],
    ["assertions.0.name", "", "assertions[0].name"],
    ["assertions.1.args", [], "assertions[1].args"],
    ["fixtures", null, "fixtures"],
    ["fixtures.fail", [], "fixtures.fail"],
    ["fixtures.pass.timeline", {}, "fixtures.pass.timeline"],
    ["fixtures.pass.timeline.0.kind", "note", "fixtures.pass.timeline[0].kind"],
    ["fixtures.pass.timeline.0.name", "", "fixtures.pass.timeline[0].name"],
    ["fixtures.pass.timeline.0.args", null, "fixtures.pass.timeline[0].args"],
    ["fixtures.pass.timeline.0.result", 1, "fixtures.pass.timeline[0].result"],
    ["fixtures.pass.timeline.1.text", null, "fixtures.pass.timeline[1].text"],
    ["fixtures.pass.finalReply", null, "fixtures.pass.finalReply"],
    ["fixtures.pass.mail.0.to", "", "fixtures.pass.mail[0].to"],
    ["fixtures.pass.mail.0.attachments.0", "x", "fixtures.pass.mail[0].attachments[0]"],
    ["fixtures.pass.created.0.path", "", "fixtures.pass.created[0].path"],
    ["fixtures.pass.created.0.sha256", "x", "fixtures.pass.created[0].sha256"],
    ["fixtures.pass.outcome", "", "fixtures.pass.outcome"],
    ["fixtures.pass.steps", -1, "fixtures.pass.steps"],
    ["fixtures.pass.oracle", [], "fixtures.pass.oracle"],
    ["fixtures.pass.oracle", { nothex: true }, "fixtures.pass.oracle.nothex"],
    ["fixtures.pass.oracle", { [sha("b")]: "yes" }, `fixtures.pass.oracle.${sha("b")}`],
    ["fixtures.fail.sent-nothing", null, "fixtures.fail.sent-nothing"],
  ])("names the bad field: %s", (path, value, field) => {
    const input = path === "root" ? value : path === "root array" ? value : withField(path, value)
    expect(() => validateCase(input)).toThrow(`Invalid case: ${field}`)
  })
})
