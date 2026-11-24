// The Mailbox's doors, declared once: the letters an agent files for its person and how they are read. `ouro-actions
// generate` writes the CLI's commands, the MCP tools and the rest into actions/generated/mailbox, and
// `ouro-actions-tools generate` writes the in-turn tools into actions/generated/mailbox-tools; never edit those folders
// by hand. The harness dispatches every door from those files (src/heart/letters/doors.ts).
//
// This is its own set, apart from ouro.actions.mts, because the in-turn tools projection turns every action of a set into
// a tool a model is given: the mailbox group is the first group the harness dispatches from its generated files.
import { defineAction, defineActions, field } from "../tools/ouro-actions/ouro-actions.mts";

export const mailboxList = defineAction({
  id: "mailbox_list",
  consent: "read",
  label: "Letters",
  description: "List the letters waiting for you.",
  agent: "List the letters this agent has filed for its person that are still waiting for an answer, oldest first. Read only.",
  when: "Pick this to see which letters still wait for the person's answer before filing another; it only reads.",
  errors: [
    { code: "unknown-input", means: "The call passed an input mailbox_list doesn't take; the text names it.", fix: "Call it again with no input; it takes none." },
  ],
  input: {},
  output: {
    outcome: field.string({ label: "Outcome", description: "done, when the pile was read." }),
    count: field.integer({ label: "Waiting", description: "How many letters wait for an answer." }),
    listing: field.string({ label: "Letters", description: "One waiting letter per line, oldest first: code, state, age and subject; empty when none wait." }),
  },
  cli: "mailbox list",
});

export const tools = { group: "mailbox" };

export default defineActions("mailbox", [mailboxList], { tool: "ouro" });
