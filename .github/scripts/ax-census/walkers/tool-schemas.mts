// The in-turn tool walker (design section 1, "In-turn model tools" and "Approval prompts"): every object literal shaped
// `{ type: "function", function: { name } }` under the source folder, outside tests, is a tool a model can be given,
// wherever it lives. It is the finder and the walker at once, so a tool no registry lists is still counted. Finding is
// syntax only (never a regex over text):
//
// - `type` is the literal "function" (through `as const`, `satisfies` and parentheses) and `function` is an object
//   literal. One with `arguments` is a tool call a model made, not a tool, so it isn't counted.
// - The name is a literal; a same-file `const` holding one; or a parameter of the function the schema sits in (a
//   factory such as `define(name, ...)`), in which case each same-file call of that factory with a literal at that
//   position is a door at the literal. Any other name is an `unwalked` gap at the schema, until it has a literal.
// - A schema inside a configured `passthrough` function (`<file>#<function>`) is excluded as
//   `third-party-passthrough` when the census can prove it: its name isn't a literal and every name it reads is a
//   parameter of that function, so it comes from what a connected server lists. A schema there that fails the proof
//   is unwalked, and a configured function with no such schema is a census error.
//
// Approval prompts are doors of their own, found from code, never from cards: a definition literal with
// `approvalPolicy` (unless the policy is a function that only ever returns `not_required`), a built definition with an
// `approvalPolicy` the literal doesn't show, and each tool name compared with `===` or `!==` in a configured
// `approvals` resolver (`<file>#<function>`), the special cases that decide approval apart from the policy. Each is
// declared by its tool's card.
//
// Cards and effect evidence come from the built modules, as the CLI walker reads its declarations: `ax` on an
// exported definition (`{ tool, handler }`), or an exported `toolCards` list for a bare schema. A static `riskProfile`
// gives `mutates`, a resolver gives `mutates: "depends on arguments"`, and none gives nothing, so a `read` card needs a
// profile that says `mutates: "none"`. A card's error codes count as raised when they're literals outside cards in the
// door's file or a `handlers` file (the dispatcher).
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, DoorCard, Gap, WalkerOptions, WalkResult } from "../types.mts";
import { literalsOutsideCards } from "./literals.mts";

const SKIP_DIRS = new Set(["node_modules", "__tests__", "fixtures"]);
const SOURCE = /\.[cm]?tsx?$/;
const NOT_SOURCE = /\.d\.[cm]?ts$|\.(test|spec)\.[cm]?tsx?$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : sourceFiles(join(dir, e.name))) : SOURCE.test(e.name) && !NOT_SOURCE.test(e.name) ? [join(dir, e.name)] : []));
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e) ? unwrap(e.expression) : e;
const isText = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
const keyOf = (p: ts.ObjectLiteralElementLike): string | null =>
  (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null;
const propOf = (o: ts.ObjectLiteralExpression, key: string): ts.ObjectLiteralElementLike | undefined => o.properties.find((p) => keyOf(p) === key);
const isFn = (n: ts.Node): n is Fn => ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n);
const collapse = (text: string): string => text.replace(/\s+/g, " ").slice(0, 80);

/** The name a function is called by: its declaration's, or the const it's assigned to. */
function fnName(fn: Fn): string | null {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const parent = fn.parent;
  return parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) ? parent.name.text : null;
}

/** A named function in a file: a function declaration, or a const holding an arrow or function expression. */
function findFunction(sf: ts.SourceFile, name: string): Fn | null {
  let found: Fn | null = null;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (isFn(n) && fnName(n) === name && n.body) found = n;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** A string held by a same-file `const <name> = "<literal>"`. */
function constText(sf: ts.SourceFile, name: string): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node): void => {
    if (found !== null) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer && ts.isVariableDeclarationList(n.parent) && (n.parent.flags & ts.NodeFlags.Const) !== 0) {
      const init = unwrap(n.initializer);
      if (isText(init)) found = init.text;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The innermost function around `node` with a plain parameter called `name`, and that parameter's position. */
function factoryOf(node: ts.Node, name: string): { fn: Fn; index: number } | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!isFn(n)) continue;
    const index = n.parameters.findIndex((p) => ts.isIdentifier(p.name) && p.name.text === name);
    if (index >= 0) return { fn: n, index };
  }
  return null;
}

/** The identifiers an expression reads as values (not property names after a dot). */
function readsOf(expr: ts.Node): string[] {
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      if (!(ts.isPropertyAccessExpression(parent) && parent.name === n)) names.push(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return names;
}

/**
 * The names a template makes when its one substitution is the parameter of a callback mapped over a literal list
 * (`(["pause", "resume"] as const).map((action) => define(`shepherd_${action}`))`); null for any other expression.
 */
function expandTemplate(expr: ts.Expression): string[] | null {
  if (!ts.isTemplateExpression(expr) || expr.templateSpans.length !== 1) return null;
  const span = expr.templateSpans[0]!;
  if (!ts.isIdentifier(span.expression)) return null;
  const param = span.expression.text;
  for (let n: ts.Node | undefined = expr.parent; n; n = n.parent) {
    if (!isFn(n)) continue;
    if (!n.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === param)) continue;
    const call = n.parent;
    if (!call || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression) || !["map", "flatMap"].includes(call.expression.name.text)) return null;
    const list = unwrap(call.expression.expression);
    if (!ts.isArrayLiteralExpression(list) || !list.elements.every(isText)) return null;
    return list.elements.map((e) => `${expr.head.text}${(e as ts.StringLiteral).text}${span.literal.text}`);
  }
  return null;
}

/** The definition literal a schema belongs to: the nearest object literal around it with a `tool` or `handler` key. */
function definitionOf(schema: ts.ObjectLiteralExpression): ts.ObjectLiteralExpression | null {
  for (let n: ts.Node = schema.parent; !isFn(n) && !ts.isSourceFile(n); n = n.parent) {
    if (ts.isObjectLiteralExpression(n) && (propOf(n, "tool") || propOf(n, "handler"))) return n;
  }
  return null;
}

/**
 * Whether an `approvalPolicy` property can ask for approval: false only for a function literal whose only kind
 * literal is `not_required`; anything else (a policy that may say `required`, or one the census can't read) can.
 */
function asksForApproval(prop: ts.ObjectLiteralElementLike): boolean {
  if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) return true;
  const value = ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : prop;
  if (!isFn(value)) return true;
  const texts = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (isText(n)) texts.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(value);
  return texts.has("required") || !texts.has("not_required");
}

interface Found {
  name: string;
  file: string;
  line: number;
  /** The line of the `approvalPolicy` that asks, when the definition literal has one. */
  approvalLine?: number;
  /** The definition literal has an `approvalPolicy`, whether or not it asks. */
  policy?: true;
}

interface Spec {
  file: string;
  fn: string;
  spec: string;
}

function parseSpec(spec: string, option: string, errors: string[]): Spec | null {
  const hash = spec.lastIndexOf("#");
  if (hash <= 0 || hash === spec.length - 1) {
    errors.push(`tool-schemas: ${option} ${spec}: give it as <file>#<function>.`);
    return null;
  }
  return { file: spec.slice(0, hash), fn: spec.slice(hash + 1), spec };
}

interface Definition {
  tool?: { function?: { name?: unknown; description?: unknown } };
  type?: unknown;
  function?: { name?: unknown; description?: unknown };
  riskProfile?: unknown;
  approvalPolicy?: unknown;
  ax?: DoorCard;
}

/** What the built module beside a source file exports: definitions and bare schemas by name, and sidecar cards. */
function loadBuilt(root: string, path: string): { byName: Map<string, Definition>; cards: Map<string, DoorCard> } | string {
  if (!existsSync(path)) return `${relative(root, path)} is missing; build the product before the census runs.`;
  const require = createRequire(join(root, "package.json"));
  let loaded: Record<string, unknown>;
  try {
    loaded = require(path) as Record<string, unknown>;
  } catch (error) {
    return `${relative(root, path)} can't be loaded: ${(error as Error).message.split("\n")[0]}`;
  }
  const byName = new Map<string, Definition>();
  const cards = new Map<string, DoorCard>();
  for (const [key, value] of Object.entries(loaded)) {
    const list = Array.isArray(value) ? value : [value];
    if (key === "toolCards") {
      for (const card of list as DoorCard[]) if (typeof card?.id === "string") cards.set(card.id, card);
      continue;
    }
    for (const item of list as Definition[]) {
      const name = item?.tool?.function?.name ?? (item?.type === "function" ? item.function?.name : undefined);
      if (typeof name === "string" && !byName.has(name)) byName.set(name, item);
    }
  }
  return { byName, cards };
}

function mutatesOf(profile: unknown): string | undefined {
  if (typeof profile === "function") return "depends on arguments";
  const mutates = (profile as { mutates?: unknown } | undefined)?.mutates;
  if (typeof mutates === "string") return mutates;
  return Array.isArray(mutates) ? mutates.join(", ") : undefined;
}

export async function walkToolSchemas(opts: WalkerOptions): Promise<WalkResult> {
  const dir = resolve(opts.root, opts.source);
  const errors: string[] = [];
  const unwalked: Gap[] = [];
  const excluded: { hit: string; category: string }[] = [];
  const found: Found[] = [];
  const passthrough = (opts.passthrough ?? []).map((s) => parseSpec(s, "passthrough", errors)).filter((s): s is Spec => s !== null);
  const approvals = (opts.approvals ?? []).map((s) => parseSpec(s, "approvals", errors)).filter((s): s is Spec => s !== null);
  const provedIn = new Set<string>();
  const files = new Map<string, ts.SourceFile>();
  const parse = (path: string): ts.SourceFile => {
    let sf = files.get(path);
    if (!sf) {
      sf = ts.createSourceFile(path, ts.sys.readFile(path) ?? "", ts.ScriptTarget.Latest, true);
      files.set(path, sf);
    }
    return sf;
  };

  for (const path of sourceFiles(dir)) {
    const sf = parse(path);
    const file = relative(opts.root, path);
    const lineOf = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const gap = (at: ts.Node, expr: string, reason: string): void => {
      unwalked.push({ id: `tool:${file}#${collapse(expr)}`, kind: "tool", file, line: lineOf(at), reasons: [reason] });
    };
    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);
      if (!ts.isObjectLiteralExpression(node)) return;
      const type = propOf(node, "type");
      if (!type || !ts.isPropertyAssignment(type) || !isText(unwrap(type.initializer)) || (unwrap(type.initializer) as ts.StringLiteral).text !== "function") return;
      const fnProp = propOf(node, "function");
      if (!fnProp) return;
      if (!ts.isPropertyAssignment(fnProp) || !ts.isObjectLiteralExpression(unwrap(fnProp.initializer))) {
        if (!propOf(node, "id")) gap(node, fnProp.getText(sf), "function: not an object literal the census can read");
        return;
      }
      const fnObj = unwrap(fnProp.initializer) as ts.ObjectLiteralExpression;
      // A tool call a model made carries its arguments; a tool doesn't.
      if (propOf(fnObj, "arguments")) return;
      const nameProp = propOf(fnObj, "name");
      const definition = definitionOf(node);
      const policy = definition && propOf(definition, "approvalPolicy");
      const approvalLine = policy && asksForApproval(policy) ? lineOf(policy) : undefined;
      const add = (name: string, line: number): void => {
        found.push({ name, file, line, ...(approvalLine !== undefined ? { approvalLine } : {}), ...(policy ? { policy: true as const } : {}) });
      };
      if (!nameProp || !(ts.isPropertyAssignment(nameProp) || ts.isShorthandPropertyAssignment(nameProp))) {
        gap(node, "no name", "name: missing");
        return;
      }
      const expr = ts.isPropertyAssignment(nameProp) ? unwrap(nameProp.initializer) : nameProp.name;
      const inPassthrough = passthrough.filter((p) => resolve(opts.root, p.file) === path).find((p) => {
        for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (isFn(n) && fnName(n) === p.fn) return true;
        return false;
      });
      if (isText(expr)) {
        add(expr.text, lineOf(expr));
        return;
      }
      if (inPassthrough) {
        const fn = findFunction(sf, inPassthrough.fn)!;
        const params = new Set(fn.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
        const reads = readsOf(expr);
        if (reads.length > 0 && reads.every((r) => params.has(r))) {
          provedIn.add(inPassthrough.spec);
          excluded.push({ hit: `${file}:${lineOf(node)}`, category: "third-party-passthrough" });
        } else {
          gap(node, expr.getText(sf), `name: in passthrough ${inPassthrough.spec}, but it reads ${reads.filter((r) => !params.has(r)).join(", ") || "no parameter"}, so it isn't only what a connected server lists`);
        }
        return;
      }
      if (ts.isIdentifier(expr)) {
        const factory = factoryOf(node, expr.text);
        if (factory) {
          const called = fnName(factory.fn);
          const calls: ts.CallExpression[] = [];
          const findCalls = (n: ts.Node): void => {
            if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === called) calls.push(n);
            ts.forEachChild(n, findCalls);
          };
          if (called) findCalls(sf);
          if (calls.length === 0) gap(node, expr.text, `name: the parameter ${expr.text} of ${called ?? "an unnamed function"}, which is never called in this file with a literal`);
          for (const call of calls) {
            const arg = call.arguments[factory.index];
            const value = arg && unwrap(arg);
            const expanded = value && expandTemplate(value);
            if (value && isText(value)) add(value.text, lineOf(value));
            else if (expanded) for (const name of expanded) add(name, lineOf(value));
            else gap(call, `${called}(${arg ? arg.getText(sf) : ""})`, `name: ${called} is called with a name that isn't a literal`);
          }
          return;
        }
        const text = constText(sf, expr.text);
        if (text !== null) {
          add(text, lineOf(nameProp));
          return;
        }
      }
      gap(node, expr.getText(sf), "name: not a literal, a const holding one, or a factory parameter called with one");
    };
    visit(sf);
  }

  for (const p of passthrough) {
    const path = resolve(opts.root, p.file);
    if (!existsSync(path) || !findFunction(parse(path), p.fn)) errors.push(`tool-schemas: passthrough ${p.spec} names no function. Fix: remove it from the config.`);
    else if (!provedIn.has(p.spec)) errors.push(`tool-schemas: passthrough ${p.spec} holds no schema built only from its parameters. Fix: remove it from the config.`);
  }

  // One door per name; a name found twice is a census error naming both places.
  const byName = new Map<string, Found>();
  for (const f of found) {
    const first = byName.get(f.name);
    if (first) errors.push(`tool:${f.name}: defined twice, at ${first.file}:${first.line} and ${f.file}:${f.line}`);
    else byName.set(f.name, f);
  }

  const built = new Map<string, ReturnType<typeof loadBuilt>>();
  const builtFor = (file: string) => {
    if (!built.has(file)) {
      const result = loadBuilt(opts.root, resolve(opts.root, join(opts.module, relative(opts.source, file)).replace(/\.[cm]?tsx?$/, ".js")));
      if (typeof result === "string") errors.push(`tool-schemas: ${result}`);
      built.set(file, result);
    }
    return built.get(file)!;
  };
  const handlerLiterals = (opts.handlers ?? []).map((h) => literalsOutsideCards(parse(resolve(opts.root, h))));
  const raised = (file: string, code: string): boolean => literalsOutsideCards(parse(resolve(opts.root, file))).has(code) || handlerLiterals.some((l) => l.has(code));

  const doors: Door[] = [];
  for (const f of byName.values()) {
    const loaded = builtFor(f.file);
    const def = typeof loaded === "string" ? undefined : loaded.byName.get(f.name);
    const card = (def?.ax ?? (typeof loaded === "string" ? undefined : loaded.cards.get(`tool:${f.name}`))) ?? null;
    const mutates = mutatesOf(def?.riskProfile);
    // A built policy the definition literal doesn't show (set by a spread, say) asks until the census can read it.
    const approvalLine = f.approvalLine ?? (!f.policy && typeof def?.approvalPolicy === "function" ? f.line : undefined);
    const text = def?.tool?.function?.description ?? def?.function?.description;
    const description = typeof text === "string" ? text : "";
    doors.push({
      id: `tool:${f.name}`,
      kind: "tool",
      product: opts.product,
      name: f.name,
      description,
      file: f.file,
      line: f.line,
      card,
      evidence: {
        approval: approvalLine !== undefined,
        ...(mutates !== undefined ? { mutates } : {}),
        ...(Array.isArray(card?.errors) ? { raises: card.errors.map((e) => e?.code).filter((code) => typeof code === "string" && raised(f.file, code)) } : {}),
      },
    });
    if (approvalLine !== undefined) {
      doors.push({ id: `approval:${f.name}`, kind: "approval", product: opts.product, name: f.name, description, file: f.file, line: approvalLine, card, evidence: { approval: true }, declaredBy: `tool:${f.name}` });
    }
  }

  for (const a of approvals) {
    const path = resolve(opts.root, a.file);
    const fn = existsSync(path) ? findFunction(parse(path), a.fn) : null;
    if (!fn) {
      errors.push(`tool-schemas: approvals ${a.spec} names no function. Fix: remove it from the config.`);
      continue;
    }
    const sf = parse(path);
    const names = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind)) {
        for (const side of [unwrap(n.left), unwrap(n.right)]) {
          const tool = isText(side) ? byName.get(side.text) : undefined;
          if (tool && !names.has(tool.name)) {
            names.add(tool.name);
            const owner = doors.find((d) => d.id === `tool:${tool.name}`)!;
            doors.push({ id: `approval:${tool.name} via ${a.fn}`, kind: "approval", product: opts.product, name: tool.name, description: owner.description, file: relative(opts.root, path), line: sf.getLineAndCharacterOfPosition(side.getStart(sf)).line + 1, card: owner.card, evidence: { approval: true }, declaredBy: owner.id });
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    if (names.size === 0) errors.push(`tool-schemas: approvals ${a.spec} compares no tool name. Fix: remove it from the config.`);
  }

  return { doors, errors, unwalked, excluded };
}
