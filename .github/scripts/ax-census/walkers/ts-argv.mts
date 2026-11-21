// What a hand-written TypeScript argv parser compares its words with, read from the syntax tree (never a regex over
// text). Shared by the ts-parser walker and the argv entry-point finder.
//
// An argv array is a parser's `args` parameter, `x.slice(n)` or `x.filter(...)` of one, a `...rest` element
// destructured from one, or anything a call makes from one (`const { rest } = extractAgentFlag(args)`). An argv word
// is an element of one: `args[1]`, `const [head, second] = args`, `const sub = rest[0]`, a parameter a word is passed
// to, or a callback's or loop's token, whose position is unknown. A word compared with a string literal (`===`,
// `switch`, `[...].includes(word)`, `SET.has(word)`, `Object.hasOwn(TABLE, word)`, `word in TABLE`) gives a candidate
// word at its position. Literals starting with `-` are flags: never words, kept to build test argv. Calls that pass an
// argv array or word to a function the source set can resolve (same file, or a relative import) are followed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

export type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;
type Binding = { arr: number } | { word: number | null };

/** A string literal a word is compared with. `pos` is the word's argv position, null when unknown. */
export interface Comparison {
  text: string;
  pos: number | null;
  file: string;
  line: number;
  /** Where in the file it sits, to test against a region. */
  at: number;
  /** The branch it guards (the `if`, `case` or `?:` whose condition holds it), or null for the whole function. */
  region: Region | null;
  /** The comparisons joined by `||` (or listed in one `includes`) share a group. */
  group: string;
  /** Its region is one several words share (below an `a !== x && a !== y` guard), so its kinds aren't this word's alone. */
  shared?: true;
}

export type Region = readonly [number, number];

/** One function read with given argv bindings for its parameters. */
export interface Context {
  key: string;
  file: string;
  comparisons: Comparison[];
  calls: { context: Context; at: number }[];
  flags: Set<string>;
  /** `kind: "<literal>"` properties of object literals, where they sit. */
  kinds: { kind: string; at: number }[];
}

const unwrap = (e: ts.Expression): ts.Expression =>
  ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) ? unwrap(e.expression) : e;
const isText = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
const NEGATED = new Set([ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const EQUALITY = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);
const CALLBACKS = new Set(["filter", "find", "findIndex", "some", "every", "map", "forEach", "flatMap"]);

export class Sources {
  private readonly files = new Map<string, ts.SourceFile>();
  private readonly contexts = new Map<string, Context>();
  private readonly stack = new Set<ts.Node>();

  file(path: string): ts.SourceFile {
    let sf = this.files.get(path);
    if (!sf) {
      sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      this.files.set(path, sf);
    }
    return sf;
  }

  /** A top-level function declaration, or a const holding an arrow or function expression. */
  functionIn(path: string, name: string): Fn | null {
    for (const s of this.file(path).statements) {
      if (ts.isFunctionDeclaration(s) && s.name?.text === name && s.body) return s;
      if (!ts.isVariableStatement(s)) continue;
      for (const d of s.declarationList.declarations) {
        const init = d.initializer && unwrap(d.initializer);
        if (ts.isIdentifier(d.name) && d.name.text === name && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init;
      }
    }
    return null;
  }

  /** The file a relative import names, or null for a package or a file that isn't TypeScript source. */
  module(from: string, specifier: string): string | null {
    if (!specifier.startsWith(".")) return null;
    const base = resolve(dirname(from), specifier.replace(/\.[cm]?js$/, ""));
    return [`${base}.ts`, `${base}.mts`, `${base}.cts`, join(base, "index.ts")].find((c) => existsSync(c)) ?? null;
  }

  /** The declaration `name` refers to in `path`: the file's own, or one a named import brings in. */
  imported<T>(path: string, name: string, find: (file: string, name: string) => T | null): { file: string; found: T } | null {
    const own = find(path, name);
    if (own) return { file: path, found: own };
    for (const s of this.file(path).statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      const bindings = s.importClause?.namedBindings;
      const element = bindings && ts.isNamedImports(bindings) ? bindings.elements.find((e) => e.name.text === name) : undefined;
      if (!element) continue;
      const target = this.module(path, s.moduleSpecifier.text);
      return target ? this.imported(target, (element.propertyName ?? element.name).text, find) : null;
    }
    return null;
  }

  /** Every relative import of `path`, resolved. */
  importsOf(path: string): string[] {
    const out: string[] = [];
    for (const s of this.file(path).statements) {
      const spec = (ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? s.moduleSpecifier.text : null;
      const target = spec === null ? null : this.module(path, spec);
      if (target) out.push(target);
    }
    return out;
  }

  /**
   * Read `body` (a function, or a whole module for an entry point) with the given parameter bindings. `argv` binds
   * `process.argv` as an argv array at that offset (an entry point's words start at `process.argv[2]`, offset -2).
   */
  read(file: string, body: Fn | ts.SourceFile, params: readonly (Binding | null)[], argv?: number): Context {
    const key = `${file}#${body.pos}#${JSON.stringify(params)}#${argv}`;
    const known = this.contexts.get(key);
    if (known) return known;
    const sf = this.file(file);
    const context: Context = { key, file, comparisons: [], calls: [], flags: new Set(), kinds: [] };
    this.contexts.set(key, context);
    const env = new Map<string, Binding>();
    const bindPattern = (pattern: ts.ArrayBindingPattern, offset: number) => {
      pattern.elements.forEach((el, i) => {
        if (!ts.isOmittedExpression(el) && ts.isIdentifier(el.name)) env.set(el.name.text, el.dotDotDotToken ? { arr: offset + i } : { word: offset + i });
      });
    };
    const bind = (name: ts.BindingName, init: ts.Expression) => {
      if (ts.isIdentifier(name)) {
        const word = wordOf(init);
        const arr = word ? null : arrayOf(init);
        if (word) env.set(name.text, { word: word.pos });
        else if (arr !== null) env.set(name.text, { arr });
        return;
      }
      const arr = arrayOf(init);
      if (arr === null) return;
      if (ts.isArrayBindingPattern(name)) bindPattern(name, arr);
      else for (const el of name.elements) if (ts.isIdentifier(el.name)) env.set(el.name.text, { arr });
    };
    if (!ts.isSourceFile(body)) {
      body.parameters.forEach((p, i) => {
        const b = params[i];
        if (!b) return;
        if (ts.isIdentifier(p.name)) env.set(p.name.text, b);
        else if (ts.isArrayBindingPattern(p.name) && "arr" in b) bindPattern(p.name, b.arr);
      });
    }

    function arrayOf(expr: ts.Expression): number | null {
      const e = unwrap(expr);
      if (ts.isIdentifier(e)) {
        const b = env.get(e.text);
        return b && "arr" in b ? b.arr : null;
      }
      if (ts.isPropertyAccessExpression(e)) {
        if (argv !== undefined && ts.isIdentifier(e.expression) && e.expression.text === "process" && e.name.text === "argv") return argv;
        return arrayOf(e.expression);
      }
      if (ts.isCallExpression(e)) {
        if (ts.isPropertyAccessExpression(e.expression)) {
          const base = arrayOf(e.expression.expression);
          const method = e.expression.name.text;
          if (base !== null && method === "slice") {
            const n = e.arguments[0];
            return n && ts.isNumericLiteral(n) ? base + Number(n.text) : n ? null : base;
          }
          if (base !== null && method === "filter") return base;
        }
        for (const a of e.arguments) {
          const arr = arrayOf(a);
          if (arr !== null) return arr;
        }
        return null;
      }
      if (ts.isArrayLiteralExpression(e)) {
        const first = e.elements[0];
        return first && ts.isSpreadElement(first) ? arrayOf(first.expression) : null;
      }
      return null;
    }

    function wordOf(expr: ts.Expression): { pos: number | null } | null {
      const e = unwrap(expr);
      if (ts.isIdentifier(e)) {
        const b = env.get(e.text);
        return b && "word" in b ? { pos: b.word } : null;
      }
      if (ts.isElementAccessExpression(e)) {
        const base = arrayOf(e.expression);
        if (base === null) return null;
        return { pos: ts.isNumericLiteral(e.argumentExpression) ? base + Number(e.argumentExpression.text) : null };
      }
      if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "find" && arrayOf(e.expression.expression) !== null) return { pos: null };
      return null;
    }

    const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
    const regionOf = (n: ts.Node): Region | null => {
      for (let p: ts.Node = n; p.parent && p !== body; p = p.parent) {
        const parent = p.parent;
        if (ts.isIfStatement(parent) && parent.expression === p) return [parent.pos, parent.end];
        if (ts.isConditionalExpression(parent) && parent.condition === p) return [parent.pos, parent.end];
        if (ts.isCaseClause(parent)) return [parent.pos, parent.end];
      }
      return null;
    };
    const exits = (st: ts.Statement): boolean => {
      const last = ts.isBlock(st) ? st.statements.at(-1) : st;
      return !!last && (ts.isThrowStatement(last) || ts.isReturnStatement(last) || ts.isContinueStatement(last) || ts.isBreakStatement(last));
    };
    /**
     * A guard `if (w !== "a" && w !== "b") throw ...` leaves the words' own path below it, to the end of the block the
     * `if` sits in. That holds only when the condition is nothing but `!==` checks of that one word and the `if` exits;
     * anything else (another conjunct, a `||`, a branch that falls through) keeps the comparison's own branch.
     */
    const afterGuard = (n: ts.BinaryExpression, word: ts.Expression): { region: Region | null; shared?: true } => {
      const own = { region: regionOf(n) };
      let top: ts.Node = n;
      while (top.parent && (ts.isParenthesizedExpression(top.parent) || (ts.isBinaryExpression(top.parent) && top.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken))) top = top.parent;
      const guard = top.parent;
      if (!guard || !ts.isIfStatement(guard) || guard.expression !== top || guard.elseStatement || !exits(guard.thenStatement)) return own;
      const leaves: ts.Expression[] = [];
      const collect = (e: ts.Expression): void => {
        const u = ts.isParenthesizedExpression(e) ? e.expression : e;
        if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return void (collect(u.left), collect(u.right));
        leaves.push(u);
      };
      collect(guard.expression);
      const text = word.getText(sf);
      const sameWord = (e: ts.Expression) => ts.isBinaryExpression(e) && NEGATED.has(e.operatorToken.kind) && (e.left.getText(sf) === text || e.right.getText(sf) === text);
      if (!leaves.every(sameWord)) return own;
      return leaves.length > 1 ? { region: [guard.end, guard.parent.end], shared: true } : { region: [guard.end, guard.parent.end] };
    };
    const groupOf = (n: ts.Node): string => {
      let top = n;
      while (ts.isBinaryExpression(top.parent) && top.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken) top = top.parent;
      return `${file}:${top.pos}`;
    };
    const record = (literal: ts.Node & { text: string }, pos: number | null, at: ts.Node, region: Region | null = regionOf(at), text = literal.text, shared?: true) => {
      if (text.startsWith("-")) return void context.flags.add(text);
      context.comparisons.push({ text, pos, file, line: lineOf(literal), at: at.pos, region, group: groupOf(at), ...(shared ? { shared } : {}) });
    };
    /** A word's comparand: a string literal, or a `const` in this file that holds one (reported at the comparison). */
    const compared = (expr: ts.Expression, at: ts.Node, pos: number | null, region: Region | null = regionOf(at), shared?: true): void => {
      const lit = unwrap(expr);
      if (isText(lit)) return record(lit, pos, at, region, lit.text, shared);
      if (!ts.isIdentifier(lit)) return;
      let value: string | undefined;
      const look = (n: ts.Node): void => {
        if (value === undefined && ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === lit.text && n.initializer && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) {
          const init = unwrap(n.initializer);
          if (isText(init)) value = init.text;
        }
        ts.forEachChild(n, look);
      };
      look(sf);
      if (value !== undefined) record(lit, pos, at, region, value, shared);
    };
    /** The literals a table holds: an array or `new Set([...])`'s strings, or an object literal's keys. */
    const tableOf = (expr: ts.Expression): (ts.Node & { text: string })[] | null => {
      const e = unwrap(expr);
      if (ts.isIdentifier(e)) {
        let init: ts.Expression | undefined;
        const look = (n: ts.Node): void => {
          if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === e.text && n.initializer) init ??= n.initializer;
          ts.forEachChild(n, look);
        };
        look(sf);
        return init ? tableOf(init) : null;
      }
      if (ts.isArrayLiteralExpression(e)) return e.elements.filter(isText);
      if (ts.isNewExpression(e)) return e.arguments?.[0] ? tableOf(e.arguments[0]) : null;
      if (ts.isObjectLiteralExpression(e)) {
        return e.properties.map((p) => p.name).filter((n): n is ts.Identifier | ts.StringLiteral => !!n && (ts.isIdentifier(n) || ts.isStringLiteral(n)));
      }
      return null;
    };
    const lookup = (table: ts.Expression, word: ts.Expression, at: ts.Node) => {
      const w = wordOf(word);
      const keys = w && tableOf(table);
      if (w && keys) for (const k of keys) record(k, w.pos, at);
    };
    const kindsOf = (e: ts.Expression): string[] => {
      const u = unwrap(e);
      return isText(u) ? [u.text] : ts.isConditionalExpression(u) ? [...kindsOf(u.whenTrue), ...kindsOf(u.whenFalse)] : [];
    };

    const visit = (n: ts.Node): void => {
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n !== body) {
        // A callback over an argv array gets its tokens, at unknown positions.
        const call = n.parent;
        const p = n.parameters[0];
        if (ts.isCallExpression(call) && ts.isPropertyAccessExpression(call.expression) && CALLBACKS.has(call.expression.name.text) && arrayOf(call.expression.expression) !== null && p && ts.isIdentifier(p.name)) {
          env.set(p.name.text, { word: null });
        }
      }
      if (ts.isVariableDeclaration(n) && n.initializer) bind(n.name, n.initializer);
      if (ts.isForOfStatement(n) && ts.isVariableDeclarationList(n.initializer) && arrayOf(n.expression) !== null) {
        const d = n.initializer.declarations[0];
        if (d && ts.isIdentifier(d.name)) env.set(d.name.text, { word: null });
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) bind(n.left, n.right);
      if (ts.isBinaryExpression(n) && EQUALITY.has(n.operatorToken.kind)) {
        for (const [a, b] of [[n.left, n.right], [n.right, n.left]] as const) {
          const w = wordOf(a);
          if (!w) continue;
          const at = NEGATED.has(n.operatorToken.kind) ? afterGuard(n, a) : { region: regionOf(n) };
          compared(b, n, w.pos, at.region, at.shared);
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InKeyword) lookup(n.right, n.left, n);
      if (ts.isSwitchStatement(n)) {
        const w = wordOf(n.expression);
        for (const clause of n.caseBlock.clauses) {
          if (w && ts.isCaseClause(clause)) compared(clause.expression, clause.expression, w.pos, [clause.pos, clause.end]);
        }
      }
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const [first, second] = n.arguments;
        if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          if ((method === "includes" || method === "has") && first) lookup(callee.expression, first, n);
          if (method === "hasOwn" && first && second) lookup(first, second, n);
        } else if (ts.isIdentifier(callee)) {
          const bindings: (Binding | null)[] = n.arguments.map((a) => {
            const w = wordOf(a);
            if (w) return { word: w.pos };
            const arr = arrayOf(a);
            return arr === null ? null : { arr };
          });
          const target = bindings.some((b) => b) ? this.imported(file, callee.text, (f, name) => this.functionIn(f, name)) : null;
          if (target && !this.stack.has(target.found)) context.calls.push({ context: this.read(target.file, target.found, bindings), at: n.pos });
        }
      }
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === "kind" && ts.isObjectLiteralExpression(n.parent)) {
        for (const kind of kindsOf(n.initializer)) context.kinds.push({ kind, at: n.pos });
      }
      if (isText(n) && n.text.startsWith("-")) context.flags.add(n.text);
      ts.forEachChild(n, visit);
    };
    this.stack.add(body);
    if (ts.isSourceFile(body)) body.statements.forEach(visit);
    else if (body.body) visit(body.body);
    this.stack.delete(body);
    return context;
  }
}

/** A place a word path's next word may be compared: a context, narrowed to a branch or whole. */
export interface Scope {
  context: Context;
  region: Region | null;
  /** Narrowed to a region several words share, so the kinds in it may be a sibling's. */
  shared?: true;
}

export const inside = (region: Region | null, at: number): boolean => !region || (at >= region[0] && at < region[1]);

/** The scopes plus every context their regions call into, whole, transitively. */
export function expand(scopes: readonly Scope[]): Scope[] {
  const out: Scope[] = [];
  const seen = new Set<string>();
  const add = (s: Scope) => {
    const key = `${s.context.key}@${s.region}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(s);
    for (const call of s.context.calls) if (inside(s.region, call.at)) add({ context: call.context, region: null, ...(s.shared ? { shared: s.shared } : {}) });
  };
  scopes.forEach(add);
  return out;
}

/** The candidate words at argv position `pos`, each with the scopes its comparisons narrow to and its first comparison. */
export function nextWords(scopes: readonly Scope[], pos: number): Map<string, { scopes: Scope[]; first: Comparison }> {
  const next = new Map<string, { scopes: Scope[]; first: Comparison }>();
  for (const s of expand(scopes)) {
    for (const c of s.context.comparisons) {
      if (c.pos !== pos || c.text.length === 0 || !inside(s.region, c.at)) continue;
      const entry = next.get(c.text) ?? { scopes: [], first: c };
      const shared = c.shared ?? s.shared;
      entry.scopes.push({ context: s.context, region: c.region ?? s.region, ...(shared ? { shared } : {}) });
      next.set(c.text, entry);
    }
  }
  return next;
}
