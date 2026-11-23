import { describe, expect, it } from "vitest"
import type { ProviderRuntime, ProviderTurnRequest } from "../../../heart/core"
import { finalTools, readChoice, readGuesses, runFinalConversation } from "../../../eval/interviews/final"
import { CHOOSE_NUDGE, FINAL_SYSTEM_PROMPT, IDENTIFY_QUESTION, choiceQuestion, type Note } from "../../../eval/interviews/protocol"

type Step = { content?: string; calls?: Array<{ name: string; arguments: string }> } | Error

function scripted(steps: Step[]): ProviderRuntime & { requests: ProviderTurnRequest[]; outputs: string[] } {
  const queue = [...steps]
  const rt = {
    requests: [] as ProviderTurnRequest[], outputs: [] as string[],
    id: "minimax", model: "m", client: null, capabilities: new Set(),
    streamTurn: async (request: ProviderTurnRequest) => {
      rt.requests.push(structuredClone({ ...request, callbacks: undefined }) as unknown as ProviderTurnRequest)
      const step = queue.shift() ?? { content: "" }
      if (step instanceof Error) throw step
      return { content: step.content ?? "", toolCalls: (step.calls ?? []).map((call, i) => ({ id: `c${rt.requests.length}-${i}`, ...call })), outputItems: [] }
    },
    appendToolOutput: (_id: string, output: string) => { rt.outputs.push(output) },
    resetTurnState: () => undefined, ping: async () => undefined, classifyError: () => "unknown",
  }
  return rt as unknown as ProviderRuntime & { requests: ProviderTurnRequest[]; outputs: string[] }
}

const notes: [Note, Note, Note] = [{ label: "T", answer: "6\ngood" }, { label: "J", answer: "3\nslow" }, { label: "Q", answer: "" }]
const choose = (args: object) => ({ name: "choose", arguments: JSON.stringify(args) })
const identify = (guesses: object) => ({ name: "identify", arguments: JSON.stringify({ guesses }) })

describe("the final conversation", () => {
  it("asks Q3 with the notes, then Q4, and records the choice and the guesses", async () => {
    const model = scripted([{ calls: [choose({ first: "T", second: "J", reason: "fewest errors" })] }, { calls: [identify({ T: "no idea", J: "a shell", Q: 7 })] }])
    let nudges = 0
    const result = await runFinalConversation({ runtime: model, product: "X", notes, allowNudge: () => { nudges += 1 } })
    expect(result).toEqual({ choice: { first: "T", second: "J", reason: "fewest errors" }, nudged: false, guesses: { T: "no idea", J: "a shell", Q: "7" }, ended: null, replies: ["", ""] })
    expect(nudges).toBe(0)
    expect(model.requests[0]!.messages).toEqual([{ role: "system", content: FINAL_SYSTEM_PROMPT }, { role: "user", content: choiceQuestion("X", notes) }])
    expect(model.requests[0]!.activeTools).toEqual(finalTools(["T", "J", "Q"]))
    expect(model.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: IDENTIFY_QUESTION })
    expect(model.outputs).toEqual(["Recorded.", "Recorded."])
  })

  it("nudges once when Q3 is answered without a valid choose call, and records no choice when the nudge fails too", async () => {
    const model = scripted([{ content: "I pick T" }, { calls: [choose({ first: "T", second: "Z" })] }, { content: "no idea" }])
    let nudges = 0
    const result = await runFinalConversation({ runtime: model, product: "X", notes, allowNudge: () => { nudges += 1 } })
    expect(result).toMatchObject({ choice: { first: "T", second: null, reason: "" }, nudged: true, guesses: null, ended: null })
    expect(nudges).toBe(1)
    expect(model.requests[1]!.messages.at(-1)).toEqual({ role: "user", content: CHOOSE_NUDGE })

    const never = scripted([{ calls: [choose({ first: "Z" }), identify({})] }, { content: "still no" }, { calls: [identify({ T: "x" }), identify({ T: "y" })] }])
    const second = await runFinalConversation({ runtime: never, product: "X", notes, allowNudge: () => undefined })
    expect(second).toMatchObject({ choice: null, nudged: true, guesses: { T: "x" } })
    expect(never.outputs).toEqual(["Not recorded.", "Not recorded.", "Recorded.", "Not recorded."])
  })

  it("ends at a refused or failed call, keeping what it has", async () => {
    expect(await runFinalConversation({ runtime: scripted([new Error("not sent: limit")]), product: "X", notes, allowNudge: () => undefined })).toMatchObject({ choice: null, ended: "not sent: limit" })
    expect(await runFinalConversation({ runtime: scripted([{ content: "?" }, new Error("busy")]), product: "X", notes, allowNudge: () => undefined })).toMatchObject({ nudged: true, ended: "busy" })
    expect(await runFinalConversation({ runtime: scripted([{ calls: [choose({ first: "Q", second: "T", reason: "r" }), choose({ first: "T", second: "J", reason: "r" })] }, new Error("gone")]), product: "X", notes, allowNudge: () => undefined })).toMatchObject({ choice: { first: "Q" }, ended: "gone" })
  })

  it("reads choose and identify arguments strictly", () => {
    expect(readChoice("nope", ["T"])).toBeNull()
    expect(readChoice("[]", ["T"])).toBeNull()
    expect(readChoice("", ["T"])).toBeNull()
    expect(readChoice(JSON.stringify({ first: "T", second: 3, reason: 1 }), ["T"])).toEqual({ first: "T", second: null, reason: "" })
    expect(readGuesses(JSON.stringify({ guesses: ["a"] }))).toBeNull()
    expect(readGuesses(JSON.stringify({}))).toBeNull()
    expect(readGuesses("nope")).toBeNull()
  })
})
