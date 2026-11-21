// The in-turn tool walker (design section 1, "In-turn model tools" and "Approval prompts"): every tool schema under the
// source folder, outside tests, is a tool a model can be given, wherever it lives. It is the finder and the walker at
// once, so a tool no registry lists is still counted. Finding is syntax only (never a regex over text):
//
// - A schema is an object literal with `type: "function"` (a literal or a const holding one, through `as const`,
//   `satisfies` and parentheses, or a spread beside a named `function` object) and a `function` object, or the flat
//   shape `{ type: "function", name, parameters }`. One whose `function` has `arguments` is a tool call, not a tool.
// - The name is a literal; a same-file `const` holding one; or a parameter of a factory such as `define(name, ...)`,
//   in which case each call of the factory with a literal, in its file or in a file importing it, is a door at the
//   literal. A factory used as a value (`list.map(define)`) and any other name is an `unwalked` gap, until it has a
//   literal. Every tool a built module exports must match a schema found here, or it is a gap too.
// - A schema in a configured `passthrough` function (`<file>#<function>`) is excluded as `third-party-passthrough` when
//   the census can prove it: its name holds no literal and reads only that function's parameters, the function holds
//   that one schema, and no call passes it a literal. A flat schema in a configured `reshape` function is excluded as
//   `re-encoding` (a counted tool sent in another wire shape) by the same proof over the function's own names. A
//   schema there that fails the proof is unwalked, and a configured function with none is a census error.
//
// Approval prompts are doors of their own, found from code, never from cards: a definition literal with an
// `approvalPolicy` that can ask (anything but a function that calls nothing and only answers `{ kind: "not_required" }`),
// a built definition with an `approvalPolicy` the literal doesn't show, and each tool name a configured `approvals`
// resolver (`<file>#<function>`) checks with `===`, `!==`, a `case` or a list's `has`/`includes`. Those are the
// special cases that decide approval apart from the policy, such as a standing grant that skips the prompt. Each is
// declared by its tool's card.
//
// Cards and effect evidence come from the built modules, as the CLI walker reads its declarations: `ax` on an
// exported definition (`{ tool, handler }`), or an exported `toolCards` list for a bare schema. A static `riskProfile`
// gives `mutates`, a resolver gives `mutates: "depends on arguments"`, and none gives nothing, so a `read` card needs a
// profile that says `mutates: "none"`. A card's error codes count as raised when they're literals outside cards in the
// door's file or a `handlers` file (the dispatcher).
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
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
function keyOf(p: ts.ObjectLiteralElementLike): string | null {
  if (!(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p))) return null;
  if (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) return p.name.text;
  const computed = ts.isComputedPropertyName(p.name) ? unwrap(p.name.expression) : null;
  return computed && isText(computed) ? computed.text : null;
}
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

/** Whether a string literal appears anywhere in an expression (a template's own text doesn't count). */
function holdsLiteral(expr: ts.Node): boolean {
  return isText(expr) || ts.forEachChild(expr, (c) => (holdsLiteral(c) ? true : undefined)) === true;
}

/**
 * Why an expression isn't built only from the parameters of the functions around it (through locals and loop
 * variables built the same way): the name it reads that isn't, with `local` when that name is a local; null when it is.
 */
function impureRead(expr: ts.Node, seen = new Set<ts.Node>()): { name: string; local: boolean } | null {
  if (holdsLiteral(expr)) return { name: "a literal", local: false };
  const ids: ts.Identifier[] = [];
  const collect = (n: ts.Node): void => {
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      const isName = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent) || ts.isBindingElement(parent) || ts.isParameter(parent)) && parent.name === n;
      if (!isName && !(ts.isBindingElement(parent) && parent.propertyName === n)) ids.push(n);
      return;
    }
    ts.forEachChild(n, collect);
  };
  collect(expr);
  for (const id of ids) {
    const decl = declarationOf(id);
    if (!decl) return { name: id.text, local: false };
    if (ts.isParameter(decl) || seen.has(decl)) continue;
    seen.add(decl);
    const loop = decl.parent?.parent;
    const source = loop && ts.isForOfStatement(loop) ? loop.expression : decl.initializer;
    if (!source || impureRead(source, seen)) return { name: id.text, local: true };
  }
  return null;
}

/** The parameter or local variable an identifier reads, from the functions around it; null at module scope. */
function declarationOf(id: ts.Identifier): ts.ParameterDeclaration | ts.VariableDeclaration | null {
  const binds = (b: ts.BindingName): boolean => (ts.isIdentifier(b) ? b.text === id.text : b.elements.some((e) => !ts.isOmittedExpression(e) && binds(e.name)));
  for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
    if (!isFn(n)) continue;
    const param = n.parameters.find((p) => binds(p.name));
    if (param) return param;
    let local: ts.VariableDeclaration | null = null;
    const find = (c: ts.Node): void => {
      if (local || (c !== n && isFn(c))) return;
      if (ts.isVariableDeclaration(c) && binds(c.name)) local = c;
      else ts.forEachChild(c, find);
    };
    if (n.body) find(n.body);
    if (local) return local;
  }
  return null;
}

/** Whether a function can be imported from its file: exported where it's declared, or by an `export { name }`. */
function isExported(fn: Fn, sf: ts.SourceFile, name: string): boolean {
  const exportedHere = (n: ts.Node | undefined): boolean => !!n && ts.canHaveModifiers(n) && !!ts.getModifiers(n)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (exportedHere(fn) || exportedHere(fn.parent?.parent?.parent)) return true;
  return sf.statements.some((st) => ts.isExportDeclaration(st) && !st.moduleSpecifier && !!st.exportClause && ts.isNamedExports(st.exportClause)
    && st.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === name));
}

/** Whether a relative module specifier in `from` names the source file `target`. */
function resolvesTo(from: string, spec: string, target: string): boolean {
  if (!spec.startsWith(".")) return false;
  const base = resolve(dirname(from), spec).replace(/\.[cm]?js$/, "");
  const stem = target.replace(SOURCE, "");
  return base === stem || join(base, "index") === stem;
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
 * Whether an `approvalPolicy` property can ask for approval: false only for a function literal that calls nothing and
 * whose every answer is the plain object `{ kind: "not_required" }`; anything else (a policy that may ask, or one the
 * census can't read through) can.
 */
function asksForApproval(prop: ts.ObjectLiteralElementLike): boolean {
  if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop)) return true;
  const value = ts.isPropertyAssignment(prop) ? unwrap(prop.initializer) : prop;
  if (!isFn(value)) return true;
  const answers: ts.Expression[] = ts.isArrowFunction(value) && !ts.isBlock(value.body) ? [value.body] : [];
  let calls = false;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) calls = true;
    if (ts.isReturnStatement(n) && n.expression) answers.push(n.expression);
    ts.forEachChild(n, visit);
  };
  visit(value);
  const plain = (a: ts.Expression): boolean => {
    const o = unwrap(a);
    if (!ts.isObjectLiteralExpression(o) || o.properties.length !== 1) return false;
    const kind = propOf(o, "kind");
    return !!kind && ts.isPropertyAssignment(kind) && isText(unwrap(kind.initializer)) && (unwrap(kind.initializer) as ts.StringLiteral).text === "not_required";
  };
  return calls || answers.length === 0 || !answers.every(plain);
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

interface Factory {
  fn: Fn;
  index: number;
  sf: ts.SourceFile;
  path: string;
  file: string;
  at: ts.Node;
  param: string;
  approvalLine?: number;
  policy?: true;
}

export async function walkToolSchemas(opts: WalkerOptions): Promise<WalkResult> {
  const dir = resolve(opts.root, opts.source);
  const errors: string[] = [];
  const unwalked: Gap[] = [];
  const excluded: { hit: string; category: string }[] = [];
  const found: Found[] = [];
  const factories: Factory[] = [];
  const passthrough = (opts.passthrough ?? []).map((s) => parseSpec(s, "passthrough", errors)).filter((s): s is Spec => s !== null);
  const approvals = (opts.approvals ?? []).map((s) => parseSpec(s, "approvals", errors)).filter((s): s is Spec => s !== null);
  const reshape = (opts.reshape ?? []).map((s) => parseSpec(s, "reshape", errors)).filter((s): s is Spec => s !== null);
  // The schemas each passthrough or re-encoding function was proved to build, by spec.
  const proved = new Map<string, string[]>();
  const files = new Map<string, ts.SourceFile>();
  const parse = (path: string): ts.SourceFile => {
    let sf = files.get(path);
    if (!sf) {
      sf = ts.createSourceFile(path, ts.sys.readFile(path) ?? "", ts.ScriptTarget.Latest, true);
      files.set(path, sf);
    }
    return sf;
  };
  const lineIn = (sf: ts.SourceFile, n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const gapAt = (file: string, line: number, expr: string, reason: string, approvalLine?: number): void => {
    unwalked.push({ id: `tool:${file}#${collapse(expr)}`, kind: "tool", file, line, reasons: [reason] });
    // A tool the census can't name that asks for approval hides a prompt too.
    if (approvalLine !== undefined) unwalked.push({ id: `approval:${file}#${collapse(expr)}`, kind: "approval", file, line: approvalLine, reasons: [reason] });
  };
  const sources = sourceFiles(dir);
  // Files that look like they hold tools, whose built modules' exports must all match a found schema.
  const candidates = new Set<string>();
  const entryPoints = new Set<string>();
  /** Each file's imports of `fn` from the file at `target`: the local names, and whether each is a namespace. */
  const importsOf = (target: string, fn: string): { path: string; sf: ts.SourceFile; local: string; namespace: boolean }[] =>
    sources.filter((path) => path !== target).flatMap((path) => {
      const sf = parse(path);
      return sf.statements.flatMap((st): { path: string; sf: ts.SourceFile; local: string; namespace: boolean }[] => {
        if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !resolvesTo(path, st.moduleSpecifier.text, target)) return [];
        const named = st.importClause?.namedBindings;
        if (named && ts.isNamespaceImport(named)) return [{ path, sf, local: named.name.text, namespace: true }];
        return named && ts.isNamedImports(named) ? named.elements.filter((el) => (el.propertyName ?? el.name).text === fn).map((el) => ({ path, sf, local: el.name.text, namespace: false })) : [];
      });
    });

  for (const path of sources) {
    const sf = parse(path);
    const file = relative(opts.root, path);
    const lineOf = (n: ts.Node): number => lineIn(sf, n);
    // The type's text; undefined when there's no `type`, null when the census can't read it.
    const typeText = (o: ts.ObjectLiteralExpression): string | null | undefined => {
      const t = propOf(o, "type");
      if (!t) return undefined;
      if (!ts.isPropertyAssignment(t)) return null;
      const v = unwrap(t.initializer);
      return isText(v) ? v.text : ts.isIdentifier(v) ? constText(sf, v.text) : null;
    };
    const enclosing = (node: ts.Node, specs: Spec[]): Spec | undefined =>
      specs.filter((p) => resolve(opts.root, p.file) === path).find((p) => {
        for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (isFn(n) && fnName(n) === p.fn) return true;
        return false;
      });
    const prove = (spec: Spec, node: ts.Node): void => {
      proved.set(spec.spec, [...(proved.get(spec.spec) ?? []), `${file}:${lineOf(node)}`]);
    };
    // A file that reads argv is an entry point: loading its build would run it.
    let entryPoint = false;
    const visit = (node: ts.Node): void => {
      ts.forEachChild(node, visit);
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "argv") entryPoint = true;
      if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && node.typeName.text === "ToolDefinition") candidates.add(file);
      if (!ts.isObjectLiteralExpression(node)) return;
      if (propOf(node, "tool")) candidates.add(file);
      const fnProp = propOf(node, "function");
      const isFunctionType = typeText(node) === "function";
      // The flat shape (Responses and Realtime APIs): `{ type: "function", name, parameters }`.
      if (isFunctionType && !fnProp && propOf(node, "name") && propOf(node, "parameters")) {
        const nameProp = propOf(node, "name")!;
        const expr = ts.isPropertyAssignment(nameProp) ? unwrap(nameProp.initializer) : null;
        if (expr && isText(expr)) {
          found.push({ name: expr.text, file, line: lineOf(expr) });
          return;
        }
        const spec = enclosing(node, reshape);
        const text = expr ? expr.getText(sf) : "name";
        if (!spec) return gapAt(file, lineOf(node), text, "name: a flat schema whose name isn't a literal, outside any configured re-encoding");
        const bad = expr ? impureRead(expr) : { name: "a literal", local: false };
        if (!bad) return prove(spec, node);
        const why = bad.name === "a literal" ? "holds a literal" : bad.local ? `reads ${bad.name}, a local that isn't only the tools it re-encodes` : `reads ${bad.name}`;
        return gapAt(file, lineOf(node), text, `name: in re-encoding ${spec.spec}, but it ${why}, so it isn't only a tool the census already counts`);
      }
      if (!fnProp) return;
      if (file) candidates.add(file);
      const fnLiteral = ts.isPropertyAssignment(fnProp) && ts.isObjectLiteralExpression(unwrap(fnProp.initializer)) ? (unwrap(fnProp.initializer) as ts.ObjectLiteralExpression) : null;
      // A tool call a model made carries its arguments; a tool doesn't.
      if (fnLiteral && propOf(fnLiteral, "arguments")) return;
      if (typeText(node) === null && fnLiteral && propOf(fnLiteral, "name")) {
        return gapAt(file, lineOf(node), `type: ${(propOf(node, "type") as ts.PropertyAssignment).initializer.getText(sf)}`, "type: not a literal the census can read");
      }
      // A spread may carry the type; a `function` object with a name beside a spread is a schema all the same.
      const spreadType = !propOf(node, "type") && node.properties.some(ts.isSpreadAssignment) && !!fnLiteral && !!propOf(fnLiteral, "name");
      if (!isFunctionType && !spreadType) return;
      const definition = definitionOf(node);
      const policy = definition && propOf(definition, "approvalPolicy");
      const approvalLine = policy && asksForApproval(policy) ? lineOf(policy) : undefined;
      const gap = (at: ts.Node, expr: string, reason: string): void => gapAt(file, lineOf(at), expr, reason, approvalLine);
      if (!ts.isPropertyAssignment(fnProp) || !ts.isObjectLiteralExpression(unwrap(fnProp.initializer))) {
        if (!propOf(node, "id")) gap(node, fnProp.getText(sf), "function: not an object literal the census can read");
        return;
      }
      const fnObj = unwrap(fnProp.initializer) as ts.ObjectLiteralExpression;
      // A tool call a model made carries its arguments; a tool doesn't.
      if (propOf(fnObj, "arguments")) return;
      const nameProp = propOf(fnObj, "name");
      const add = (name: string, line: number): void => {
        found.push({ name, file, line, ...(approvalLine !== undefined ? { approvalLine } : {}), ...(policy ? { policy: true as const } : {}) });
      };
      if (!nameProp || !(ts.isPropertyAssignment(nameProp) || ts.isShorthandPropertyAssignment(nameProp))) {
        gap(node, "no name", "name: missing");
        return;
      }
      const expr = ts.isPropertyAssignment(nameProp) ? unwrap(nameProp.initializer) : nameProp.name;
      if (isText(expr)) {
        add(expr.text, lineOf(expr));
        return;
      }
      const inPassthrough = enclosing(node, passthrough);
      if (inPassthrough) {
        const fn = findFunction(sf, inPassthrough.fn)!;
        const params = new Set(fn.parameters.flatMap((p) => (ts.isIdentifier(p.name) ? [p.name.text] : [])));
        const reads = readsOf(expr);
        const outside = reads.filter((r) => !params.has(r));
        if (holdsLiteral(expr)) gap(node, expr.getText(sf), `name: in passthrough ${inPassthrough.spec}, but it holds a literal, so it isn't only what a connected server lists`);
        else if (reads.length > 0 && outside.length === 0) prove(inPassthrough, node);
        else gap(node, expr.getText(sf), `name: in passthrough ${inPassthrough.spec}, but it reads ${outside.join(", ") || "no parameter"}, so it isn't only what a connected server lists`);
        return;
      }
      if (ts.isIdentifier(expr)) {
        const factory = factoryOf(node, expr.text);
        if (factory) {
          factories.push({ ...factory, sf, path, file, at: node, param: expr.text, ...(approvalLine !== undefined ? { approvalLine } : {}), ...(policy ? { policy: true as const } : {}) });
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
    if (entryPoint) entryPoints.add(file);
  }

  // A factory's doors are its calls with a literal name, in its own file and in each file that imports it; a use of
  // the factory as a value (`list.map(define)`) hides the names it gets.
  for (const f of factories) {
    const called = fnName(f.fn);
    const extra = { ...(f.approvalLine !== undefined ? { approvalLine: f.approvalLine } : {}), ...(f.policy ? { policy: true as const } : {}) };
    if (!called) {
      gapAt(f.file, lineIn(f.sf, f.at), f.param, `name: the parameter ${f.param} of an unnamed function, which is never called with a literal`, f.approvalLine);
      continue;
    }
    const sites: { sf: ts.SourceFile; file: string; local: string; namespace: boolean }[] = [{ sf: f.sf, file: f.file, local: called, namespace: false }];
    if (isExported(f.fn, f.sf, called)) {
      sites.push(...importsOf(f.path, called).map((i) => ({ ...i, file: relative(opts.root, i.path) })));
      // A re-export hands the factory on under a module the census doesn't follow.
      for (const path of sources) {
        const sf = parse(path);
        for (const st of sf.statements) {
          if (!ts.isExportDeclaration(st) || !st.moduleSpecifier || !ts.isStringLiteral(st.moduleSpecifier) || !resolvesTo(path, st.moduleSpecifier.text, f.path)) continue;
          if (st.exportClause && ts.isNamedExports(st.exportClause) && !st.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === called)) continue;
          gapAt(relative(opts.root, path), lineIn(sf, st), called, `name: the factory ${called} is re-exported here, and the census follows only direct imports`, f.approvalLine);
        }
      }
    }
    let calls = 0;
    for (const site of sites) {
      const visit = (node: ts.Node): void => {
        ts.forEachChild(node, visit);
        // Through a namespace import the factory is `ns.define`; otherwise it's the identifier itself.
        const n = site.namespace
          ? ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === site.local && node.name.text === called ? node : null
          : ts.isIdentifier(node) && node.text === site.local ? node : null;
        if (!n) return;
        const parent = n.parent;
        if (ts.isCallExpression(parent) && parent.expression === n) {
          calls += 1;
          const arg = parent.arguments[f.index];
          const value = arg && unwrap(arg);
          const expanded = value && expandTemplate(value);
          const line = lineIn(site.sf, value ?? parent);
          if (value && isText(value)) found.push({ name: value.text, file: site.file, line, ...extra });
          else if (expanded) for (const name of expanded) found.push({ name, file: site.file, line, ...extra });
          else gapAt(site.file, lineIn(site.sf, parent), `${called}(${arg ? arg.getText(site.sf) : ""})`, `name: ${called} is called with a name that isn't a literal`, f.approvalLine);
          return;
        }
        const declares = (ts.isFunctionDeclaration(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === n;
        const named = (ts.isPropertyAccessExpression(parent) || ts.isPropertyAssignment(parent)) && parent.name === n;
        if (declares || named || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return;
        gapAt(site.file, lineIn(site.sf, n), called, `name: the factory ${called} is passed as a value, so the census can't see the names it is called with`, f.approvalLine);
      };
      visit(site.sf);
    }
    if (calls === 0) gapAt(f.file, lineIn(f.sf, f.at), f.param, `name: the parameter ${f.param} of ${called}, which is never called in this file with a literal`, f.approvalLine);
  }

  // A passthrough called with a literal can make any name; a function holding two schemas is not one forwarder.
  // Its calls are found under its own name, an import alias, or a namespace; each argument must be built only from
  // the caller's parameters.
  for (const p of passthrough) {
    const target = resolve(opts.root, p.file);
    const aliases = new Map<string, Set<string>>();
    for (const i of importsOf(target, p.fn)) if (!i.namespace) aliases.set(i.path, new Set([...(aliases.get(i.path) ?? []), i.local]));
    for (const path of sources) {
      const sf = parse(path);
      const names = new Set([p.fn, ...(aliases.get(path) ?? [])]);
      const visit = (n: ts.Node): void => {
        ts.forEachChild(n, visit);
        if (!ts.isCallExpression(n)) return;
        const callee = ts.isIdentifier(n.expression) ? names.has(n.expression.text) : ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === p.fn;
        if (!callee) return;
        const why = n.arguments.some(holdsLiteral) ? "a literal" : n.arguments.some((a) => impureRead(a)) ? "what isn't only the caller's parameters" : null;
        if (why) gapAt(relative(opts.root, path), lineIn(sf, n), n.getText(sf), `name: passthrough ${p.spec} is called here with ${why}, so its name may not come from a connected server`);
      };
      visit(sf);
    }
  }
  for (const [option, specs, category, what] of [["passthrough", passthrough, "third-party-passthrough", "schema built only from its parameters"], ["reshape", reshape, "re-encoding", "flat schema built only from its own names"]] as const) {
    for (const p of specs) {
      const path = resolve(opts.root, p.file);
      const hits = proved.get(p.spec) ?? [];
      if (!existsSync(path) || !findFunction(parse(path), p.fn)) errors.push(`tool-schemas: ${option} ${p.spec} names no function. Fix: remove it from the config.`);
      else if (hits.length === 0) errors.push(`tool-schemas: ${option} ${p.spec} holds no ${what}. Fix: remove it from the config.`);
      else if (hits.length > 1) errors.push(`tool-schemas: ${option} ${p.spec} holds ${hits.length} schemas; a ${option} function builds one. Fix: split it, or count the others.`);
      else excluded.push({ hit: hits[0]!, category });
    }
  }

  // One door per name; a name found twice is a census error naming both places.
  const byPlace = (a: { file: string; line: number | null }, b: { file: string; line: number | null }): number => (a.file === b.file ? (a.line ?? 0) - (b.line ?? 0) : a.file < b.file ? -1 : 1);
  const byName = new Map<string, Found>();
  for (const f of [...found].sort(byPlace)) {
    const first = byName.get(f.name);
    if (first) errors.push(`tool:${f.name}: defined twice, at ${first.file}:${first.line} and ${f.file}:${f.line}`);
    else byName.set(f.name, f);
  }

  const built = new Map<string, ReturnType<typeof loadBuilt>>();
  const builtFor = (file: string) => {
    if (!built.has(file)) {
      const out = join(opts.module, relative(opts.source, file)).replace(/\.([cm]?)tsx?$/, (_, m: string) => `.${m}js`);
      const result = loadBuilt(opts.root, resolve(opts.root, out));
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

  // Every tool a built module exports must have a schema the census found, so a name built some other way still shows.
  for (const file of candidates) if (!entryPoints.has(file)) builtFor(file);
  for (const [file, loaded] of built) {
    if (typeof loaded === "string") continue;
    for (const name of loaded.byName.keys()) {
      if (!byName.has(name)) gapAt(file, 1, name, `name: the built module exports ${name}, but the census found no schema for it in the source`);
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
    const consider = (node: ts.Expression): void => {
      const side = unwrap(node);
      const tool = isText(side) ? byName.get(side.text) : undefined;
      if (!tool || names.has(tool.name)) return;
      names.add(tool.name);
      const owner = doors.find((d) => d.id === `tool:${tool.name}`)!;
      // The resolver gates this tool, so the tool asks for approval whatever its own policy says.
      owner.evidence = { ...owner.evidence, approval: true };
      doors.push({ id: `approval:${tool.name} via ${a.fn}`, kind: "approval", product: opts.product, name: tool.name, description: owner.description, file: relative(opts.root, path), line: lineIn(sf, side), card: owner.card, evidence: { approval: true }, declaredBy: owner.id });
    };
    // A list the resolver checks the name against: an array literal, or a same-file const holding one or a Set of one.
    const param = fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : null;
    const unreadable = (verb: string, what: ts.Node): void => {
      errors.push(`tool-schemas: approvals ${a.spec} ${verb} ${what.getText(sf)}, which the census can't read. Fix: check it against a literal list in the same file.`);
    };
    const listOf = (e: ts.Expression): readonly ts.Expression[] | null => {
      const v = unwrap(e);
      if (ts.isArrayLiteralExpression(v)) return v.elements;
      if (ts.isNewExpression(v) && v.arguments?.[0]) return listOf(v.arguments[0]);
      if (!ts.isIdentifier(v)) return null;
      let init: ts.Expression | undefined;
      const find = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === v.text && n.initializer) init = n.initializer;
        else ts.forEachChild(n, find);
      };
      find(sf);
      return init && !ts.isIdentifier(unwrap(init)) ? listOf(init) : null;
    };
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(n.operatorToken.kind)) {
        consider(n.left);
        consider(n.right);
      }
      if (ts.isCaseClause(n)) consider(n.expression);
      const isName = (x: ts.Expression | undefined): boolean => !!x && ts.isIdentifier(unwrap(x)) && (unwrap(x) as ts.Identifier).text === param;
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ["has", "includes"].includes(n.expression.name.text)) {
        const list = listOf(n.expression.expression);
        if (list) for (const item of list) consider(item);
        else if (isName(n.arguments[0])) unreadable("checks the name against", n.expression.expression);
      }
      if (ts.isElementAccessExpression(n) && isName(n.argumentExpression)) unreadable("looks the name up in", n.expression);
      ts.forEachChild(n, visit);
    };
    visit(fn);
    if (names.size === 0) errors.push(`tool-schemas: approvals ${a.spec} compares no tool name. Fix: remove it from the config.`);
  }

  // A schema the census reaches more than once (a factory found from two of its schemas) is one gap.
  const gaps = [...new Map(unwalked.map((g) => [g.id, g])).values()].sort(byPlace);
  return { doors, errors, unwalked: gaps, excluded };
}
