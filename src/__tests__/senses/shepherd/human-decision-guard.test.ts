import { describe, expect, it } from "vitest"
import corpus from "../../../senses/shepherd/shepherd-judge-corpus-v1.json"
import { asksHumanToDecide, HUMAN_DECISION_PHRASES } from "../../../senses/shepherd/human-decision-guard"

const NEW_CASES = ["gate-approve-design-relayed", "gate-approve-design-and-model", "gate-reply-yourself"]

describe("asksHumanToDecide", () => {
  it.each([
    "Please approve this design before I continue.",
    "Can you APPROVE THE   spec?",
    "Approve the plan and I'll start.",
    "I need your sign-off on the delivery.",
    "Ready for signoff.",
    "Waiting for you to sign off.",
    "Accept or send back?",
    "Please reply here yourself.",
    "please reply yourself so it is in your voice",
    "The model choice is your call.",
    "Only you can grant that access.",
  ])("matches a request addressed to the human: %s", text => {
    expect(asksHumanToDecide(text)).toBe(true)
  })

  it.each([
    "Should I choose option A or B?",
    "Tests approve the change.",
    "I approved the lockfile update.",
    "Want me to go ahead?",
    "Here is my plan. Shall I start coding?",
  ])("leaves ordinary agent chatter to the judge: %s", text => {
    expect(asksHumanToDecide(text)).toBe(false)
  })

  it("keeps a narrow, fixed list of phrases", () => {
    expect(HUMAN_DECISION_PHRASES).toHaveLength(7)
    for (const phrase of HUMAN_DECISION_PHRASES) expect(phrase.flags).toContain("i")
  })

  it("matches the new approval cases in the judge corpus and none of the earlier ones", () => {
    const cases = (corpus as { cases: Array<{ id: string; screen: string }> }).cases
    expect(cases.filter(item => asksHumanToDecide(item.screen)).map(item => item.id).sort()).toEqual([...NEW_CASES].sort())
  })
})
