import * as fs from "fs";
import * as path from "path";
import { emitNervesEvent } from "../nerves/runtime";
import { getAgentRoot } from "../heart/identity";
import { getRegistryEntries, getRegistryEntriesByTopic, getRegistryEntry } from "../heart/config-registry";
import type { ToolDefinition } from "./tools-base";

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
  },
  {
    tool: {
      type: "function",
      function: {
        name: "update_config",
        description: "Update a Tier 1 (self-service) agent configuration value immediately. For Tier 2 keys that require operator approval, use propose_config instead. Tier 3 (operator-only) keys are refused.",
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
        return `Error: unknown config path "${a.path}". Use read_config to see available paths.`;
      }

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(a.value);
      } catch {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_error", message: `invalid JSON value for ${a.path}`, meta: { path: a.path, value: a.value } });
        return `Error: invalid JSON value. Provide value as valid JSON (e.g., 25, "debug", ["terminal"]).`;
      }

      // Validate value against registry entry's validator
      /* v8 ignore next -- all current entries have validators; guard kept for future entries without one @preserve */
      if (entry.validate) {
        const validationError = entry.validate(parsedValue);
        if (validationError) {
          emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_error", message: `validation failed for ${a.path}: ${validationError}`, meta: { path: a.path, value: a.value, validationError } });
          return `Error: validation failed for "${a.path}": ${validationError}`;
        }
      }

      // Tier 3: refuse
      if (entry.tier === 3) {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_refused", message: `refused T3 change to ${a.path}`, meta: { path: a.path, tier: 3 } });
        return `Refused: "${a.path}" is an operator-only (Tier 3) key. ${entry.description} Only the operator can change this value directly in agent.json.`;
      }

      // Tier 2: refuse — must use propose_config
      if (entry.tier === 2) {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_refused", message: `refused T2 change to ${a.path} — use propose_config`, meta: { path: a.path, tier: 2 } });
        return `Refused: "${a.path}" is a Tier 2 (proposal) key that requires operator approval. Use propose_config instead of update_config to propose this change.`;
      }

      const agentRoot = getAgentRoot();
      const configPath = path.join(agentRoot, "agent.json");
      let rawConfig: Record<string, unknown>;
      try {
        rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        /* v8 ignore next -- defensive: agent.json read failure in update_config @preserve */
        return `Error: failed to read agent.json at ${configPath}`;
      }

      // Apply T1 change immediately
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
  },
  {
    tool: {
      type: "function",
      function: {
        name: "propose_config",
        description: "Propose a change to a Tier 2 (proposal) agent configuration value. Requires operator approval before the change is applied. For Tier 1 self-service keys, use update_config instead.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Config key in dot-notation (e.g., 'context.maxTokens', 'humanFacing.model')" },
            value: { type: "string", description: "New value as JSON (e.g., '120000', '\"azure\"', '{\"enabled\": true}')" },
          },
          required: ["path", "value"],
        },
      },
    },
    confirmationRequired: true,
    confirmationAlwaysRequired: true,
    handler: (a) => {
      const entry = getRegistryEntry(a.path);
      if (!entry) {
        emitNervesEvent({ component: "repertoire", event: "repertoire.propose_config_error", message: `unknown config path: ${a.path}`, meta: { path: a.path } });
        return `Error: unknown config path "${a.path}". Use read_config to see available paths.`;
      }

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(a.value);
      } catch {
        emitNervesEvent({ component: "repertoire", event: "repertoire.propose_config_error", message: `invalid JSON value for ${a.path}`, meta: { path: a.path, value: a.value } });
        return `Error: invalid JSON value. Provide value as valid JSON (e.g., 120000, "azure", {"enabled": true}).`;
      }

      // Validate value against registry entry's validator
      /* v8 ignore next -- all current entries have validators; guard kept for future entries without one @preserve */
      if (entry.validate) {
        const validationError = entry.validate(parsedValue);
        if (validationError) {
          emitNervesEvent({ component: "repertoire", event: "repertoire.propose_config_error", message: `validation failed for ${a.path}: ${validationError}`, meta: { path: a.path, value: a.value, validationError } });
          return `Error: validation failed for "${a.path}": ${validationError}`;
        }
      }

      // Tier 3: refuse
      if (entry.tier === 3) {
        emitNervesEvent({ component: "repertoire", event: "repertoire.propose_config_refused", message: `refused T3 change to ${a.path}`, meta: { path: a.path, tier: 3 } });
        return `Refused: "${a.path}" is an operator-only (Tier 3) key. ${entry.description} Only the operator can change this value directly in agent.json.`;
      }

      // Tier 1: refuse — use update_config for self-service keys
      if (entry.tier === 1) {
        emitNervesEvent({ component: "repertoire", event: "repertoire.propose_config_refused", message: `refused T1 change to ${a.path} — use update_config`, meta: { path: a.path, tier: 1 } });
        return `Refused: "${a.path}" is a Tier 1 (self-service) key. Use update_config instead — no operator approval needed.`;
      }

      const agentRoot = getAgentRoot();
      const configPath = path.join(agentRoot, "agent.json");
      let rawConfig: Record<string, unknown>;
      try {
        rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        /* v8 ignore next -- defensive: agent.json read failure in propose_config @preserve */
        return `Error: failed to read agent.json at ${configPath}`;
      }

      // Apply T2 change (operator confirmation already obtained via confirmationAlwaysRequired)
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
      emitNervesEvent({ component: "repertoire", event: "repertoire.propose_config_applied", message: `applied approved config change to ${a.path}`, meta: { path: a.path, tier: entry.tier, value: parsedValue } });
      return `Success: "${a.path}" updated to ${JSON.stringify(parsedValue)}. Change approved and applied.`;
    },
  },
];
