import * as fs from "fs";
import * as path from "path";
import { emitNervesEvent } from "../nerves/runtime";
import { getAgentRoot } from "../heart/identity";
import { getRegistryEntries, getRegistryEntriesByTopic, getRegistryEntry } from "../heart/config-registry";
import type { ToolDefinition } from "./tools-base";
import { withCode } from "./tool-error-code";

export const configToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "read_config",
        description: "Read current agent configuration with tier annotations, descriptions, defaults, and effects. Optionally filter by topic to see only related settings.",
        parameters: {
          type: "object",
          properties: {
            related_to: {
              type: "string",
              description: "Optional topic to filter results (e.g., 'model', 'logging', 'senses'). Case-insensitive partial match.",
            },
          },
        },
      },
    },
    handler: (a) => {
      const entries = a.related_to
        ? getRegistryEntriesByTopic(a.related_to)
        : getRegistryEntries();

      const agentRoot = getAgentRoot();
      const configPath = path.join(agentRoot, "agent.json");
      let rawConfig: Record<string, unknown> = {};
      try {
        rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        /* v8 ignore next -- defensive: agent.json read failure in read_config @preserve */
        emitNervesEvent({ component: "repertoire", event: "repertoire.read_config_error", message: "failed to read agent.json", meta: { path: configPath } });
      }

      const result = entries.map((entry) => {
        const parts = entry.path.split(".");
        let current: unknown = rawConfig;
        for (const part of parts) {
          if (current && typeof current === "object" && !Array.isArray(current)) {
            current = (current as Record<string, unknown>)[part];
          } else {
            current = undefined;
            break;
          }
        }
        const isExplicit = current !== undefined;
        let source: "explicit" | "default" | "unset";
        let currentValue: unknown;
        if (isExplicit) {
          source = "explicit";
          currentValue = current;
        } else if (entry.default !== undefined) {
          source = "default";
          currentValue = entry.default;
        } else {
          source = "unset";
          currentValue = null;
        }
        return {
          path: entry.path,
          currentValue,
          source,
          tier: entry.tier,
          description: entry.description,
          default: entry.default !== undefined ? entry.default : null,
          effects: entry.effects,
          topics: entry.topics,
        };
      });

      emitNervesEvent({ component: "repertoire", event: "repertoire.read_config", message: `read_config returned ${result.length} entries`, meta: { count: result.length, topic: a.related_to ?? null } });
      return JSON.stringify({ entries: result }, null, 2);
    },
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:read_config", group: "turn-config", when: "Pick this to see your settings with current values, defaults and effects, optionally by topic, before you change one with update_config.", effect: "read", idempotent: true, errors: [
      { code: "invalid-arguments", means: "related_to isn't text.", fix: "Call read_config again with a topic word such as model or logging, or with no arguments." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "update_config",
        description: "Update an agent configuration value. Managed keys (version, enabled) cannot be modified.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Config key in dot-notation (e.g., 'context.contextMargin', 'logging.level')" },
            value: { type: "string", description: "New value as JSON (e.g., '25', '\"debug\"', '[\"terminal\", \"ndjson\"]')" },
          },
          required: ["path", "value"],
        },
      },
    },
    handler: (a) => {
      const entry = getRegistryEntry(a.path);
      if (!entry) {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_error", message: `unknown config path: ${a.path}`, meta: { path: a.path } });
        return withCode(`Error: unknown config path "${a.path}". Use read_config to see available paths.`, "unknown-config-path");
      }

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(a.value);
      } catch {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_error", message: `invalid JSON value for ${a.path}`, meta: { path: a.path, value: a.value } });
        return withCode(`Error: invalid JSON value. Provide value as valid JSON (e.g., 25, "debug", ["terminal"]).`, "invalid-json");
      }

      // Validate value against registry entry's validator
      /* v8 ignore next -- all current entries have validators; guard kept for future entries without one @preserve */
      if (entry.validate) {
        const validationError = entry.validate(parsedValue);
        if (validationError) {
          emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_error", message: `validation failed for ${a.path}: ${validationError}`, meta: { path: a.path, value: a.value, validationError } });
          return withCode(`Error: validation failed for "${a.path}": ${validationError}`, "invalid-config-value");
        }
      }

      // Managed: refuse
      if (entry.tier === "managed") {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_refused", message: `refused managed change to ${a.path}`, meta: { path: a.path, tier: "managed" } });
        return withCode(`This key is managed by the harness and cannot be modified directly.`, "managed-key");
      }

      const agentRoot = getAgentRoot();
      const configPath = path.join(agentRoot, "agent.json");
      let rawConfig: Record<string, unknown>;
      try {
        rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        /* v8 ignore next -- defensive: agent.json read failure in update_config @preserve */
        return withCode(`Error: failed to read agent.json at ${configPath}`, "config-unreadable");
      }

      // Apply change immediately
      const parts = entry.path.split(".");
      let target: Record<string, unknown> = rawConfig;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in target) || typeof target[parts[i]] !== "object" || target[parts[i]] === null) {
          target[parts[i]] = {};
        }
        target = target[parts[i]] as Record<string, unknown>;
      }
      target[parts[parts.length - 1]] = parsedValue;

      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2) + "\n", "utf-8");
      emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_applied", message: `applied config change to ${a.path}`, meta: { path: a.path, tier: entry.tier, value: parsedValue } });
      return `Success: "${a.path}" updated to ${JSON.stringify(parsedValue)}. Change applied immediately.`;
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "writes agent.json" },
    ax: { id: "tool:update_config", group: "turn-config", when: "Pick this to change one of your own settings in agent.json, taking effect at once; read_config lists the paths and allowed values.", effect: "write", idempotent: true, errors: [
      { code: "unknown-config-path", means: "No setting has that dot path.", fix: "Call read_config and copy a path from its entries." },
      { code: "invalid-json", means: "value isn't valid JSON; a string needs its own quotes.", fix: "Send value as JSON, such as 25, \"debug\" or [\"terminal\"]." },
      { code: "invalid-config-value", means: "The value is valid JSON but not allowed for this setting; the message says why.", fix: "Check the setting's description and default in read_config, then send an allowed value." },
      { code: "managed-key", means: "The harness owns this setting, so it can't be changed here.", fix: "Leave it; ask your owner if it really needs to change." },
      { code: "config-unreadable", means: "agent.json couldn't be read or parsed, so nothing was changed.", fix: "Read agent.json with read_file to see what is wrong, and tell your owner." },
      { code: "orientation-hold", means: "This turn is on a correction hold, so settings changes wait.", fix: "Call orientation_get, settle what the person meant, then change the setting if it is still wanted." },
    ] },
  },
];
