import { emitNervesEvent } from "../nerves/runtime"

// Kick detection is currently disabled (tool_choice: required + settle
// is the primary loop control). Preserved for future re-enablement.
//
// A kick is a self-correction. When the harness detects a malformed response,
// it injects an assistant-role message as if the model caught its own mistake.
// Kicks are assistant-role, first-person, forward-looking, and short.

export type KickReason = "empty" | "narration" | "tool_required";

export interface Kick {
  reason: KickReason;
  message: string;
}

const KICK_MESSAGES: Record<KickReason, string> = {
  empty: "I sent an empty message by accident — let me try again.",
  narration: "I narrated instead of acting. Using the tool now -- if done, calling settle.",
  tool_required: "tool-required is on — I need to call a tool. use /tool-required to turn it off.",
};

const TOOL_INTENT_PATTERNS = [
  // Explicit intent — "let me", "I'll", "I will"
  /\blet me\b/i,
  /\bi'll\b/i,
  /\bi will\b/i,
  /\bi would like to\b/i,
  /\bi want to\b/i,

  // "going to" variants
  /\bi'm going to\b/i,
  /\bgoing to\b/i,
  /\bi am going to\b/i,

  // Present continuous — "i'm checking", "i am querying"
  /\bi'm \w+ing\b/i,
  /\bi am \w+ing\b/i,

  // Action announcements — "I need to", "I should", "I can"
  /\bi need to\b/i,
  /\bi should\b/i,
  /\bi can\b/i,

  // Obligation — "I have to", "I must"
  /\bi have to\b/i,
  /\bwe have to\b/i,
  /\bi must\b/i,
  /\bwe must\b/i,

  // First person plural intent
  /\bwe need to\b/i,
  /\bwe should\b/i,
  /\bwe can\b/i,
  /\bwe'll\b/i,
  /\bwe will\b/i,
  /\bwe're going to\b/i,
  /\bwe are going to\b/i,
  /\blet's\b/i,

  // Gerund phase shifts — "entering", "starting", "proceeding", "switching"
  /\bentering\b/i,
  /\bstarting with\b/i,
  /\bproceeding\b/i,
  /\bswitching to\b/i,

  // Temporal narration — "first", "now I/we", "next turn", "next, I"
  /\bfirst,?\s+i\b/i,
  /\bnow i\b/i,
  /\bnow we\b/i,
  /\bnext turn\b/i,
  /\bnext,?\s+i\b/i,
  /\bnext,?\s+we\b/i,

  // Sequential narration — "then I/we", "after that", "once I/we", "before I/we"
  /\bthen i\b/i,
  /\bthen we\b/i,
  /\bafter that\b/i,
  /\bonce i\b/i,
  /\bonce we\b/i,
  /\bbefore i\b/i,
  /\bbefore we\b/i,

  // Future intent — "about to", "gonna"
  /\babout to\b/i,
  /\bgonna\b/i,

  // Hedged intent — "allow me to", "time to"
  /\ballow me to\b/i,
  /\btime to\b/i,

  // Movement narration — "moving on", "moving to"
  /\bmoving on\b/i,
  /\bmoving to\b/i,

  // Self-narration — "my next step", "my plan", "the plan is", "tool calls only"
  /\bmy next step\b/i,
  /\bmy plan\b/i,
  /\bthe plan is\b/i,
  /\btool calls only\b/i,

  // "Continuing" at start of any line — narration filler (multiline so ^ matches after \n)
  /^continuing\b/im,

  // "continues" anywhere — progress narration ("The work continues", "continues to be complex")
  /\bcontinues\b/i,

  // "Next up" at start of text — e.g. "Next up:", "Next up, I'll..."
  /^next up\b/i,
];

// Normalize curly quotes/apostrophes to straight so patterns match consistently
function normalize(text: string): string {
  return text.replace(/[\u2018\u2019\u2032]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

export function hasToolIntent(text: string): boolean {
  return TOOL_INTENT_PATTERNS.some((p) => p.test(normalize(text)));
}

// Detect what kind of kick is needed, or null if response is fine.
// Priority: empty > narration > tool_required
export function detectKick(
  content: string,
  options?: { toolChoiceRequired?: boolean },
): Kick | null {
  const isEmpty = !content?.trim();

  if (isEmpty) {
    emitNervesEvent({
      level: "error",
      event: "engine.error",
      component: "engine",
      message: "empty assistant content detected",
      meta: { reason: "empty" },
    });
    return { reason: "empty", message: KICK_MESSAGES.empty };
  }

  if (hasToolIntent(content)) {
    emitNervesEvent({
      level: "error",
      event: "engine.error",
      component: "engine",
      message: "narration-style response detected",
      meta: { reason: "narration" },
    });
    return { reason: "narration", message: KICK_MESSAGES.narration };
  }

  if (options?.toolChoiceRequired) {
    emitNervesEvent({
      level: "error",
      event: "engine.error",
      component: "engine",
      message: "tool-required mode response missing tool call",
      meta: { reason: "tool_required" },
    });
    return { reason: "tool_required", message: KICK_MESSAGES.tool_required };
  }

  return null;
}
