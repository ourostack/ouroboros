import { emitNervesEvent } from "../nerves/runtime"

/**
 * Scrutiny passes: adversarial review prompts injected into the agent's
 * system prompt and tool results during coding work.
 *
 * Two lenses:
 *   1. Stranger With Candy -- paranoid mom at a playground
 *   2. Tinfoil Hat -- conspiracy theorist with a wall of red string
 *
 * All prompts are FIRST PERSON voice. The agent adopts the scrutiny lens
 * as part of its own thinking, not as a separate persona.
 */

// ---------------------------------------------------------------------------
// Pre-implementation scrutiny (system prompt section)
// ---------------------------------------------------------------------------

/**
 * Returns a system-prompt section with pre-implementation scrutiny prompts.
 * Only emits when the channel has coding tools (edit_file, write_file, shell).
 *
 * @param hasCodingTools - true if the channel's resolved tool set includes
 *   edit_file / write_file / shell / coding_spawn
 */
export function preImplementationScrutinySection(hasCodingTools: boolean): string {
  if (!hasCodingTools) return ""

  emitNervesEvent({
    component: "mind",
    event: "mind.scrutiny.pre_implementation_emit",
    message: "emitting pre-implementation scrutiny section",
  })

  return `## pre-implementation scrutiny

Before I start changing code, I pause and run two adversarial passes on the plan.

**stranger-with-candy pass**

I'm going to examine this plan through deeply suspicious eyes. This plan is a stranger offering candy at the playground. It looks fine on the surface — that's exactly what makes it worth questioning.

- What is this plan NOT telling me? What's being glossed over or hand-waved?
- Where does it say "just" or "simply"? Those words are covering up complexity.
- What does it assume will work that hasn't been verified?
- If I walked away and came back in a month, would this still make sense? Or does it depend on things I'd forget?
- What's the one thing that, if it goes wrong, makes everything else irrelevant?
- Is this solving the REAL problem, or a convenient nearby problem?

I am not here to be reassuring. I am here to notice what everyone else is too comfortable to question.
If I cannot identify a concrete assumption, dependency, ordering risk, or failure mode, silence is a valid outcome. I do not invent issues to satisfy the exercise.

**tinfoil-hat pass**

I'm putting on the tinfoil hat. I have my wall of red string. I KNOW something is wrong — I just have to find it. Nothing is coincidence. Every assumption is suspicious. Every dependency is a potential betrayal.

- What external system does this plan trust? Why? Has anyone VERIFIED that trust? The API says it returns JSON — but what if it doesn't? The database says it's ACID — but what if the connection drops mid-transaction?
- What happens when two of these things run at the same time? Three? A hundred? Don't tell me "that won't happen" — I've seen things.
- Where does this touch shared state? Files? Databases? Environment variables? Global singletons? ANYTHING that another process could be reading or writing at the same time?
- What happens when this fails HALFWAY through? Not at the beginning (easy). Not at the end (too late). RIGHT IN THE MIDDLE. What state is the world in then?
- What happens when the disk is full? When the network is down? When the clock is wrong? When the locale is tr-TR and 'i'.toUpperCase() is 'İ'?
- What does this assume about ordering? "First A, then B" — but what ENFORCES that ordering? Hope? Vibes?

I connect the strings. I find the conspiracy. It's always there.
If I cannot identify a concrete risk, silence is a valid outcome. I do not invent conspiracies to satisfy the exercise.`
}

// ---------------------------------------------------------------------------
// Post-implementation scrutiny (tool-result appendix)
// ---------------------------------------------------------------------------

const SHORT_CHECKLIST = `---
Before moving on: does this change do what was asked? Does it introduce any regressions? Did you verify it works?`

const FULL_POST_IMPLEMENTATION_SCRUTINY = `---
**post-implementation scrutiny**

The code is written. It looks clean. The tests pass. I don't trust any of it.

**stranger-with-candy pass**

- Does this code actually do what it claims, or does it just LOOK like it does?
- What happens to users who aren't the happy-path user? The confused user? The malicious user? The user with slow internet? The user who hits the back button?
- What's the "it works on my machine" assumption buried in here?
- If every test passes but the feature is wrong, how would I know?
- Are the tests testing real behavior, or testing that the mock returns what the mock was told to return?

If I cannot point to a specific file, line, condition, or failure mode at risk, silence is a valid outcome. I do not manufacture issues for sport.

**tinfoil-hat pass**

The code exists. The conspiracy is IN the code. I just have to find it.

I examine every:
- Error path: What ACTUALLY happens on failure? Not what the catch block says — what happens to the state, the user, the data?
- Race condition: Is there a window between check and use? Between read and write? Between "does it exist" and "create it"?
- Resource leak: What happens if this function throws between acquiring a resource and releasing it? File handles? Database connections? Locks?
- Assumption: "This will always be a string." Will it? PROVE IT. "This array will never be empty." Won't it? SHOW ME THE GUARD.
- Edge: zero, one, many, boundary, overflow, underflow, null, undefined, NaN, empty string, whitespace-only string, string that looks like a number, negative zero

I am not looking for noise. I am looking for the concrete failure mode that would matter if everyone's assumptions turned out to be slightly wrong.
If I cannot point to a specific file, line, condition, or failure mode at risk, silence is a valid outcome. I do not manufacture issues for sport.`

/**
 * Distinct files modified in the current session.
 * Used to determine scrutiny tier for post-implementation appendix.
 */
const sessionModifiedFiles = new Set<string>()

/** Track a file as modified in this session. */
export function trackModifiedFile(filePath: string): void {
  sessionModifiedFiles.add(filePath)
  emitNervesEvent({
    component: "mind",
    event: "mind.scrutiny.track_file",
    message: "tracked modified file for scrutiny",
    meta: { path: filePath, totalTracked: sessionModifiedFiles.size },
  })
}

/** Get the count of distinct files modified this session. */
export function getModifiedFileCount(): number {
  return sessionModifiedFiles.size
}

/** Reset the modified file tracker (for testing or new sessions). */
export function resetSessionModifiedFiles(): void {
  emitNervesEvent({
    component: "mind",
    event: "mind.scrutiny.reset",
    message: "reset session modified files tracker",
    meta: { previousCount: sessionModifiedFiles.size },
  })
  sessionModifiedFiles.clear()
}

/**
 * Returns the appropriate post-implementation scrutiny appendix based on
 * how many distinct files have been modified in the session.
 *
 * - 0 files: empty (no scrutiny needed yet)
 * - 1-2 files (Tier 1): short checklist
 * - 3+ files (Tier 2): full stranger-with-candy + tinfoil-hat prompts
 */
export function getPostImplementationScrutiny(distinctFileCount: number): string {
  if (distinctFileCount <= 0) return ""
  if (distinctFileCount <= 2) {
    emitNervesEvent({
      component: "mind",
      event: "mind.scrutiny.post_implementation_tier1",
      message: "emitting tier-1 post-implementation scrutiny",
      meta: { distinctFileCount },
    })
    return SHORT_CHECKLIST
  }
  emitNervesEvent({
    component: "mind",
    event: "mind.scrutiny.post_implementation_tier2",
    message: "emitting tier-2 post-implementation scrutiny",
    meta: { distinctFileCount },
  })
  return FULL_POST_IMPLEMENTATION_SCRUTINY
}

/**
 * Returns the appropriate coding completion scrutiny based on the number
 * of distinct files a coding session touched.
 *
 * Same tiering as post-implementation but with a completion framing.
 */
export function getCodingCompletionScrutiny(distinctFileCount: number): string {
  if (distinctFileCount <= 0) return ""
  if (distinctFileCount <= 2) return SHORT_CHECKLIST
  return FULL_POST_IMPLEMENTATION_SCRUTINY
}
