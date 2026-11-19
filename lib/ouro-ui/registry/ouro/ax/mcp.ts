export { createMcpHandler, mcpTools, PROTOCOL_VERSIONS, serveMcp, toolName };
export type { McpCall, McpCallResult, McpOptions, McpTool };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { checkInput, checkOwner, invocation, type Cli, type CommandDef, type Input } from "./command.ts";
import { DRY_RUN_FLAG, WHY_FLAG, WHY_PLACEHOLDER, effectAnnotations } from "./effects.ts";
import { didYouMean, errorJson, errorLine, isAxError, type AxError, type AxErrorShape } from "./problem.ts";
import { commandManifest } from "./help.ts";
import { isOutcome, outcomeText } from "./outcome.ts";
import { truncate } from "./output.ts";
import { isWait, waitText } from "./wait.ts";

/**
 * The same definitions as an MCP server over stdio (newline-delimited JSON-RPC 2.0), with no dependencies: one tool per
 * command, its inputSchema from the definition, calls checked before they run with the fix in the one error shape,
 * effects as tool annotations, and results cut to a size an agent's context can hold.
 * It speaks [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28), the current revision, where every request carries its version in `_meta` and `server/discover` says what the server supports, and it answers the `initialize` handshake of 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 for older clients, which one process serves side by side.
 *
 * @claim "the current revision, where every request carries its version" registry/ouro/ax/mcp.test.mts verify:testExists(registry/ouro/ax/mcp.test.mts::2026-07-28: server/discover names the versions, the capabilities and the server, and the results carry resultType, a cache hint and the server's identity)
 * @claim "with no dependencies" registry/ouro/ax/mcp.test.mts verify:testExists(registry/ouro/ax/mcp.test.mts::initialize, ping and tools/list: one tool per command, schema and effect annotations from the definition)
 */
const PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

const MODERN_VERSION = PROTOCOL_VERSIONS[0];
const LEGACY_VERSIONS = PROTOCOL_VERSIONS.slice(1);
const META = "io.modelcontextprotocol/";
const VERSION_KEY = `${META}protocolVersion`;
const CAPABILITIES_KEY = `${META}clientCapabilities`;
// The command set is fixed for the life of the process, and a stdio server has no shared intermediaries in front of it.
const CACHE = { ttlMs: 3_600_000, cacheScope: "public" } as const;

type McpCallResult = { ok: true; data: unknown; text?: string } | { ok: false; error: AxErrorShape };
/** Runs one command for a tool call; the default runs the definition's run(). */
type McpCall = (cmd: CommandDef, input: Input) => Promise<McpCallResult>;

interface McpOptions {
  cli: Cli;
  version?: string;
  call?: McpCall;
  /** Which commands are tools; by default, the commands that are not hidden. */
  include?: (cmd: CommandDef) => boolean;
  /**
   * The most characters a result's text may have (default 20,000).
   *
   * @claim "The most characters" registry/ouro/ax/mcp.ts verify:fileLine(registry/ouro/ax/mcp.ts, /maxChars \?\? 20_000/)
   */
  maxChars?: number;
  /** Run tool calls side by side; by default one at a time, in the order they came, as an agent would type them. */
  concurrent?: boolean;
}

interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: ReturnType<typeof commandManifest>["inputSchema"];
  annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

/** "draft set" is the tool draft_set; the default command is word-less, so it is the tool itself, named after the tool. */
const toolName = (cli: Pick<Cli, "name" | "defaultCommand">, cmd: CommandDef) => (cmd === cli.defaultCommand ? cli.name : cmd.name.replace(/ /g, "_"));

function toolsOf(options: McpOptions): CommandDef[] {
  const include = options.include ?? ((c: CommandDef) => !c.hidden);
  return options.cli.commands.filter((c) => !c.loose && include(c));
}

function mcpTools(options: McpOptions): McpTool[] {
  const { cli } = options;
  return toolsOf(options).map((cmd) => {
    const m = commandManifest(cli, cmd);
    const who = cmd.effect === "others" ? `${cli.headings.others}: call it only when a human asked you to, with "${WHY_FLAG}" (${WHY_PLACEHOLDER.slice(1, -1)}).` : `${cli.headings.private}${cmd.readOnly ? "; it changes nothing" : ""}.`;
    return {
      name: toolName(cli, cmd),
      title: invocation(cli, cmd),
      description: [cmd.summary, who, m.output ? `Returns ${m.output}` : ""].filter(Boolean).join(" "),
      inputSchema: m.inputSchema,
      annotations: { title: invocation(cli, cmd), ...effectAnnotations(cmd.effect, cmd.readOnly === true) },
    };
  });
}

// A tool call's context: no stdin, and the answer is data.
const callContext = () => ({ stdin: async () => "", json: true });

const defaultCall: McpCall = async (cmd, input) => {
  const ctx = callContext();
  if (input[DRY_RUN_FLAG] === true) {
    if (!cmd.plan) return { ok: false, error: { code: "no-preview", exit: 2, thing: `${cmd.name.replace(/ /g, "_")} ${DRY_RUN_FLAG}`, problem: "this tool has no preview, so nothing was done", fix: null } };
    return { ok: true, data: await cmd.plan(input, ctx) };
  }
  if (!cmd.run) return { ok: false, error: { code: "not-runnable", exit: 1, thing: cmd.name, problem: "this command has no run() in its definition", fix: null } };
  const data = await cmd.run(input, ctx);
  return cmd.text ? { ok: true, data, text: cmd.text(data, input) } : { ok: true, data };
};

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

type Reply = Record<string, unknown>;

/**
 * Handles one JSON-RPC message; null for a notification, which gets no reply. Exposed for tests.
 *
 * @claim "which gets no reply" registry/ouro/ax/mcp.test.mts verify:testExists(registry/ouro/ax/mcp.test.mts::initialize, ping and tools/list: one tool per command, schema and effect annotations from the definition)
 */
function createMcpHandler(options: McpOptions): (message: unknown) => Promise<Reply | null> {
  const { cli } = options;
  const maxChars = options.maxChars ?? 20_000;
  const call = options.call ?? defaultCall;
  const byName = new Map(toolsOf(options).map((c) => [toolName(cli, c), c]));
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    if (options.concurrent) return work();
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };
  const toolError = (shape: AxErrorShape) => ({ content: [{ type: "text", text: errorLine(cli.name, shape) }], structuredContent: errorJson(shape), isError: true });
  const serverInfo = { name: cli.name, version: options.version ?? "0.0.0" };
  const instructions = [...cli.about, `Tools under "${cli.headings.private}" touch only the person's own space; tools under "${cli.headings.others}" reach other people and need "${WHY_FLAG}". Every error has a fix: the arguments to send instead.`].join(" ");
  // A client that opened with initialize is an older one: its later requests carry no _meta.
  let initialized = false;
  const inFlight = new Map<unknown, { cancelled: boolean }>();
  /** Runs one tools/call; null when the client cancelled it before it started. */
  const callTool = async (params: Record<string, unknown>, turn: { cancelled: boolean }): Promise<Record<string, unknown> | null> => {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const cmd = byName.get(name);
    if (!cmd) {
      const near = didYouMean(name, [...byName.keys()]);
      return toolError({ code: "unknown-tool", exit: cli.exits.code("usage"), thing: name || "tools/call", problem: `there is no tool "${name}"`, fix: near ?? [...byName.keys()].join(", ") });
    }
    let input: Input;
    try {
      input = checkInput(cli, cmd, params["arguments"] ?? {});
    } catch (e) {
      // checkInput throws only AxErrors.
      return toolError((e as AxError).shape);
    }
    let result: McpCallResult | null;
    try {
      result = await inTurn(async () => {
        if (turn.cancelled) return null;
        await checkOwner(cli, cmd, input, callContext());
        return call(cmd, input);
      });
    } catch (e) {
      const shape: AxErrorShape = isAxError(e) ? e.shape : { code: "error", exit: cli.exits.code("error"), thing: cmd.name.replace(/ /g, "_"), problem: e instanceof Error ? e.message : String(e), fix: null };
      return toolError(shape);
    }
    if (!result) return null;
    if (!result.ok) return toolError(result.error);
    const data = result.data;
    // An outcome that refused or failed is a tool error an agent repairs from, with the outcome as its data.
    const outcomeError = isOutcome(data) && (data.state === "refused" || data.state === "failed");
    const whole = result.text ?? (isOutcome(data) ? outcomeText(data, cli.name) : isWait(data) ? waitText(data) : JSON.stringify(data));
    const cut = truncate(whole, maxChars, "call again asking for less, such as a smaller limit");
    const structured = !cut.truncated && data !== null && typeof data === "object" && !Array.isArray(data);
    return { content: [{ type: "text", text: cut.text }], ...(structured ? { structuredContent: data } : {}), isError: outcomeError };
  };
  return async (raw) => {
    const msg = (raw && typeof raw === "object" ? raw : {}) as Message;
    const id = msg.id;
    const isRequest = id !== undefined && id !== null;
    const fail = (code: number, message: string, data?: unknown): Reply => ({ jsonrpc: "2.0", id: isRequest ? id : null, error: { code, message, ...(data === undefined ? {} : { data }) } });
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(-32600, "Invalid Request: expected a JSON-RPC 2.0 message with a method.");
    const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
    if (!isRequest) {
      const target = msg.method === "notifications/cancelled" ? inFlight.get(params["requestId"]) : undefined;
      if (target) target.cancelled = true;
      return null;
    }
    const meta = (params["_meta"] && typeof params["_meta"] === "object" ? params["_meta"] : {}) as Record<string, unknown>;
    const asked = meta[VERSION_KEY];
    // With a version in _meta the request is 2026-07-28's and stands alone; without one it is an older client's, after initialize.
    const modern = asked !== undefined;
    const ok = (result: Record<string, unknown>): Reply => ({ jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...result, _meta: { [`${META}serverInfo`]: serverInfo } } : result });
    if (msg.method === "initialize") {
      initialized = true;
      const requested = params["protocolVersion"];
      const protocolVersion = LEGACY_VERSIONS.find((v) => v === requested) ?? LEGACY_VERSIONS[0];
      return { jsonrpc: "2.0", id, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo, instructions } };
    }
    if (msg.method === "ping" && !modern) return ok({});
    if (!modern && (!initialized || msg.method === "server/discover")) {
      return fail(-32602, `Invalid params: send _meta["${VERSION_KEY}"]: "${MODERN_VERSION}" and _meta["${CAPABILITIES_KEY}"]: {} on every request (MCP ${MODERN_VERSION} has no initialize handshake), or open with initialize as an older client does.`);
    }
    if (modern) {
      if (typeof asked !== "string") return fail(-32602, `Invalid params: _meta["${VERSION_KEY}"] must be a version string such as "${MODERN_VERSION}".`);
      if (asked !== MODERN_VERSION) return fail(-32022, `Unsupported protocol version: ${asked}. Send "${MODERN_VERSION}" in _meta; the older versions open with initialize instead.`, { supported: [...PROTOCOL_VERSIONS], requested: asked });
      const capabilities = meta[CAPABILITIES_KEY];
      if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return fail(-32602, `Invalid params: _meta["${CAPABILITIES_KEY}"] must be an object, {} when the client has no capabilities.`);
    }
    const turn = { cancelled: false };
    inFlight.set(id, turn);
    try {
      let reply: Reply;
      switch (msg.method) {
        case "server/discover":
          reply = ok({ supportedVersions: [...PROTOCOL_VERSIONS], capabilities: { tools: {} }, instructions, ...CACHE });
          break;
        case "tools/list":
          if (modern && params["cursor"] !== undefined) return fail(-32602, "Invalid params: tools/list has one page, so it takes no cursor.");
          reply = ok({ tools: mcpTools(options), ...(modern ? CACHE : {}) });
          break;
        case "tools/call": {
          const result = await callTool(params, turn);
          if (!result) return null;
          reply = ok(result);
          break;
        }
        default:
          reply = fail(-32601, `Method not found: ${msg.method}. This server answers server/discover, tools/list and tools/call${modern ? "" : ", and initialize and ping for older clients"}.`);
      }
      return turn.cancelled ? null : reply;
    } finally {
      // A client may reuse the id of a call it cancelled while that call still runs.
      if (inFlight.get(id) === turn) inFlight.delete(id);
    }
  };
}

/** Serves MCP on a byte stream until it ends: one JSON-RPC message per line in, one reply per line out. */
async function serveMcp(options: McpOptions & { input: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>; output: { write(s: string): unknown } }): Promise<void> {
  const handle = createMcpHandler(options);
  const pending = new Set<Promise<void>>();
  const decoder = new TextDecoder();
  let buffer = "";
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      options.output.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: each line must be one JSON-RPC message." } })}\n`);
      return;
    }
    const p = handle(message)
      .then((reply) => {
        if (reply) options.output.write(`${JSON.stringify(reply)}\n`);
      })
      // handle() answers every message itself; this only guards against a bug in it.
      /* node:coverage ignore next 4 */
      .catch((e: unknown) => {
        const id = message && typeof message === "object" ? ((message as Message).id ?? null) : null;
        options.output.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: e instanceof Error ? e.message : String(e) } })}\n`);
      })
      .finally(() => pending.delete(p));
    pending.add(p);
  };
  for await (const chunk of options.input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      dispatch(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  dispatch(buffer + decoder.decode());
  await Promise.all(pending);
}

