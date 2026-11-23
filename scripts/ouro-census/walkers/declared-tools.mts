// The declared-tools walker: the in-turn tools a product's own MCP server serves, carded by the tools.json that declares
// them. tools.json is what Ouro UI core's ouro-actions-tools projection writes (v1.11.0 or later): OpenAI function tools,
// each with its Ouro AX card as `ax`. An agent bundle names it on one of its own servers in agent.json, and the harness
// gives an agent each served tool with the declared card (ourostack/ouroboros docs/bundle-declared-tools.md). The walker
// reads tools.json the way the harness does:
//
// - The doors are what the built server's getToolSchemas() returns, each under the name the agent sees: `<server>_<name>`,
//   or the name as it is when it already starts with `<server>_` or is the server's name. `server` is the name agent.json
//   gives the server under `mcpServers`.
// - A served tool with a whole declaration carries the declared card, under the door's id (the harness gives the card the
//   id the agent sees), with its line in tools.json. A whole declaration is a function tool with a name, a one-line
//   description, object parameters and an `ax` with an effect, a `when` line, a group and `{ code, means, fix }` errors,
//   and a confirm question when it is consequential. The first whole declaration of a name is the one that counts.
// - A served tool with no whole declaration is a door with no card, so the census counts it undeclared. It points at the
//   server module, the first line that names it in quotes: tools.json has no line for it.
// - A whole declaration the server doesn't serve is a census error: the declaration and the server disagree.
// - A tool whose whole declaration says `person-only` is never offered to an agent, so it is no door, served or not.
//
// Read-only evidence is the served `readOnlyHint`: from `listTools()` when the module exports it, else on the schema.
// Approval evidence comes from the code that offers the declared tools to an agent, named in `approvals` as
// `<file>#<function>` (in ourostack/ouroboros, `src/repertoire/mcp-tools.ts#mcpToolsAsDefinitions`). A consequential
// door has it when one of those functions attaches an `approvalPolicy` only under an `<x>.effect === "consequential"`
// check, found in the syntax tree; an approvals function that doesn't is a census error. With no approvals, nothing
// shows that the person is asked, so the census reports a consequential card as weak.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, DoorCard, WalkerOptions, WalkResult } from "../types.mts";

interface Schema {
  name?: unknown;
  description?: unknown;
  annotations?: { readOnlyHint?: unknown };
}

interface Declared {
  description: string;
  card: DoorCard;
  line: number | null;
}

const EFFECTS = new Set(["read", "write", "consequential", "person-only"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLine = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);
const isErrorCard = (e: unknown) => isObject(e) && isLine(e.code) && isLine(e.means) && isLine(e.fix);

/** The entry's name and card when it is a whole declaration, as the harness reads one; null otherwise. */
function wholeDeclaration(entry: unknown): { name: string; description: string; card: DoorCard } | null {
  if (!isObject(entry) || entry.type !== "function" || !isObject(entry.function)) return null;
  const { name, description, parameters } = entry.function;
  const ax = entry.ax;
  if (typeof name !== "string" || name === "" || !isLine(description) || !isObject(parameters) || parameters.type !== "object") return null;
  if (!isObject(ax) || typeof ax.effect !== "string" || !EFFECTS.has(ax.effect) || !isLine(ax.when) || !isLine(ax.group)) return null;
  if (!Array.isArray(ax.errors) || !ax.errors.every(isErrorCard)) return null;
  if (ax.effect === "consequential" && !isLine(ax.confirm)) return null;
  return { name, description, card: ax as unknown as DoorCard };
}

/** Each whole declaration by its served name, or why tools.json can't be read as a declaration. */
function readDeclaration(file: string, text: string): Map<string, Declared> | string {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return `${file}: isn't JSON (${(error as Error).message})`;
  }
  if (!isObject(json) || !Array.isArray(json.tools)) return `${file}: has no tools list`;
  const lines = text.split("\n");
  const declared = new Map<string, Declared>();
  for (const entry of json.tools) {
    const whole = wholeDeclaration(entry);
    if (!whole || declared.has(whole.name)) continue;
    const named = new RegExp(`"name"\\s*:\\s*${JSON.stringify(whole.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
    const at = lines.findIndex((l) => named.test(l));
    declared.set(whole.name, { description: whole.description, card: whole.card, line: at >= 0 ? at + 1 : null });
  }
  return declared;
}

const isConsequentialCheck = (n: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(n)) return isConsequentialCheck(n.expression);
  if (!ts.isBinaryExpression(n)) return false;
  if (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return isConsequentialCheck(n.left) || isConsequentialCheck(n.right);
  if (n.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return false;
  const effect = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === "effect";
  const consequential = (e: ts.Expression) => ts.isStringLiteral(e) && e.text === "consequential";
  return (effect(n.left) && consequential(n.right)) || (consequential(n.left) && effect(n.right));
};

/** Whether the node sets an `approvalPolicy`: a property of that name, or an assignment to one. */
const setsApproval = (node: ts.Node): boolean => {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    const named = (name: ts.Node | undefined) => name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "approvalPolicy";
    if ((ts.isPropertyAssignment(n) || ts.isMethodDeclaration(n) || ts.isShorthandPropertyAssignment(n)) && named(n.name)) found = true;
    else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && named(n.left.name)) found = true;
    else ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
};

/** Whether `spec`'s function attaches an approvalPolicy only under a consequential check, or why it can't be read. */
async function gatesConsequential(root: string, spec: string): Promise<true | string> {
  const hash = spec.lastIndexOf("#");
  if (hash <= 0 || hash === spec.length - 1) return `declared-tools: approvals ${spec}: give it as <file>#<function>.`;
  const path = resolve(root, spec.slice(0, hash));
  const name = spec.slice(hash + 1);
  const sf = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true);
  let fn: ts.FunctionLikeDeclaration | null = null;
  const find = (n: ts.Node): void => {
    if (fn) return;
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === name && n.body) fn = n;
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) fn = n.initializer;
    else ts.forEachChild(n, find);
  };
  find(sf);
  if (!fn) return `declared-tools: approvals ${spec} names no function. Fix: remove it from the config.`;
  // Every approvalPolicy in the function sits in the true branch of a consequential check, and there is at least one.
  let gated = 0;
  let loose = 0;
  const visit = (n: ts.Node, underCheck: boolean): void => {
    if (ts.isConditionalExpression(n) && isConsequentialCheck(n.condition)) {
      visit(n.condition, underCheck);
      visit(n.whenTrue, true);
      visit(n.whenFalse, underCheck);
      return;
    }
    if (ts.isIfStatement(n) && isConsequentialCheck(n.expression)) {
      visit(n.expression, underCheck);
      visit(n.thenStatement, true);
      if (n.elseStatement) visit(n.elseStatement, underCheck);
      return;
    }
    if (setsApproval(n) && !ts.forEachChild(n, (c) => (setsApproval(c) ? true : undefined))) {
      if (underCheck) gated++;
      else loose++;
      return;
    }
    ts.forEachChild(n, (c) => visit(c, underCheck));
  };
  visit((fn as ts.FunctionLikeDeclaration).body!, false);
  if (gated === 0 || loose > 0) return `declared-tools: approvals ${spec} attaches no approvalPolicy under an effect === "consequential" check. Fix: name the function that offers the declared tools, or remove it from the config.`;
  return true;
}

export async function walkDeclaredTools(opts: WalkerOptions): Promise<WalkResult> {
  const sourcePath = resolve(opts.root, opts.source);
  const file = relative(opts.root, sourcePath);
  const server = opts.server;
  if (typeof server !== "string" || server === "") {
    return { doors: [], errors: [`${file}: the declared-tools source needs server, the name agent.json gives the server under mcpServers`] };
  }
  const modulePath = resolve(opts.root, opts.module);
  const moduleFile = relative(opts.root, modulePath);
  const require = createRequire(join(opts.root, "package.json"));
  const loaded = require(modulePath) as { getToolSchemas?: unknown; listTools?: unknown };
  if (typeof loaded.getToolSchemas !== "function") {
    return { doors: [], errors: [`${opts.module}: exports no getToolSchemas function`] };
  }
  const declared = readDeclaration(file, await readFile(sourcePath, "utf8"));
  if (typeof declared === "string") return { doors: [], errors: [declared] };
  const errors: string[] = [];
  let approved = false;
  for (const spec of opts.approvals ?? []) {
    const gate = await gatesConsequential(opts.root, spec);
    if (gate === true) approved = true;
    else errors.push(gate);
  }
  const moduleLines = (await readFile(modulePath, "utf8")).split("\n");
  const servedAt = (name: string): number | null => {
    const at = moduleLines.findIndex((l) => l.includes(JSON.stringify(name)) || l.includes(`'${name}'`));
    return at >= 0 ? at + 1 : null;
  };
  const shown = (name: string) => (name.startsWith(`${server}_`) || name === server ? name : `${server}_${name}`);
  const schemas = (loaded.getToolSchemas as () => Schema[])();
  const listed = new Map((typeof loaded.listTools === "function" ? (loaded.listTools as () => Schema[])() : []).map((t) => [t.name, t]));
  const doors: Door[] = [];
  const served = new Set<string>();
  for (const schema of schemas) {
    if (typeof schema.name !== "string" || schema.name.length === 0) {
      errors.push(`${opts.module}: getToolSchemas returned a tool without a name`);
      continue;
    }
    const name = schema.name;
    if (served.has(name)) {
      errors.push(`${name}: ${opts.module} serves it twice`);
      continue;
    }
    served.add(name);
    const declaration = declared.get(name);
    if (declaration?.card.effect === "person-only") continue;
    const id = `tool:${shown(name)}`;
    doors.push({
      id,
      kind: "tool",
      product: opts.product,
      name: shown(name),
      description: declaration ? declaration.description : typeof schema.description === "string" ? schema.description : "",
      file: declaration ? file : moduleFile,
      line: declaration ? declaration.line : servedAt(name),
      card: declaration ? { ...declaration.card, id } : null,
      evidence: {
        ...((listed.get(name) ?? schema).annotations?.readOnlyHint === true ? { readOnly: true } : {}),
        ...(approved && declaration?.card.effect === "consequential" ? { approval: true } : {}),
      },
    });
  }
  for (const [name, declaration] of declared) {
    if (!served.has(name) && declaration.card.effect !== "person-only") errors.push(`${name}: declared in ${file}, but ${opts.module} doesn't serve it`);
  }
  return { doors, errors };
}
