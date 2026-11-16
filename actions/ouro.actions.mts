// The agent-facing commands of the ouro CLI, declared once. `ouro-actions generate` writes the CLI's definitions, the
// MCP tools and the rest from here into actions/generated; never edit that folder by hand.
import { defineAction, defineActions, field } from "../tools/ouro-actions/ouro-actions.mts";

export const listFriends = defineAction({
  id: "list_friends",
  consent: "read",
  label: "Friends",
  description: "List the friends this agent knows.",
  agent: "List the friends this agent knows, with their ids and trust levels. Read only.",
  input: {},
  output: {
    listing: field.string({ label: "Friends", description: "One friend per line: id, name and trust level." }),
  },
  cli: "friend list",
});

export const listHabits = defineAction({
  id: "list_habits",
  consent: "read",
  label: "Habits",
  description: "List the habits this agent runs on a schedule.",
  agent: "List the agent's habits, with their cadence. Read only.",
  input: {},
  output: {
    listing: field.string({ label: "Habits", description: "One habit per line: name and cadence." }),
  },
  cli: "habit list",
});

export const listSessions = defineAction({
  id: "list_sessions",
  consent: "read",
  label: "Sessions",
  description: "List the agent's sessions.",
  agent: "List the agent's sessions, newest first. Read only.",
  input: {},
  output: {
    listing: field.string({ label: "Sessions", description: "One session per line: id and when it last ran." }),
  },
  cli: "session list",
});

export default defineActions("ouro", [listFriends, listHabits, listSessions], { tool: "ouro" });
