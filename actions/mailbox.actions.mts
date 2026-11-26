// The Mailbox's doors, declared once: the letters an agent files for its person and how they are read. `ouro-actions
// generate` writes the CLI's commands, the MCP tools and the rest into actions/generated/mailbox, and
// `ouro-actions-tools generate` writes the in-turn tools into actions/generated/mailbox-tools; never edit those folders
// by hand. The harness dispatches every door from those files (src/heart/letters/doors.ts), and the daemon's single
// writer does the work (src/heart/letters/writer.ts).
//
// This is its own set, apart from ouro.actions.mts, because the in-turn tools projection turns every action of a set into
// a tool a model is given: the mailbox group is the first group the harness dispatches from its generated files.
import { defineAction, defineActions, field } from "../tools/ouro-actions/ouro-actions.mts";

const daemonDown = {
  code: "daemon-down",
  means: "The Ouro daemon, which keeps the letters, isn't running, so nothing was read or filed.",
  fix: "Start it with `ouro up`, then call again.",
};
const unknownInput = (id: string) => ({
  code: "unknown-input",
  means: `The call passed an input ${id} doesn't take, such as to or from, which Ouro sets; the text names it.`,
  fix: "Call it again with only the inputs its schema lists.",
});
const badInput = {
  code: "bad-input",
  means: "An input is missing or has the wrong type or value; the text names it and what it takes.",
  fix: "Call it again with that input as its schema describes.",
};
const noAgent = {
  code: "no-agent",
  means: "No agent bundle by that name is on this machine, so there are no letters to read or file.",
  fix: "Name an agent this machine has; `ouro status` lists them.",
};
const notFound = {
  code: "not-found",
  means: "No letter has that id or code.",
  fix: "Find it with mailbox_list (all: true lists closed letters too), then call again with its id or code.",
};
const letterId = field.string({
  label: "Letter",
  description: "The letter's id (ltr_…) or its code (L7).",
  arg: true,
  maxLength: 64,
});
const outcome = (values: string) => field.string({ label: "Outcome", description: values });
const state = field.string({ label: "State", description: "waiting, answered, withdrawn or expired; Ouro derives it from the letter's events." });

export const mailboxSend = defineAction({
  id: "mailbox_send",
  consent: "write",
  label: "Write a letter",
  description: "File a letter only your person can answer.",
  agent: "File a letter to this agent's person: a request only they can answer, with the options their answer picks from. The answer comes back to the sender.",
  when: "Pick this to ask the person something only they can answer, once per question; a send with the same dedupeKey returns the letter already filed.",
  errors: [
    { code: "invalid-letter", means: "A field broke a letter rule, such as a missing whyOnlyYou or a letter code in sender text; the text names the field.", fix: "Fix that field as the text says, then send again." },
    { code: "no-person", means: "Ouro can't tell who this agent's person is: no family friend record, or several, names this machine's owner.", fix: "Have the person run `ouro friend dedupe --apply`, or link their record to this machine, then send again." },
    daemonDown,
    unknownInput("mailbox_send"),
    badInput,
    noAgent,
  ],
  input: {
    kind: field.enum({ label: "Kind", description: "decide: pick one of 2 to 5 options; do: a task only they can do; accept: approve finished work; know: something they should know.", values: ["decide", "do", "accept", "know"] }),
    subject: field.string({ label: "Subject", description: "What is asked, in one line of at most 80 characters.", maxLength: 80 }),
    whyOnlyYou: field.string({ label: "Why only you", description: "Why only the person can answer, at most 200 characters; required unless kind is know.", optional: true, maxLength: 200 }),
    body: field.string({ label: "Details", description: "What the person needs to answer, in Markdown, at most 4,000 characters.", optional: true, maxLength: 4000, multiline: true }),
    options: field.list({
      label: "Options",
      description: "For a decide letter only: 2 to 5 options, each { label, effect }. Labels are words, without dashes, each its own.",
      optional: true,
      protocolOnly: true,
      minItems: 2,
      maxItems: 5,
      of: field.group({ label: "Option", description: "One answer the person can pick.", fields: {
        label: field.string({ label: "Label", description: "The option's words, at most 40 characters.", maxLength: 40 }),
        effect: field.string({ label: "Effect", description: "What happens when the person picks it, at most 160 characters.", maxLength: 160 }),
      } }),
    }),
    links: field.list({
      label: "Links",
      description: "Pages the person may want while answering, at most 10, each { label, url }.",
      optional: true,
      protocolOnly: true,
      maxItems: 10,
      of: field.group({ label: "Link", description: "One page.", fields: {
        label: field.string({ label: "Label", description: "The link's words.", maxLength: 80 }),
        url: field.string({ label: "Address", description: "An https:// or http:// address.", maxLength: 500 }),
      } }),
    }),
    dedupeKey: field.string({ label: "Dedupe key", description: "A key of yours for this question: a send with a key you used before returns that letter instead of filing another.", optional: true, maxLength: 120, protocolOnly: true }),
    urgency: field.enum({ label: "Urgency", description: "How soon it matters.", values: ["now", "today", "whenever"], optional: true, default: "whenever" }),
    holdUntil: field.string({ label: "Hold until", description: "\"interactive\" to hold it for a session with the person, or an ISO time.", optional: true, maxLength: 40 }),
    // No `format`: the in-turn dispatcher's schema compiler knows no formats, so the writer checks the time instead.
    expiresAt: field.string({ label: "Expires", description: "An ISO time after which the question is moot, such as 2026-12-01T17:00:00Z.", optional: true, maxLength: 40 }),
    lane: field.string({ label: "Lane", description: "Where you ask from, such as a desk task path, so the person knows who waits.", optional: true, maxLength: 120 }),
  },
  output: {
    outcome: outcome("needs-human when a new letter was filed, done when the send matched a letter already filed, preview on a dry run."),
    id: field.string({ label: "Letter", description: "The letter's id, the receipt; empty on a dry run.", returned: true }),
    code: field.string({ label: "Code", description: "The letter's code, such as L7; empty on a dry run." }),
    state,
    message: field.string({ label: "Message", description: "What happened, in one line." }),
  },
  cli: "mailbox send",
});

export const mailboxList = defineAction({
  id: "mailbox_list",
  consent: "read",
  label: "Letters",
  description: "List the letters waiting for you.",
  agent: "List the letters this agent's person has been sent that still wait for an answer, oldest first, or every letter with all. Read only.",
  when: "Pick this to see which letters still wait for the person's answer before filing another; it only reads.",
  errors: [daemonDown, unknownInput("mailbox_list"), badInput, noAgent],
  input: {
    all: field.boolean({ label: "All", description: "List answered, withdrawn and expired letters too.", optional: true }),
    mine: field.boolean({ label: "Mine", description: "Only the letters this agent filed.", optional: true }),
    kind: field.enum({ label: "Kind", description: "Only letters of this kind.", values: ["decide", "do", "accept", "know"], optional: true }),
  },
  output: {
    outcome: outcome("done, when the pile was read."),
    count: field.integer({ label: "Letters", description: "How many letters the listing holds." }),
    listing: field.string({ label: "Letters", description: "One letter per line, oldest first: code, state, age and subject; empty when none match." }),
  },
  cli: "mailbox list",
});

export const mailboxRead = defineAction({
  id: "mailbox_read",
  consent: "read",
  label: "Read a letter",
  description: "Read one letter and what has happened to it.",
  agent: "Read one letter by id or code: what it asks, its options, its state and every event, such as when it was seen. Read only.",
  when: "Pick this when you hold a letter's id or code and want its state or answer; it only reads.",
  errors: [notFound, daemonDown, unknownInput("mailbox_read"), badInput, noAgent],
  input: { letter: letterId },
  output: {
    outcome: outcome("done, when the letter was read."),
    state,
    letter: field.string({ label: "Letter", description: "The letter as filed, as JSON." }),
    events: field.string({ label: "Events", description: "What has happened to it, one event per line, oldest first: time and what happened." }),
  },
  cli: "mailbox read",
});

export const mailboxWait = defineAction({
  id: "mailbox_wait",
  consent: "read",
  label: "Wait for an answer",
  description: "Wait until a letter is answered or closed.",
  agent: "Block until a letter leaves waiting or the timeout ends, then return its state and a cursor to pass next time. Read only.",
  when: "Pick this only when your caller must block on the answer; otherwise the answer arrives in the session that asked.",
  errors: [notFound, daemonDown, unknownInput("mailbox_wait"), badInput, noAgent],
  input: {
    letter: letterId,
    cursor: field.integer({ label: "Cursor", description: "The cursor the last wait returned; events after it count.", optional: true, min: 0 }),
    timeout: field.integer({ label: "Timeout", description: "Seconds to wait, 1 to 300.", optional: true, min: 1, max: 300, default: 60 }),
  },
  output: {
    outcome: outcome("done when the letter has left waiting or has an event past the cursor, timeout when nothing changed."),
    state,
    cursor: field.integer({ label: "Cursor", description: "How many events the letter has; pass it to the next wait." }),
  },
  cli: "mailbox wait",
});

export const mailboxWithdraw = defineAction({
  id: "mailbox_withdraw",
  consent: "write",
  label: "Withdraw a letter",
  description: "Take back a letter you filed.",
  agent: "Take back a waiting letter this agent filed, with the reason, so the person stops seeing it.",
  when: "Pick this when a letter you filed no longer needs an answer, such as when the question became moot.",
  errors: [
    notFound,
    { code: "not-sender", means: "Another agent filed this letter, and only the agent that filed a letter may withdraw it.", fix: "Leave it, or ask the agent that filed it." },
    { code: "not-waiting", means: "The letter is already answered, withdrawn or expired.", fix: "Read it with mailbox_read; there is nothing to withdraw." },
    daemonDown,
    unknownInput("mailbox_withdraw"),
    badInput,
    noAgent,
  ],
  input: {
    letter: letterId,
    reason: field.string({ label: "Reason", description: "Why it no longer needs an answer, in one line.", maxLength: 200 }),
  },
  output: {
    outcome: outcome("done, when the letter was withdrawn; preview on a dry run, which checks the withdraw and writes nothing."),
    state,
  },
  cli: "mailbox withdraw",
});

export const mailboxDeliver = defineAction({
  id: "mailbox_deliver",
  consent: "write",
  label: "Deliver a letter",
  description: "Send a letter to your chat now.",
  agent: "Ask Ouro to send a waiting letter to the person's own chat now, rendered by Ouro, and record that it was delivered.",
  when: "Pick this when you judge the person should see a waiting letter now; Ouro writes the text and picks the chat.",
  errors: [
    { code: "no-answering-handle", means: "The letter was filed before the person had an answering handle, so Ouro has no chat to send it to.", fix: "Leave the letter waiting; once the person sets a handle with `ouro mailbox handle set`, letters filed after that can be delivered." },
    { code: "not-waiting", means: "The letter is already answered, withdrawn or expired.", fix: "Nothing to deliver; read the letter to see how it closed." },
    { code: "already-delivered", means: "The letter is already in the person's chat; each letter goes there once.", fix: "Wait for the answer with mailbox_wait." },
    { code: "chat-unavailable", means: "This daemon has no chat to send through.", fix: "Leave the letter waiting; the person reads it in their mailbox." },
    { code: "send-failed", means: "The message never reached the chat; the letter stays waiting.", fix: "Deliver it again once the cause the refusal names is fixed." },
    { code: "send-uncertain", means: "The send failed after it may have reached the chat, so Ouro counts the letter as delivered and won't send it twice.", fix: "Wait for the answer with mailbox_wait; the letter is in the person's mailbox either way." },
    { code: "sent-unrecorded", means: "The letter went to the chat, but Ouro couldn't record that.", fix: "Leave it; delivering again would send it twice." },
    notFound,
    daemonDown,
    unknownInput("mailbox_deliver"),
    badInput,
    noAgent,
  ],
  input: { letter: letterId },
  output: {
    outcome: outcome("done, when the letter was sent; preview on a dry run, which shows the text and sends nothing."),
    state,
    channel: field.string({ label: "Channel", description: "The chat the letter went to, such as bluebubbles, when it was sent." }),
    text: field.string({ label: "Text", description: "On a dry run, the letter as the person will read it." }),
  },
  cli: "mailbox deliver",
});

export const mailboxAnswer = defineAction({
  id: "mailbox_answer",
  consent: "person-only",
  label: "Answer a letter",
  description: "Answer a letter by picking one of its options.",
  agent: "The person's own answer to a letter.",
  personOnly: {
    reason: "You can't answer a letter for the person; only they can",
    how: "by replying to the letter in their chat, such as \"L7 2\"",
  },
  input: {
    letter: letterId,
    option: field.string({ label: "Option", description: "The option's number." }),
  },
  output: { outcome: outcome("done, when the answer was recorded.") },
  cli: "mailbox answer",
});

export const tools = { group: "mailbox" };

export default defineActions("mailbox", [mailboxSend, mailboxList, mailboxRead, mailboxWait, mailboxWithdraw, mailboxDeliver, mailboxAnswer], { tool: "ouro" });
