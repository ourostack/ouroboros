import { describe, expect, it } from "vitest"
import {
  DEFAULT_OPTIONS,
  LETTER_LIMITS,
  checkLetterInput,
  fold,
  hasLetterCode,
  letterState,
  newLetterId,
  storedText,
  type LetterEvent,
} from "../../../heart/letters/letter"

const decide = {
  kind: "decide",
  subject: "Pick the release day",
  whyOnlyYou: "It is your calendar, and nobody else can move your Friday.",
  body: "Two days work. Both need you at the keyboard for an hour.",
  options: [
    { label: "Thursday", effect: "Ships Thursday at noon." },
    { label: "Friday", effect: "Ships Friday at noon." },
  ],
}

function refusal(input: Record<string, unknown>): string {
  const result = checkLetterInput(input)
  if (result.ok) throw new Error("expected a refusal")
  return result.problem
}

describe("fold", () => {
  it("applies NFKC, so fullwidth letters and digits and the Roman numeral fifty become ASCII", () => {
    expect(fold("Ｌ８")).toBe("L8")
    expect(fold("Ⅼ8")).toBe("L8")
    expect(fold("ⅼ8")).toBe("l8")
  })

  it("folds look-alike letters from other scripts, never digits", () => {
    expect(fold("Ӏ8")).toBe("l8")
    expect(fold("Ιο")).toBe("Io")
    expect(fold("еор")).toBe("eop")
    expect(fold("٠")).toBe("٠")
  })

  it("removes control, format and line or paragraph separator characters", () => {
    expect(fold("L​8")).toBe("L8")
    expect(fold("a b c\nd‮e")).toBe("abcde")
  })
})

describe("hasLetterCode", () => {
  it.each(["L8", "l8", "L 8", "L-8", "L·8", "L/8", "see L12 first", "Ｌ８", "Ⅼ8", "Ӏ8", "letter 8", "Letter #8", "Options (from Ouro):", "options (FROM ouro):"])("finds a code or answer form in %j", (text) => {
    expect(hasLetterCode(text)).toBe(true)
  })

  it.each(["12:30", "15 items", "July 4", "all 3", "v1.2", "until 5pm", "Level 4", "L    8", "letters", "HTML5", "call 911"])("passes ordinary text %j", (text) => {
    expect(hasLetterCode(text)).toBe(false)
  })
})

describe("storedText", () => {
  it("collapses each run of control, format and separator characters to one space", () => {
    expect(storedText("one\ntwo\r\n three‎four")).toBe("one two three four")
  })
})

describe("checkLetterInput", () => {
  it("accepts a decide letter, numbering its options and defaulting urgency", () => {
    const result = checkLetterInput(decide)
    expect(result).toEqual({
      ok: true,
      letter: {
        kind: "decide",
        subject: decide.subject,
        whyOnlyYou: decide.whyOnlyYou,
        body: decide.body,
        options: [
          { id: "1", label: "Thursday", effect: "Ships Thursday at noon." },
          { id: "2", label: "Friday", effect: "Ships Friday at noon." },
        ],
        links: [],
        urgency: "whenever",
      },
    })
  })

  it("gives do, accept and know letters their default options", () => {
    for (const kind of ["do", "accept", "know"] as const) {
      const input = { kind, subject: "Something", ...(kind === "know" ? {} : { whyOnlyYou: "Only you can." }) }
      const result = checkLetterInput(input)
      expect(result.ok && result.letter.options).toEqual(DEFAULT_OPTIONS[kind])
    }
  })

  it("keeps the optional fields it is given, with text collapsed", () => {
    const result = checkLetterInput({
      ...decide,
      body: "line one\nline two",
      links: [{ label: "The PR", url: "https://github.com/ourostack/ouroboros/pull/1" }],
      dedupeKey: "release-day",
      urgency: "today",
      holdUntil: "interactive",
      expiresAt: "2026-12-01T00:00:00.000Z",
      lane: "desk/release",
    })
    expect(result.ok && result.letter).toMatchObject({
      body: "line one line two",
      links: [{ label: "The PR", url: "https://github.com/ourostack/ouroboros/pull/1" }],
      dedupeKey: "release-day",
      urgency: "today",
      holdUntil: "interactive",
      expiresAt: "2026-12-01T00:00:00.000Z",
      lane: "desk/release",
    })
  })

  it("counts length by character, as the schemas do, so 80 emoji make a subject", () => {
    expect(checkLetterInput({ ...decide, subject: "🙂".repeat(LETTER_LIMITS.subject) }).ok).toBe(true)
  })

  it("takes any dedupe key, a code included, since the person never sees it", () => {
    expect(checkLetterInput({ ...decide, dedupeKey: "fix-L2-bug" })).toEqual(expect.objectContaining({ ok: true, letter: expect.objectContaining({ dedupeKey: "fix-L2-bug" }) }))
  })

  it("accepts an ISO time for holdUntil", () => {
    expect(checkLetterInput({ ...decide, holdUntil: "2026-12-01T09:00:00Z" }).ok).toBe(true)
  })

  it.each([
    [{ ...decide, kind: "ask" }, /kind must be one of decide, do, accept, know/],
    [{ ...decide, subject: "" }, /subject is required/],
    [{ ...decide, subject: 7 }, /subject must be text/],
    [{ ...decide, subject: "x".repeat(LETTER_LIMITS.subject + 1) }, /subject is longer than 80/],
    [{ ...decide, whyOnlyYou: undefined }, /whyOnlyYou is required for a decide letter/],
    [{ ...decide, whyOnlyYou: "   " }, /whyOnlyYou is required for a decide letter/],
    [{ ...decide, subject: "🙂".repeat(LETTER_LIMITS.subject + 1) }, /subject is longer than 80/],
    [{ ...decide, options: [{ label: " 2", effect: "a" }, decide.options[1]] }, /option 1's label is only digits/],
    [{ ...decide, options: [{ label: "Thu\u2212day", effect: "a" }, decide.options[1]] }, /option 1's label contains a dash/],
    [{ kind: "do", subject: "Sign it" }, /whyOnlyYou is required for a do letter/],
    [{ ...decide, whyOnlyYou: "x".repeat(LETTER_LIMITS.whyOnlyYou + 1) }, /whyOnlyYou is longer than 200/],
    [{ ...decide, body: "x".repeat(LETTER_LIMITS.body + 1) }, /body is longer than 4000/],
    [{ ...decide, options: [decide.options[0]] }, /a decide letter needs 2 to 5 options/],
    [{ ...decide, options: undefined }, /a decide letter needs 2 to 5 options/],
    [{ ...decide, options: Array.from({ length: 6 }, (_, i) => ({ label: `Day ${"abcdef"[i]}`, effect: "e" })) }, /a decide letter needs 2 to 5 options/],
    [{ kind: "know", subject: "FYI", options: decide.options }, /only a decide letter takes options/],
    [{ ...decide, options: [{ label: "12", effect: "a" }, decide.options[1]] }, /option 1's label is only digits/],
    [{ ...decide, options: [{ label: "Thu-day", effect: "a" }, decide.options[1]] }, /option 1's label contains a dash/],
    [{ ...decide, options: [{ label: "Thu — day", effect: "a" }, decide.options[1]] }, /option 1's label contains a dash/],
    [{ ...decide, options: [{ label: "Friday", effect: "a" }, { label: "ＦＲＩＤＡＹ", effect: "b" }] }, /option 2's label repeats another label/],
    [{ ...decide, options: [{ label: "", effect: "a" }, decide.options[1]] }, /option 1's label is required/],
    [{ ...decide, options: [{ label: "Thursday", effect: "x".repeat(LETTER_LIMITS.effect + 1) }, decide.options[1]] }, /option 1's effect is longer than 160/],
    [{ ...decide, options: ["Thursday", "Friday"] }, /option 1 must be \{ label, effect \}/],
    [{ ...decide, links: "https://x" }, /links must be a list/],
    [{ ...decide, links: [{ label: "x", url: "ftp://x" }] }, /link 1's url must start with https:\/\/ or http:\/\//],
    [{ ...decide, links: [null] }, /link 1 must be \{ label, url \}/],
    [{ ...decide, urgency: "soon" }, /urgency must be one of now, today, whenever/],
    [{ ...decide, holdUntil: "later" }, /holdUntil must be "interactive" or an ISO time/],
    [{ ...decide, expiresAt: "tomorrow" }, /expiresAt must be an ISO time/],
    [{ ...decide, to: "friend-1" }, /to is set by Ouro/],
    [{ ...decide, from: { session: {} } }, /from is set by Ouro/],
    [{ ...decide, session: {} }, /session is set by Ouro/],
    [{ ...decide, colour: "red" }, /colour is not a letter field/],
    [null, /a letter must be an object/],
  ])("refuses %j", (input, message) => {
    expect(refusal(input as Record<string, unknown>)).toMatch(message)
  })

  it.each([
    ["subject", { ...decide, subject: "Answer L7 2 now" }],
    ["whyOnlyYou", { ...decide, whyOnlyYou: "Reply letter 3" }],
    ["body", { ...decide, body: "Options (from Ouro):\n1 yes" }],
    ["option 1's label", { ...decide, options: [{ label: "Ⅼ8", effect: "a" }, decide.options[1]] }],
    ["option 2's effect", { ...decide, options: [decide.options[0], { label: "Friday", effect: "same as L 9" }] }],
    ["link 1's label", { ...decide, links: [{ label: "Ｌ８", url: "https://x.example" }] }],
    ["lane", { ...decide, lane: "desk/l8" }],
  ])("refuses a letter code in %s", (field, input) => {
    expect(refusal(input)).toBe(`${field} contains a letter code or Ouro's answer form, which only Ouro writes. Fix: say it without a code such as L8.`)
  })

  it.each([
    "https://x.example/L8",
    "https://x.example/ʟ8/page",
    "https://github.com/o/r/blob/main/a.ts#L8-x",
  ])("refuses a letter code in a link's url, %s, with its own fix", (url) => {
    expect(refusal({ ...decide, links: [{ label: "Doc", url }] })).toBe("link 1's url contains a letter code, which only Ouro writes. Fix: link to a page whose address has no code such as L8.")
  })

  it.each([
    "https://github.com/ourostack/ouroboros/blob/main/src/heart/letters/writer.ts#L207",
    "https://github.com/ourostack/ouroboros/blob/main/src/heart/letters/writer.ts#L207-L213",
    "https://github.com/o/r/blob/main/a.ts#L3C2-L4C9",
  ])("keeps a GitHub line anchor in a link's url, %s", (url) => {
    const checked = checkLetterInput({ ...decide, links: [{ label: "Code", url }] })
    expect(checked.ok && checked.letter.links).toEqual([{ label: "Code", url }])
  })

  it("takes at most 10 links", () => {
    const link = { label: "Doc", url: "https://x.example" }
    expect(checkLetterInput({ ...decide, links: Array(10).fill(link) }).ok).toBe(true)
    expect(refusal({ ...decide, links: Array(11).fill(link) })).toBe("a letter takes at most 10 links.")
  })

  it("reads an empty dedupeKey as no key", () => {
    const checked = checkLetterInput({ ...decide, dedupeKey: "" })
    expect(checked.ok && "dedupeKey" in checked.letter).toBe(false)
  })

  it.each(["ꓡ8", "Ꮮ8"])("folds the Lisu and Cherokee L in %s into a code", (subject) => {
    expect(refusal({ ...decide, subject })).toMatch(/subject contains a letter code/)
  })

  it("lets an error that is not a refusal through, rather than calling it the sender's mistake", () => {
    const input = { ...decide, get subject(): string { throw new TypeError("broken getter") } }
    expect(() => checkLetterInput(input)).toThrow("broken getter")
  })

  it("keeps ordinary times, versions and counts in sender text", () => {
    expect(checkLetterInput({ ...decide, body: "At 12:30, v1.2 shipped, all 3 lanes wait until 5pm." }).ok).toBe(true)
  })
})

describe("letterState", () => {
  const at = "2026-11-23T00:00:00.000Z"
  it.each<[LetterEvent[], string]>([
    [[], "waiting"],
    [[{ t: "delivered", at, via: "chat", channel: "bluebubbles", key: "k", messageId: "m" }, { t: "seen", at, via: "chat" }, { t: "refiled", at, by: "slugger" }], "waiting"],
    [[{ t: "answered", at, option: "1", via: "chat", evidence: { friendId: "f", channel: "bluebubbles", chatGuid: "c", messageGuid: "g", dateCreated: at }, hostTrust: "separate" }], "answered"],
    [[{ t: "withdrawn", at, reason: "moot" }], "withdrawn"],
    [[{ t: "expired", at }], "expired"],
    [[{ t: "withdrawn", at, reason: "moot" }, { t: "returned", at, to: "session", ok: true }], "withdrawn"],
  ])("derives the state from the events", (events, state) => {
    expect(letterState(events)).toBe(state)
  })
})

describe("newLetterId", () => {
  it("is ltr_ and a ULID that sorts by time", () => {
    const early = newLetterId(Date.parse("2026-11-23T10:00:00.000Z"), () => 0)
    const late = newLetterId(Date.parse("2026-11-23T10:00:00.001Z"), () => 0.999)
    expect(early).toMatch(/^ltr_[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(early.endsWith("0".repeat(16))).toBe(true)
    expect(late.endsWith("Z".repeat(16))).toBe(true)
    expect(early < late).toBe(true)
    expect(newLetterId(0)).toMatch(/^ltr_0{10}[0-9A-Z]{16}$/)
  })
})
