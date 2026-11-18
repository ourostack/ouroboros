// Ouro's one action model: declare an action once, generate every surface from it, and fail CI when a surface drifts.
//
// One declaration per action (id, typed input and output, consent class, the person's label and description, the
// agent's description) projects to: a defineCommand definition (CLI, --json, MCP, in web's AX kit), an MCP tool, a
// WebMCP tool, web's defineComponentAx and bindAx entries with each control's props, an App Intent, a SwiftUI
// Button(intent:) and a Reins action. A person-only action refuses on every agent door with one typed refusal.
// Design: docs/superpowers/specs/2026-11-13-one-action-model-design.md. Adopter guide: docs/guides/actions.md.
//
// This file imports only node: modules, so an app vendors it as it is (dist/actions/ouro-actions.mts in a core
// release, pinned by hash) and runs it with Node 22.18 or later:
//   node ouro-actions.mts generate <actions.mts> <dir>      write every projection into <dir>
//   node ouro-actions.mts check <actions.mts> <dir>         fail when <dir> differs from what generate writes
//   node ouro-actions.mts compare-mcp <actions.mts> <tools.json>  fail when a live MCP tools/list differs
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The generator's version, written into every generated file; it is core's version. */
export const ACTIONS_VERSION = "0.17.7";
const GENERATOR = `ouro-actions ${ACTIONS_VERSION}`;

// ---------------------------------------------------------------------------------------------------------------
// The declaration
// ---------------------------------------------------------------------------------------------------------------

/**
 * What an action needs before it runs:
 * - `read`: changes nothing;
 * - `write`: changes only the person's own space;
 * - `consequential`: reaches other people or can't be taken back, so an agent prepares it and the person says yes;
 * - `person-only`: the person must start it themselves, and every agent door refuses it.
 */
export const CONSENTS = Object.freeze(["read", "write", "consequential", "person-only"] as const);
export type Consent = (typeof CONSENTS)[number];

interface FieldBase {
  /** The person's word for it: a form label, an App Intent parameter's title. */
  label: string;
  /** What it is, for an agent: the JSON Schema description, the CLI flag's help. */
  description: string;
  optional?: boolean;
  /**
   * Input only: the question Siri asks the person when this required value is missing, such as "What should I add to
   * your shopping list?" (the App Intent parameter's requestValueDialog).
   */
  ask?: string;
  /**
   * Input only: a field only programs send, such as an idempotency key or a server-side owner. MCP, WebMCP and the CLI
   * carry it; the App Intent and Reins, which stand for the person, leave it out, and in the Swift input it is optional
   * and nil. A required protocol-only field (an existing tool's required idempotency key) is one the app's handler
   * supplies when the person's door leaves it nil.
   */
  protocolOnly?: boolean;
  /**
   * Output only: the App Intent hands this field to Shortcuts as its result (`ReturnsValue`). One per action, required,
   * a string, number, integer or boolean.
   */
  returned?: boolean;
  /**
   * Input only, and optional: the CLI flag's name when the field's own kebab-case name is a flag web's kit already
   * takes, such as `flag: "plan-only"` for an existing MCP input named `dryRun`. `fromCli` renames it back.
   */
  flag?: string;
  /** Input only, and optional: the value may also be null, which a program sends to clear it (JSON Schema's `null`). */
  nullable?: boolean;
  /**
   * Input only, and optional: the property name the field has on the JSON wire (MCP, WebMCP), when the existing tool's
   * input is named differently from the declaration's camelCase name, such as `wire: "has_instructions"` for
   * `hasInstructions`. Only the JSON property changes; the other projections keep the declaration's name.
   */
  wire?: string;
}
/** A JSON Schema `format` a string can name; MCP and WebMCP carry it, and the CLI and Swift take the string as it is. */
export const STRING_FORMATS = Object.freeze(["date-time", "date", "uri", "email"] as const);
export interface StringField extends FieldBase {
  kind: "string";
  /**
   * Input only: the field is a positional CLI word, not a flag. A required one comes first; an optional one may follow
   * other optional ones, and no required one may follow it, since a positional can't be skipped. Not for a number,
   * boolean, list, group or one-of.
   */
  arg?: boolean;
  /** The longest the string may be, in characters (JSON Schema's `maxLength`). */
  maxLength?: number;
  /** A regular expression the string must match (JSON Schema's `pattern`), written as the source text, unanchored. */
  pattern?: string;
  format?: (typeof STRING_FORMATS)[number];
  /**
   * Input only: the app's own App Entity type, such as `"MarkdownDocumentEntity"`. The App Intent's parameter takes it, so
   * Shortcuts shows its picker; Input, MCP and the CLI keep a string, its `id`. The type must be `public`, with
   * `init(id: String)` and `id: String`.
   */
  entity?: string;
  /**
   * Input only: the value is long text, such as Markdown or a message. The App Intent's parameter opens a multiline editor
   * (`String.IntentInputOptions(multiline: true)`), and the description MCP, WebMCP and the CLI show says it may run over
   * several lines. Not for a positional `arg`, an `entity` or a `protocolOnly` field.
   */
  multiline?: boolean;
  /**
   * Input only: this string is an id the person never reads, such as `rcp_lemon_orzo`, and `shownAs` names the optional
   * sibling input string that carries their word for it, such as `recipeTitle`. A confirm sheet shows that name in its
   * place, with the id beside it as `raw`. The agent prepares both; the app's own resolver (A2UI `label`) can override
   * the name from its own data. MCP, the CLI and the App Intent just see two inputs, so a tool that doesn't want the
   * name there uses the resolver alone.
   */
  shownAs?: string;
}
export interface NumberField extends FieldBase { kind: "number" | "integer"; min?: number; max?: number }
export interface BooleanField extends FieldBase {
  kind: "boolean";
  /** The one value it takes: `const: true` is an explicit confirmation a program must send, such as `confirmNoCover`. */
  const?: true;
}
/** An enum takes `arg` as a string does; its `values` ride along in the CLI's args and in the MCP and WebMCP schemas. */
export interface EnumField<V extends string = string> extends FieldBase {
  kind: "enum";
  values: readonly V[];
  /** Input only: a positional CLI word, with the same placement rules as a string's `arg`. */
  arg?: boolean;
}
/**
 * The structured fields, for an existing MCP tool's inputs that a person's door can't carry: a list of values, a group
 * of named fields, or one of several shapes. They are protocol-only input fields: MCP and WebMCP carry their JSON
 * Schema and the CLI takes them as JSON; the App Intent, Reins and the Swift input leave them out. A list without `of`, or a
 * group without `fields`, is free-form: any JSON array, or any JSON object, for an existing MCP tool's input that takes one
 * without a shape.
 */
export interface ListField extends FieldBase { kind: "list"; of?: Field; minItems?: number; maxItems?: number }
export interface GroupField extends FieldBase { kind: "group"; fields?: Fields }
/**
 * `combinator` is JSON Schema's `oneOf` (the default: exactly one option matches) or `anyOf` (one or more match; the
 * options take the field's description, and their own are left out).
 */
export interface OneOfField extends FieldBase { kind: "one-of"; options: readonly Field[]; combinator?: "oneOf" | "anyOf" }
export type Field = StringField | NumberField | BooleanField | EnumField | ListField | GroupField | OneOfField;
export type Fields = Readonly<Record<string, Field>>;

type Opt = { optional?: boolean };
/**
 * Field builders. `arg: true` makes a string or enum input field a positional CLI word instead of a flag: web's words are
 * strings, and an enum's values are what the word may be. Required words come before optional ones.
 */
export const field = Object.freeze({
  string: <O extends Omit<StringField, "kind">>(o: O) => ({ ...o, kind: "string" as const }),
  number: <O extends Omit<NumberField, "kind">>(o: O) => ({ ...o, kind: "number" as const }),
  integer: <O extends Omit<NumberField, "kind">>(o: O) => ({ ...o, kind: "integer" as const }),
  boolean: <O extends Omit<BooleanField, "kind">>(o: O) => ({ ...o, kind: "boolean" as const }),
  enum: <const V extends string, O extends Omit<EnumField<V>, "kind">>(o: O & { values: readonly V[] }) => ({ ...o, kind: "enum" as const }),
  /** A list of values, each the field `of` describes (its label and description describe one item). */
  list: <const O extends Omit<ListField, "kind">>(o: O) => ({ ...o, kind: "list" as const }),
  /** A group of named fields: a JSON object, nothing extra. */
  group: <const O extends Omit<GroupField, "kind">>(o: O) => ({ ...o, kind: "group" as const }),
  /** Exactly one of several shapes, such as a number of days or the word "never" (JSON Schema's `oneOf`). */
  oneOf: <const O extends Omit<OneOfField, "kind">>(o: O) => ({ ...o, kind: "one-of" as const }),
});
const KINDS = Object.freeze(["string", "number", "integer", "boolean", "enum", "list", "group", "one-of"]);
const STRUCTURED = Object.freeze(["list", "group", "one-of"]);
const isStructured = (f: Field) => STRUCTURED.includes(f.kind);
/** A positional CLI word: a string or enum input field declared `arg: true`. */
const isArg = (f: Field) => "arg" in f && Boolean(f.arg);

type Nullable<F, T> = F extends { nullable: true } ? T | null : T;
type ValueOf<F> = Nullable<F, F extends { kind: "string" } ? string
  : F extends { kind: "number" | "integer" } ? number
  : F extends { kind: "boolean" } ? boolean
  : F extends { kind: "enum"; values: readonly (infer V)[] } ? V
  : F extends { kind: "list"; of: infer I } ? ValueOf<I>[]
  : F extends { kind: "list" } ? unknown[]
  : F extends { kind: "group"; fields: infer G } ? ValuesOf<G>
  : F extends { kind: "group" } ? Record<string, unknown>
  : F extends { kind: "one-of"; options: readonly (infer U)[] } ? ValueOf<U>
  : never>;
type OptionalKeys<F> = { [K in keyof F]: F[K] extends Opt & { optional: true } ? K : never }[keyof F];
type RequiredKeys<F> = Exclude<keyof F, OptionalKeys<F>>;
/** The value an action's fields describe, optional fields optional. */
export type ValuesOf<F> = { [K in RequiredKeys<F>]: ValueOf<F[K]> } & { [K in OptionalKeys<F>]?: ValueOf<F[K]> };
/** An action's input type: `InputOf<typeof addShoppingListItem>`. */
export type InputOf<A> = A extends Action<infer I, Fields> ? ValuesOf<I> : never;
/** An action's output type. */
export type OutputOf<A> = A extends Action<Fields, infer O> ? ValuesOf<O> : never;

/** Why only the person does it, said to the agent, and how the person does it. One line each. */
export interface PersonOnly {
  reason: string;
  how: string;
}

export interface ActionDef<I extends Fields = Fields, O extends Fields = Fields> {
  /** snake_case, such as `add_shopping_list_item`: the MCP and WebMCP tool name. Other names derive from it. */
  id: string;
  consent: Consent;
  /** The person's button text, and the App Intent's title. */
  label: string;
  /** The person's one sentence: the control's hint, the component AX summary. */
  description: string;
  /** The agent's description: the MCP and WebMCP description, the CLI summary, the App Intent's description. One line. */
  agent: string;
  input: I;
  output: O;
  /** Exactly when `consent` is `person-only`. */
  personOnly?: PersonOnly;
  /** For a person-only action, whether other people see its effect; it decides web's effect class. Default "private". */
  reaches?: "private" | "others";
  /** The CLI words, such as `list add`; defaults to the id in kebab case. */
  cli?: string;
  /** The App Intent opens the app when it runs (`openAppWhenRun`), for an action whose point is to show a window. */
  opensApp?: boolean;
  /**
   * A write that removes or overwrites some of the person's own things, such as deleting a list item: MCP's
   * `destructiveHint`, so a client may ask before it runs. A consequential action is destructive already.
   */
  destructive?: true;
  /** Calling it again with the same input changes nothing more: MCP's `idempotentHint`, so a client may retry it. */
  idempotent?: true;
  /**
   * The input takes keys it doesn't name, and a schema with no required input has no `required` list: the input schema
   * an MCP server already serves for a tool moved onto the model. Declare it only to keep an existing tool's input exactly;
   * a new action keeps the closed schema, which rejects a key it doesn't name.
   */
  openInput?: true;
}

export interface Action<I extends Fields = Fields, O extends Fields = Fields> extends Readonly<ActionDef<I, O>> {
  readonly names: Names;
  readonly cliWords: string;
}

export interface ActionSet {
  /** The set's name, such as `shopping`; it names the generated files' contents. */
  readonly name: string;
  /** The CLI tool's name, which twins start with, such as `shop`. */
  readonly tool: string;
  readonly actions: readonly Action[];
}

export interface Names {
  kebab: string;
  camel: string;
  pascal: string;
}

const ID = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const FIELD_NAME = /^[a-z][a-zA-Z0-9]*$/;
const WIRE_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/**
 * What an input field may not take: web's kit's own flags (`--json`, `--help`, `--why`, `--why-file`, `--dry-run`,
 * `--agent`, `--quiet`), which the field's flag would shadow (a field keeps its name and takes another with `flag`), and
 * the generated App Intent's own members (`input`, `perform`), which its `@Parameter` would clash with. Swift keywords
 * are escaped, so they are allowed.
 */
const KIT_FLAGS = Object.freeze(["json", "help", "why", "why-file", "dry-run", "agent", "quiet"]);
const INTENT_MEMBERS = Object.freeze(["input", "perform"]);
/** An enum value: lowercase words and digits, joined by -, _, /, . or : (`shopping-list`, `image/jpeg`, `notes:safe`). */
const ENUM_VALUE = /^[a-z][a-z0-9]*([-_/.:][a-z0-9]+)*$/;
/**
 * Ids web's `defineComponentAx` reserves for the person (its `RESERVED_PERSON_ONLY`), which only a person-only action may
 * take. Web also reads an id's meaning (`share-screen`, `mic-on`); its defineComponentAx and X-ray still apply that.
 */
const WEB_RESERVED_IDS = Object.freeze(["unmute", "camera", "camera_on", "share", "answer", "decline", "admit", "record"]);
/** A camelCase field name as web's kebab-case flag: `canEdit` is `can-edit`. */
const flagName = (field: string) => field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const oneLine = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);

/** The names an id derives: `add_shopping_list_item` is `add-shopping-list-item`, `addShoppingListItem`, `AddShoppingListItem`. */
export function names(id: string): Names {
  const parts = id.split("_");
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return { kebab: parts.join("-"), camel: parts[0] + parts.slice(1).map(cap).join(""), pascal: parts.map(cap).join("") };
}

/** Checks one field, wherever it sits: `top` is an action's input or output field; otherwise it is inside a list, group or one-of. */
function checkField(at: string, f: Field, input: boolean, top: boolean): void {
  if (!KINDS.includes(f?.kind)) throw new Error(`${at}: has no kind. Fix: build it with field.string, field.number, field.integer, field.boolean, field.enum, field.list, field.group or field.oneOf.`);
  if (!oneLine(f.label)) throw new Error(`${at}: label is empty or more than one line. Fix: the person's word for it, such as "Quantity".`);
  if (!oneLine(f.description)) throw new Error(`${at}: description is empty or more than one line. Fix: one sentence for the agent.`);
  if (f.wire !== undefined && !WIRE_NAME.test(f.wire)) throw new Error(`${at}: wire is not a JSON property name. Fix: letters, digits and underscores, starting with a letter, such as "has_instructions".`);
  if (!top) {
    for (const key of ["ask", "protocolOnly", "returned", "flag", "arg", "entity", "multiline", "shownAs"] as const) {
      if (key in f && (f as unknown as Record<string, unknown>)[key] !== undefined) throw new Error(`${at}: ${key} is for an action's own input or output field, not one inside a list, group or one-of. Fix: drop ${key}.`);
    }
  }
  if (f.ask !== undefined && (!input || !oneLine(f.ask))) throw new Error(`${at}: ask is the one-line question Siri asks for a missing input value. Fix: drop it from an output field, or write it in one line.`);
  if (f.protocolOnly !== undefined && (f.protocolOnly !== true || !input || ("arg" in f && f.arg))) throw new Error(`${at}: protocolOnly is for an input field that only programs send, never a CLI argument. Fix: protocolOnly: true without arg, or drop protocolOnly.`);
  if (top && input && isStructured(f) && !f.protocolOnly) throw new Error(`${at}: a ${f.kind} field is only for programs, since the App Intent and Reins can't take one. Fix: add protocolOnly: true, or split it into plain fields.`);
  if (!input && isStructured(f)) throw new Error(`${at}: an output field can't be a ${f.kind}. Fix: return it as a string field holding JSON.`);
  if (f.flag !== undefined && (!input || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(f.flag))) throw new Error(`${at}: flag is an input field's CLI flag name, in kebab case. Fix: such as flag: "plan-only".`);
  if (f.nullable !== undefined && (f.nullable !== true || !input || (top && !f.optional) || f.kind === "enum" || f.kind === "list" || f.kind === "group")) {
    throw new Error(`${at}: nullable is for an optional string, number, integer, boolean or one-of input field that a program clears with null. Fix: make it optional, or drop nullable.`);
  }
  if ("returned" in f && f.returned !== undefined) {
    if (input) throw new Error(`${at}: returned is only for an output field. Fix: drop returned.`);
    if (!["string", "number", "integer", "boolean"].includes(f.kind)) throw new Error(`${at}: returned must be a string, number, integer or boolean field, which Shortcuts can take. Fix: return a text field.`);
    if (f.optional) throw new Error(`${at}: returned must be required, so the intent always has a value to hand on. Fix: drop optional.`);
  }
  if (!input && f.kind === "enum") throw new Error(`${at}: an output field can't be an enum, since the Swift output has no type for it. Fix: return it as a string field and name its values in the description.`);
  if ("entity" in f && f.entity !== undefined) {
    if (f.kind !== "string" || !input) throw new Error(`${at}: entity is only for an input string field, whose value is the entity's id. Fix: drop entity.`);
    if (!/^[A-Z][A-Za-z0-9]*$/.test(f.entity)) throw new Error(`${at}: entity is not a Swift type name. Fix: the app's App Entity, such as "MarkdownDocumentEntity".`);
    if (f.protocolOnly) throw new Error(`${at}: entity is for the person's doors, and a protocol-only field isn't on them. Fix: drop entity or protocolOnly.`);
  }
  if ("multiline" in f && f.multiline !== undefined) {
    if (f.kind !== "string") throw new Error(`${at}: multiline is only for a string field. Fix: drop multiline.`);
    if (!input) throw new Error(`${at}: multiline is only for an input field. Fix: drop multiline.`);
    if (f.arg) throw new Error(`${at}: multiline can't be a positional arg, which is one word on the command line. Fix: drop arg or multiline.`);
    if (f.entity !== undefined) throw new Error(`${at}: multiline is for typed text, and an entity is picked. Fix: drop entity or multiline.`);
    if (f.protocolOnly) throw new Error(`${at}: multiline is for the person's doors, and a protocol-only field isn't on them. Fix: drop multiline or protocolOnly.`);
  }
  if (isArg(f) && (!input || (f.kind !== "string" && f.kind !== "enum"))) throw new Error(`${at}: arg is only for an input string or enum field, since a positional is one word on the command line. Fix: drop arg, or make it a string or enum.`);
  if (isArg(f) && f.nullable) throw new Error(`${at}: a positional arg can't be nullable, since a word can't be null. Fix: drop nullable, or drop arg.`);
  if (f.kind === "string") {
    if (f.maxLength !== undefined && !(Number.isInteger(f.maxLength) && f.maxLength > 0)) throw new Error(`${at}: maxLength is ${JSON.stringify(f.maxLength)}. Fix: a whole number above 0.`);
    if (f.pattern !== undefined) {
      try {
        new RegExp(f.pattern, "u");
      } catch {
        throw new Error(`${at}: pattern ${JSON.stringify(f.pattern)} is not a regular expression. Fix: write the expression's source, such as "^[a-z]+$".`);
      }
    }
    if (f.format !== undefined && !(STRING_FORMATS as readonly string[]).includes(f.format)) throw new Error(`${at}: format is ${JSON.stringify(f.format)}. Fix: one of ${STRING_FORMATS.join(", ")}, or leave it out.`);
  }
  if (f.kind === "boolean" && f.const !== undefined && f.const !== true) throw new Error(`${at}: const is ${JSON.stringify(f.const)}. Fix: const: true, for a confirmation a program must send, or leave it out.`);
  if (f.kind === "boolean" && f.const !== undefined && f.nullable) throw new Error(`${at}: a const field can't be nullable, since const: true takes only true. Fix: drop nullable.`);
  if (f.kind === "enum") {
    if (!Array.isArray(f.values) || f.values.length === 0 || !f.values.every((v) => ENUM_VALUE.test(v))) {
      throw new Error(`${at}: values is empty or not lowercase words. Fix: values: ["all", "unchecked"]; words may be joined by -, _, /, . or :, as in "image/jpeg" or "notes:safe".`);
    }
    // Only an action's own enum fields become Swift enums, so only they must keep their cases apart.
    const cases = new Map<string, string>();
    for (const v of top ? f.values : []) {
      const other = cases.get(caseName(v));
      if (other !== undefined) throw new Error(`${at}: values "${other}" and "${v}" are the same Swift case, ${caseName(v)}. Fix: drop or rename one.`);
      cases.set(caseName(v), v);
    }
  }
  if (f.kind === "list" && f.of !== undefined) {
    if (f.of?.optional) throw new Error(`${at} item: an item can't be optional. Fix: drop optional from of.`);
    for (const bound of ["minItems", "maxItems"] as const) {
      const v = f[bound];
      if (v !== undefined && !(Number.isInteger(v) && v >= 0)) throw new Error(`${at}: ${bound} is ${JSON.stringify(v)}. Fix: a whole number of 0 or more.`);
    }
    if (f.minItems !== undefined && f.maxItems !== undefined && f.minItems > f.maxItems) throw new Error(`${at}: minItems ${f.minItems} is above maxItems ${f.maxItems}. Fix: make minItems no larger than maxItems.`);
    checkField(`${at} item`, f.of, input, false);
  }
  if (f.kind === "group" && f.fields !== undefined) checkFields(`${at}`, f.fields, input, false);
  if (f.kind === "one-of") {
    if (f.combinator !== undefined && f.combinator !== "oneOf" && f.combinator !== "anyOf") throw new Error(`${at}: combinator is not "oneOf" or "anyOf". Fix: combinator: "anyOf" when a value may match more than one option, else leave it out.`);
    if (!Array.isArray(f.options) || f.options.length < 2) throw new Error(`${at}: options needs two shapes or more. Fix: options: [field.integer({ ... }), field.enum({ ... })], or use the one field.`);
    // JSON Schema's oneOf takes a value that matches exactly one option, so no two options may take the same value.
    const shapes = new Map<string, number>();
    f.options.forEach((o, i) => {
      if (o?.optional) throw new Error(`${at} option ${i + 1}: an option can't be optional. Fix: drop optional from the option; make the one-of field optional instead.`);
      if (o?.nullable) throw new Error(`${at} option ${i + 1}: an option can't be nullable. Fix: make the one-of field nullable instead.`);
      checkField(`${at} option ${i + 1}`, o, input, false);
      const shape = o?.kind === "enum" ? "string" : o?.kind === "integer" ? "number" : o?.kind;
      const other = shapes.get(shape);
      if (other !== undefined) throw new Error(`${at} options ${other + 1} and ${i + 1}: both can take the same ${shape} value, and a one-of takes a value that matches exactly one. Fix: keep one option per kind of value, counting an enum as a string and an integer as a number.`);
      shapes.set(shape, i);
    });
  }
}

function checkFields(where: string, fields: unknown, input: boolean, top = true): void {
  if (typeof fields !== "object" || fields === null || Array.isArray(fields)) throw new Error(`${where}: is not an object of fields. Fix: { <name>: field.string({ ... }) }, or {}.`);
  for (const [name, f] of Object.entries(fields as Record<string, Field>)) {
    const at = `${where} "${name}"`;
    if (!FIELD_NAME.test(name)) throw new Error(`${at}: a field name is camelCase letters and digits. Fix: rename it, such as "canEdit".`);
    if (top && input && INTENT_MEMBERS.includes(name)) throw new Error(`${at}: the name is taken by the App Intent's own members (${INTENT_MEMBERS.join(", ")}). Fix: rename it, such as "${name}Value".`);
    if (top && input && KIT_FLAGS.includes(f?.flag ?? flagName(name))) {
      throw new Error(`${at}: its CLI flag --${f?.flag ?? flagName(name)} is taken by web's kit, whose own flags are (${KIT_FLAGS.map((k) => `--${k}`).join(", ")}). Fix: rename it, such as "${name}Value", or keep the name and give it its own flag, such as flag: "${flagName(name)}-value".`);
    }
    if (top && "shownAs" in f && f.shownAs !== undefined) {
      const to = f.shownAs;
      const sibling = (fields as Record<string, Field>)[to];
      if (f.kind !== "string") throw new Error(`${at}: shownAs is only for a string field, the id. Fix: drop shownAs.`);
      if (!input) throw new Error(`${at}: shownAs is only for an input field. Fix: drop shownAs.`);
      if (to === name) throw new Error(`${at}: shownAs names the field itself. Fix: name the sibling that holds the person's word for it, such as "recipeTitle".`);
      if (typeof to !== "string" || !sibling) throw new Error(`${at}: shownAs ${JSON.stringify(to)} is not another input field. Fix: declare it beside this one, such as recipeTitle: field.string({ ..., optional: true }).`);
      if (sibling.kind !== "string" || !sibling.optional) throw new Error(`${at}: shownAs ${JSON.stringify(to)} must be an optional string input, so a call without a name still works. Fix: make "${to}" an optional string.`);
      if (sibling.protocolOnly) throw new Error(`${at}: shownAs ${JSON.stringify(to)} is protocolOnly, so the person's doors don't carry it. Fix: drop protocolOnly from "${to}".`);
      if ("shownAs" in sibling && sibling.shownAs !== undefined) throw new Error(`${at}: shownAs ${JSON.stringify(to)} is itself shown as another field, and a name has no name. Fix: drop shownAs from "${to}".`);
    }
    checkField(at, f, input, top);
  }
  const wires = new Map<string, string>();
  for (const [name, f] of Object.entries(fields as Record<string, Field>)) {
    const wire = f.wire ?? name;
    if (wires.has(wire)) throw new Error(`${where}: "${wires.get(wire)}" and "${name}" are both named "${wire}" on the wire. Fix: give one a different wire name.`);
    wires.set(wire, name);
  }
  if (top && !input) {
    const returned = Object.entries(fields as Record<string, Field>).filter(([, f]) => f.returned);
    if (returned.length > 1) throw new Error(`${where}: ${returned.map(([n]) => `"${n}"`).join(" and ")} are both returned, and only one output field can be returned. Fix: keep returned on the one Shortcuts should get.`);
  }
  if (top && input) {
    const flags = new Map<string, string>();
    let optionalArg: string | undefined;
    for (const [name, f] of Object.entries(fields as Record<string, Field>)) {
      if (isArg(f)) {
        if (!f.optional) {
          if (optionalArg !== undefined) throw new Error(`${where} "${name}": a required arg comes after the optional arg "${optionalArg}"; a positional can't be skipped. Fix: make "${name}" optional, or put it before "${optionalArg}".`);
        } else {
          optionalArg ??= name;
        }
      }
      const flag = f.flag ?? flagName(name);
      const other = flags.get(flag);
      if (other !== undefined) throw new Error(`${where}: "${other}" and "${name}" share the CLI flag --${flag}. Fix: give one its own flag.`);
      flags.set(flag, name);
    }
  }
}

/** Declares one action and checks it; a problem throws one line with its fix. */
export function defineAction<const I extends Fields, const O extends Fields>(def: ActionDef<I, O>): Action<I, O> {
  const id = typeof def.id === "string" ? def.id : String(def.id);
  if (!ID.test(id)) throw new Error(`action ${JSON.stringify(id)}: the id is not snake_case. Fix: lowercase words joined by _, such as "add_shopping_list_item".`);
  const at = `action "${id}"`;
  if (!(CONSENTS as readonly string[]).includes(def.consent)) throw new Error(`${at}: consent is ${JSON.stringify(def.consent)}. Fix: one of ${CONSENTS.join(", ")}.`);
  for (const key of ["label", "description", "agent"] as const) {
    if (!oneLine(def[key])) throw new Error(`${at}: ${key} is empty or more than one line. Fix: write it in one line.`);
  }
  if (def.consent === "person-only") {
    if (!def.personOnly || !oneLine(def.personOnly.reason) || !oneLine(def.personOnly.how)) {
      throw new Error(`${at}: a person-only action needs personOnly, its reason and how, one line each. Fix: personOnly: { reason: "You can't <do it> for the person; only they can.", how: "<where the person does it>" }.`);
    }
  } else {
    if (def.personOnly !== undefined) throw new Error(`${at}: personOnly is only for consent "person-only". Fix: drop personOnly, or make the consent "person-only".`);
    if (def.reaches !== undefined) throw new Error(`${at}: reaches is only for consent "person-only"; the consent class decides who sees the others. Fix: drop reaches.`);
  }
  if (def.consent !== "person-only" && WEB_RESERVED_IDS.includes(id)) throw new Error(`${at}: web reserves "${names(id).kebab}" for the person, so only a person-only action may use it. Fix: consent "person-only" with personOnly, or another id.`);
  if (def.reaches !== undefined && def.reaches !== "private" && def.reaches !== "others") throw new Error(`${at}: reaches is ${JSON.stringify(def.reaches)}. Fix: "private" or "others".`);
  if (def.cli !== undefined && !/^[a-z][a-z0-9-]*( [a-z][a-z0-9-]*)*$/.test(def.cli)) throw new Error(`${at}: cli is not lowercase words. Fix: such as "list add".`);
  if (def.opensApp !== undefined && typeof def.opensApp !== "boolean") throw new Error(`${at}: opensApp is ${JSON.stringify(def.opensApp)}. Fix: true or false.`);
  if (def.destructive !== undefined && (def.destructive !== true || def.consent !== "write")) {
    throw new Error(`${at}: destructive is for a write that removes or overwrites the person's own things; a consequential action is destructive already, a read changes nothing and no agent door offers a person-only one. Fix: destructive: true on a write, or drop it.`);
  }
  if (def.idempotent !== undefined && (def.idempotent !== true || (def.consent !== "write" && def.consent !== "consequential"))) {
    throw new Error(`${at}: idempotent is for a write or consequential action that changes nothing more when called again with the same input; a read is idempotent already. Fix: idempotent: true, or drop it.`);
  }
  if (def.openInput !== undefined && def.openInput !== true) throw new Error(`${at}: openInput is ${JSON.stringify(def.openInput)}. Fix: true, or drop it.`);
  checkFields(`${at} input`, def.input, true);
  checkFields(`${at} output`, def.output, false);
  const n = names(id);
  return Object.freeze({ ...def, id, names: n, cliWords: def.cli ?? n.kebab });
}

/** The set an app generates from. Ids, CLI words and derived names must be unique, so no two surfaces collide. */
export function defineActions(name: string, actions: readonly Action[], options: { tool?: string } = {}): ActionSet {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`action set ${JSON.stringify(name)}: the set name is lowercase words joined by -. Fix: such as "shopping".`);
  const tool = options.tool ?? name;
  if (!/^[a-z][a-z0-9-]*$/.test(tool)) throw new Error(`action set "${name}": tool is ${JSON.stringify(tool)}. Fix: the CLI's name, such as "shop".`);
  const seen = new Map<string, string>();
  for (const a of actions) {
    const keys: [string, string][] = [["id", a.id], ["kebab name", a.names.kebab], ["camel name", a.names.camel], ["Swift name", a.names.pascal], ["CLI words", a.cliWords]];
    for (const [field, f] of [...Object.entries(a.input), ...Object.entries(a.output)]) if (f.kind === "enum") keys.push(["Swift enum type", enumType(a, field)]);
    for (const [what, value] of keys) {
      const key = `${what}=${value}`;
      const other = seen.get(key);
      if (other === a.id) throw new Error(`action set "${name}": action "${a.id}" is used twice. Fix: list each action once.`);
      if (other !== undefined) throw new Error(`action set "${name}": actions "${other}" and "${a.id}" share the ${what} "${value}". Fix: rename one, or give it its own cli words.`);
    }
    for (const [what, value] of keys) seen.set(`${what}=${value}`, a.id);
  }
  return Object.freeze({ name, tool, actions: Object.freeze([...actions]) });
}

// ---------------------------------------------------------------------------------------------------------------
// Consent onto each surface, and the typed refusal
// ---------------------------------------------------------------------------------------------------------------

/** Web's effect class: consequential reaches others; read and write are the person's own. */
export function effectOf(a: Action): "private" | "others" {
  if (a.consent === "consequential") return "others";
  if (a.consent === "person-only") return a.reaches ?? "private";
  return "private";
}

export interface McpAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
  idempotentHint?: true;
}

/**
 * MCP tool annotations: web's `effectAnnotations(effect, readOnly)`, with `destructiveHint` also on a write declared
 * `destructive`, and `idempotentHint` on an action declared `idempotent` (MCP's default for it is false).
 */
export function annotationsOf(a: Action): McpAnnotations {
  const others = effectOf(a) === "others";
  const out: McpAnnotations = { readOnlyHint: a.consent === "read", destructiveHint: others || a.destructive === true, openWorldHint: others };
  if (a.idempotent) out.idempotentHint = true;
  return out;
}

export interface Refusal {
  ax: "outcome/1";
  action: string;
  effect: "private";
  audience: { only: true; who: "only you" };
  target: null;
  state: "refused";
  summary: string;
  postcondition: { checked: false; holds: null; how: "not checked" };
  receipt: null;
  next: [];
  error: { code: "person-only"; exit: 2; thing: string; problem: string; fix: null; message: string };
}

const sentence = (text: string) => text.trim().replace(/[.\s]+$/, "");

/**
 * The answer every agent door gives a person-only action, in the shape web's CLI answers a person-only word under
 * `--json` (cli.ts: `outcome({ action, state: "refused", summary, error })` over `personOnlyError`): a refused outcome
 * whose error has code `person-only`, exit 2 (web's `usage`), the reason and how the person does it. `action` and
 * `error.thing` keep the command words, which identify it; the summary and message name it by its label, the words
 * on the person's button, because an agent relays them to a person, and on an App Action, MCP or A2UI door the
 * command words mean nothing to them.
 */
export function refusal(a: Action): Refusal {
  if (a.consent !== "person-only" || !a.personOnly) throw new Error(`action "${a.id}" is not person-only, so nothing refuses it. Fix: refuse only person-only actions.`);
  const thing = a.cliWords;
  const problem = `${sentence(a.personOnly.reason)}. Ask the person, who does it ${sentence(a.personOnly.how)}`;
  const message = `${a.label}: ${sentence(problem)}.`;
  return {
    ax: "outcome/1",
    action: thing,
    effect: "private",
    audience: { only: true, who: "only you" },
    target: null,
    state: "refused",
    summary: message,
    postcondition: { checked: false, holds: null, how: "not checked" },
    receipt: null,
    next: [],
    error: { code: "person-only", exit: 2, thing, problem, fix: null, message },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JSON projections
// ---------------------------------------------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** The field's description as an agent reads it: long text says it may run over several lines. */
const describe = (f: Field) => (f.kind === "string" && f.multiline ? `${f.description} It may run over several lines.` : f.description);

function fieldSchema(f: Field): Record<string, Json> {
  if (f.kind === "one-of") {
    const anyOf = f.combinator === "anyOf";
    const options: Json[] = f.options.map((o) => (anyOf ? withoutDescriptions(fieldSchema(o)) : fieldSchema(o)));
    if (f.nullable) options.push({ type: "null" });
    return anyOf ? { anyOf: options, description: describe(f) } : { oneOf: options, description: describe(f) };
  }
  const type = f.kind === "enum" ? "string" : f.kind === "list" ? "array" : f.kind === "group" ? "object" : f.kind;
  const s: Record<string, Json> = { type: f.nullable ? [type, "null"] : type, description: describe(f) };
  if (f.kind === "enum") s["enum"] = [...f.values];
  if ((f.kind === "number" || f.kind === "integer") && f.min !== undefined) s["minimum"] = f.min;
  if ((f.kind === "number" || f.kind === "integer") && f.max !== undefined) s["maximum"] = f.max;
  if (f.kind === "string" && f.maxLength !== undefined) s["maxLength"] = f.maxLength;
  if (f.kind === "string" && f.pattern !== undefined) s["pattern"] = f.pattern;
  if (f.kind === "string" && f.format !== undefined) s["format"] = f.format;
  if (f.kind === "boolean" && f.const !== undefined) s["const"] = f.const;
  if (f.kind === "list" && f.of !== undefined) s["items"] = fieldSchema(f.of);
  if (f.kind === "list" && f.minItems !== undefined) s["minItems"] = f.minItems;
  if (f.kind === "list" && f.maxItems !== undefined) s["maxItems"] = f.maxItems;
  if (f.kind === "group" && f.fields !== undefined) Object.assign(s, objectSchema(f.fields));
  return s;
}

/** The JSON property a field has on the wire: its `wire` name, or its declaration name. */
const wireOf = (name: string, f: Field) => f.wire ?? name;

/** An anyOf option takes the one-of field's description, so its own (and its items') descriptions are left out. */
function withoutDescriptions(s: Json): Json {
  if (Array.isArray(s)) return s.map(withoutDescriptions);
  if (s === null || typeof s !== "object") return s;
  return Object.fromEntries(Object.entries(s).filter(([k, v]) => k !== "description" || typeof v !== "string").map(([k, v]) => [k, withoutDescriptions(v)]));
}

/** An open object leaves out `additionalProperties` and an empty `required`, as an MCP server already serves them. */
function objectSchema(fields: Fields, open = false): { type: "object"; properties: Record<string, Json>; required?: string[]; additionalProperties?: false } {
  const entries = Object.entries(fields);
  const required = entries.filter(([, f]) => !f.optional).map(([k, f]) => wireOf(k, f));
  return {
    type: "object",
    properties: Object.fromEntries(entries.map(([k, f]) => [wireOf(k, f), fieldSchema(f)])),
    ...(open && required.length === 0 ? {} : { required }),
    ...(open ? {} : { additionalProperties: false }),
  };
}

/** The input's JSON Schema, shared by MCP, WebMCP and the CLI's `help --json`. */
export const inputSchema = (a: Action) => objectSchema(a.input, a.openInput === true);

/** The output's JSON Schema. */
export const outputSchema = (a: Action) => objectSchema(a.output);

export interface CommandJson {
  name: string;
  summary: string;
  effect: "private" | "others";
  readOnly?: true;
  /** Positional words, in order: a required one has `required: true`; an optional one omits it. An enum's values ride along. */
  args?: { name: string; description: string; required?: true; values?: string[] }[];
  flags?: Record<string, Record<string, Json>>;
  output?: string;
}

function flagSpec(f: Field): Record<string, Json> {
  // A structured field comes in as one JSON string, which fromCli parses.
  if (isStructured(f)) return { type: "string", description: `${sentence(describe(f))}, as JSON.`, ...(f.optional ? {} : { required: true }) };
  const s: Record<string, Json> = { type: f.kind === "integer" ? "number" : f.kind, description: describe(f) };
  if (f.kind === "enum") s["values"] = [...f.values];
  if (f.kind === "number" || f.kind === "integer") {
    if (f.min !== undefined) s["min"] = f.min;
    if (f.max !== undefined) s["max"] = f.max;
  }
  if (!f.optional) s["required"] = true;
  return s;
}

/** The action as web's `defineCommand` definition, without `run`. A person-only action has none; it is a refusing word. */
export function toCommand(a: Action): CommandJson {
  if (a.consent === "person-only") throw new Error(`action "${a.id}" is person-only: it is a word the CLI refuses, not a command. Fix: use the commands file's personOnly.`);
  const cmd: CommandJson = { name: a.cliWords, summary: a.agent, effect: effectOf(a) };
  if (a.consent === "read") cmd.readOnly = true;
  const fields = Object.entries(a.input);
  const args = fields.filter(([, f]) => isArg(f)).map(([name, f]) => ({
    name,
    description: f.description,
    ...(f.optional ? {} : { required: true as const }),
    ...(f.kind === "enum" ? { values: [...f.values] } : {}),
  }));
  const flags = Object.fromEntries(fields.filter(([, f]) => !isArg(f)).map(([name, f]) => [f.flag ?? flagName(name), flagSpec(f)]));
  if (args.length) cmd.args = args;
  if (Object.keys(flags).length) cmd.flags = flags;
  const out = Object.keys(a.output);
  if (out.length) cmd.output = `{ ${out.join(", ")} }`;
  return cmd;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: ReturnType<typeof objectSchema>;
  outputSchema?: ReturnType<typeof objectSchema>;
  annotations: McpAnnotations;
}

/** The MCP tool. */
export function toMcpTool(a: Action): McpTool {
  const tool: McpTool = { name: a.id, title: a.label, description: a.agent, inputSchema: inputSchema(a), annotations: annotationsOf(a) };
  if (Object.keys(a.output).length) tool.outputSchema = outputSchema(a);
  return tool;
}

/** The WebMCP tool descriptor, for `registerTool`, with the hints WebMCP defines. */
export function toWebMcpTool(a: Action) {
  return { name: a.id, description: a.agent, inputSchema: inputSchema(a), annotations: { readOnlyHint: a.consent === "read", consequentialHint: a.consent === "consequential" } };
}

const header = (set: ActionSet) => ({ generator: GENERATOR, set: set.name });
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const agentDoors = (set: ActionSet) => set.actions.filter((a) => a.consent !== "person-only");
const refusals = (set: ActionSet) => Object.fromEntries(set.actions.filter((a) => a.consent === "person-only").map((a) => [a.id, refusal(a)]));
const lit = (s: string) => JSON.stringify(s);

function twinOf(set: ActionSet, a: Action): string {
  // A word the person may leave out is bracketed, as web's usage line shows it: `[<name>]`.
  const args = Object.entries(a.input).filter(([, f]) => isArg(f)).map(([name, f]) => (f.optional ? `[<${name}>]` : `<${name}>`));
  return [set.tool, a.cliWords, ...args].join(" ");
}

function renderWeb(set: ActionSet): string {
  const comment = `// Generated by ${GENERATOR} from the "${set.name}" action set. Don't edit; run generate.`;
  const ax = set.actions.map((a) => {
    const side = a.consent === "person-only" ? `personOnly: ${lit(a.personOnly!.reason)}` : "agent: true";
    return `    { id: ${lit(a.names.kebab)}, summary: ${lit(a.description)}, effect: ${lit(effectOf(a))}, ${side} },`;
  });
  const twins = agentDoors(set).map((a) => `    ${lit(a.names.kebab)}: ${lit(twinOf(set, a))},`);
  const refuse = set.actions.filter((a) => a.consent === "person-only").map((a) => `    ${lit(a.names.kebab)}: ${lit(`${set.tool} ${a.cliWords}`)},`);
  const cliInput = agentDoors(set).flatMap((a) => {
    const renames = Object.entries(a.input).filter(([n, f]) => (f.flag ?? flagName(n)) !== n).map(([n, f]) => `${lit(f.flag ?? flagName(n))}: ${lit(n)}`);
    return renames.length ? [`  ${lit(a.names.kebab)}: { ${renames.join(", ")} },`] : [];
  });
  const cliJson = agentDoors(set).flatMap((a) => {
    const structured = Object.entries(a.input).filter(([, f]) => isStructured(f)).map(([n]) => lit(n));
    return structured.length ? [`  ${lit(a.names.kebab)}: [${structured.join(", ")}],`] : [];
  });
  const controls = set.actions.map((a) =>
    `  ${lit(a.names.kebab)}: { label: ${lit(a.label)}, description: ${lit(a.description)}, consent: ${lit(a.consent)}, props: { "data-ax-action": ${lit(a.names.kebab)} } },`,
  );
  return [
    comment,
    "//",
    "// componentAx goes into web's defineComponentAx as a component's actions; twins goes into bindAx; spread a",
    "// control's props on the control that takes the action, so web's expectAxRendered finds it.",
    `export const generated = ${JSON.stringify(header(set))} as const;`,
    "",
    "export const componentAx = {",
    "  actions: [",
    ...ax,
    "  ],",
    "} as const;",
    "",
    "export const twins = {",
    "  actions: {",
    ...twins,
    "  },",
    "  refuseAs: {",
    ...refuse,
    "  },",
    "} as const;",
    "",
    "export const controls = {",
    ...controls,
    "} as const;",
    "",
    "// Web's CLI hands run() its flags by name, which are kebab-case (--can-edit); every other door uses the field's",
    "// name (canEdit). fromCli renames them, so a command's run() calls the same handler as MCP, WebMCP and Apple.",
    "export const cliInput: Readonly<Record<string, Readonly<Record<string, string>>>> = {",
    ...cliInput,
    "};",
    "",
    "// A list, group or one-of field comes in on the CLI as one JSON string; fromCli parses it.",
    "export const cliJson: Readonly<Record<string, readonly string[]>> = {",
    ...cliJson,
    "};",
    "",
    "export function fromCli(action: keyof typeof twins.actions, input: Readonly<Record<string, unknown>>): Record<string, unknown> {",
    "  const rename = cliInput[action] ?? {};",
    "  const json = cliJson[action] ?? [];",
    "  return Object.fromEntries(Object.entries(input).map(([key, value]) => {",
    "    const name = rename[key] ?? key;",
    "    return [name, json.includes(name) && typeof value === \"string\" ? JSON.parse(value) : value];",
    "  }));",
    "}",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Swift projections: App Intents, Button(intent:), Reins
// ---------------------------------------------------------------------------------------------------------------

const swiftLit = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const SWIFT_KEYWORDS = new Set(["as", "break", "case", "catch", "class", "continue", "default", "defer", "do", "else", "enum", "extension", "fallthrough", "false", "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "nil", "operator", "private", "protocol", "public", "repeat", "rethrows", "return", "self", "Self", "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where", "while"]);
const swiftId = (name: string) => (SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name);
const caseName = (v: string) => swiftId(names(v.replace(/[-/.:]/g, "_").replace(/_+/g, "_")).camel);
const enumType = (a: Action, field: string) => `${a.names.pascal}${field.charAt(0).toUpperCase()}${field.slice(1)}Value`;

/** Optional in Swift: an optional field, or a protocol-only one, which the person's doors leave nil. */
const swiftOptional = (f: Field) => f.optional === true || f.protocolOnly === true;

function swiftType(a: Action, name: string, f: Field): string {
  const base = f.kind === "string" ? "String" : f.kind === "number" ? "Double" : f.kind === "integer" ? "Int" : f.kind === "boolean" ? "Bool" : enumType(a, name);
  return swiftOptional(f) ? `${base}?` : base;
}

/** The input fields the person's doors (the App Intent and Reins) carry: every one but the protocol-only fields. */
const personFields = (a: Action) => Object.entries(a.input).filter(([, f]) => !f.protocolOnly);

function swiftStruct(a: Action, typeName: string, fields: Fields): string[] {
  // A list, group or one-of field is protocol-only, and Swift never sends it, so the Swift input leaves it out.
  const entries = Object.entries(fields).filter(([, f]) => !isStructured(f));
  const lines = [`public struct ${typeName}: Codable, Sendable, Hashable {`];
  for (const [n, f] of entries) lines.push(`    public var ${swiftId(n)}: ${swiftType(a, n, f)}`);
  const params = entries.map(([n, f]) => `${swiftId(n)}: ${swiftType(a, n, f)}${swiftOptional(f) ? " = nil" : ""}`).join(", ");
  lines.push(`    public init(${params}) {`);
  for (const [n] of entries) lines.push(`        self.${n} = ${swiftId(n)}`);
  lines.push("    }", "}");
  return lines;
}

function swiftEnums(a: Action, intent: boolean): string[] {
  const out: string[] = [];
  for (const [n, f] of Object.entries(a.input)) {
    if (f.kind !== "enum") continue;
    const t = enumType(a, n);
    out.push(`public enum ${t}: String, Codable, Sendable, Hashable, CaseIterable${intent ? ", AppEnum" : ""} {`);
    for (const v of f.values) out.push(`    case ${caseName(v)} = ${swiftLit(v)}`);
    if (intent) {
      out.push(`    public static let typeDisplayRepresentation: TypeDisplayRepresentation = ${swiftLit(f.label)}`);
      out.push(`    public static let caseDisplayRepresentations: [${t}: DisplayRepresentation] = [`);
      for (const v of f.values) out.push(`        .${caseName(v)}: ${swiftLit(v)},`);
      out.push("    ]");
    }
    out.push("}", "");
  }
  return out;
}

function renderSwift(set: ActionSet): string {
  const L: string[] = [
    `// Generated by ${GENERATOR} from the "${set.name}" action set. Don't edit; run generate.`,
    "//",
    "// Each action has an Input and an Output, a handler the app sets once at launch (`<Action>Action.perform`), and a",
    "// SwiftUI button. An agent door gets an App Intent whose perform() calls the same handler, and the button is",
    "// Button(_:intent:), so a press, Siri, Shortcuts and Reins all take one path. A person-only action gets no App",
    "// Intent, so no agent can reach it, and OuroActions.refusal(for:) answers a bridge that asks for it.",
    "import AppIntents",
    "import SwiftUI",
    "",
    "public enum OuroActionConsent: String, Sendable {",
    '    case read, write, consequential, personOnly = "person-only"',
    "}",
    "",
    "/// The typed refusal of a person-only action: the error fields of web's refused outcome (code, exit, thing,",
    "/// problem, message), plus the declaration's reason and how the person does it.",
    "public struct OuroActionRefusal: Error, Sendable, Equatable {",
    '    public let code = "person-only"',
    "    public let exit = 2",
    "    public let thing: String",
    "    public let problem: String",
    "    public let message: String",
    "    public let reason: String",
    "    public let how: String",
    "}",
    "",
    "/// An action ran before the app set its handler.",
    "public struct OuroActionNotBound: Error, Sendable, Equatable {",
    "    public let action: String",
    "}",
    "",
    `/// The "${set.name}" action set.`,
    "public enum OuroActions {",
    "    public static let consent: [String: OuroActionConsent] = [",
    ...set.actions.map((a) => `        ${swiftLit(a.id)}: .${a.consent === "person-only" ? "personOnly" : a.consent},`),
    "    ]",
    "",
    "    /// The refusal for a person-only action, by its id, kebab or camel name; nil for any other action.",
    "    public static func refusal(for action: String) -> OuroActionRefusal? {",
    "        switch action {",
  ];
  for (const a of set.actions.filter((x) => x.consent === "person-only")) {
    L.push(`        case ${swiftLit(a.id)}, ${swiftLit(a.names.kebab)}, ${swiftLit(a.names.camel)}:`);
    const r = refusal(a).error;
    L.push(`            return OuroActionRefusal(thing: ${swiftLit(r.thing)}, problem: ${swiftLit(r.problem)}, message: ${swiftLit(r.message)}, reason: ${swiftLit(a.personOnly!.reason)}, how: ${swiftLit(a.personOnly!.how)})`);
  }
  L.push("        default:", "            return nil", "        }", "    }", "}", "");

  for (const a of set.actions) {
    const P = a.names.pascal;
    const agentDoor = a.consent !== "person-only";
    L.push(`// MARK: ${a.id} (${a.consent})`, "");
    L.push(...swiftEnums(a, agentDoor));
    L.push(...swiftStruct(a, `${P}Input`, a.input), "");
    L.push(...swiftStruct(a, `${P}Output`, a.output), "");
    L.push(`/// ${a.label}: ${a.description}`);
    L.push("@MainActor", `public enum ${P}Action {`);
    L.push(`    public static let id = ${swiftLit(a.id)}`);
    L.push(`    /// The app's handler; every door calls it.`);
    L.push(`    public static var perform: (@MainActor @Sendable (${P}Input) async throws -> ${P}Output)?`);
    if (agentDoor && a.consent === "consequential") {
      L.push("    /// How the intent asks the person before it acts. Unset, the system asks. A test sets it: return to");
      L.push("    /// confirm, or throw to cancel, and the handler never runs. The app can also set it to ask in its own way.");
      L.push(`    public static var confirm: (@MainActor @Sendable (${P}Input) async throws -> Void)?`);
    }
    if (!agentDoor) L.push("    /// Called with the error when the person's press fails, since a plain button has nowhere to show it.", "    public static var failed: (@MainActor @Sendable (any Error) -> Void)?");
    else {
      L.push("    /// What Siri and Shortcuts say when the App Intent finishes or fails: the result in words, or an error turned into");
      L.push("    /// words (rethrow to let the system show it). Unset, the intent says \"Done.\" and a failure throws.");
      L.push(`    public static var dialog: (@MainActor @Sendable (${P}Input, Result<${P}Output, any Error>) async throws -> IntentDialog)?`);
    }
    L.push("");
    L.push(`    public static func run(_ input: ${P}Input) async throws -> ${P}Output {`);
    L.push(`        guard let perform else { throw OuroActionNotBound(action: id) }`);
    L.push("        return try await perform(input)", "    }", "}", "");
    const fields = personFields(a);
    if (agentDoor) {
      L.push(`public struct ${P}Intent: AppIntent {`);
      L.push(`    public static let title: LocalizedStringResource = ${swiftLit(a.label)}`);
      L.push(`    public static let description = IntentDescription(${swiftLit(a.agent)})`, "");
      if (a.opensApp) L.push("    public static let openAppWhenRun = true", "");
      const entityOf = (f: Field) => (f.kind === "string" ? f.entity : undefined);
      for (const [n, f] of fields) {
        const entity = entityOf(f);
        const ask = f.ask !== undefined ? `, requestValueDialog: ${swiftLit(f.ask)}` : "";
        const multiline = f.kind === "string" && f.multiline ? ", inputOptions: String.IntentInputOptions(multiline: true)" : "";
        L.push(`    @Parameter(title: ${swiftLit(f.label)}, description: ${swiftLit(describe(f))}${ask}${multiline})`);
        L.push(`    public var ${swiftId(n)}: ${entity ? `${entity}${f.optional ? "?" : ""}` : swiftType(a, n, f)}`);
      }
      if (fields.length) L.push("");
      L.push("    public init() {}", "");
      L.push(`    public init(_ input: ${P}Input) {`, "        self.init()");
      for (const [n, f] of fields) {
        const entity = entityOf(f);
        L.push(entity
          ? `        self.${n} = ${f.optional ? `input.${swiftId(n)}.map { ${entity}(id: $0) }` : `${entity}(id: input.${swiftId(n)})`}`
          : `        self.${n} = input.${swiftId(n)}`);
      }
      L.push("    }", "");
      L.push(`    public var input: ${P}Input {`, `        ${P}Input(${fields.map(([n, f]) => `${swiftId(n)}: ${swiftId(n)}${entityOf(f) ? `${f.optional ? "?" : ""}.id` : ""}`).join(", ")})`, "    }", "");
      const returned = Object.entries(a.output).find(([, f]) => f.returned);
      const returns = ["IntentResult", ...(returned ? [`ReturnsValue<${swiftType(a, returned[0], returned[1])}>`] : []), "ProvidesDialog"].join(" & ");
      L.push("    @MainActor", `    public func perform() async throws -> some ${returns} {`);
      if (a.consent === "consequential") L.push("        // Consequential: the person says yes before it acts.", `        if let confirm = ${P}Action.confirm { try await confirm(self.input) } else { try await requestConfirmation() }`);
      L.push("        let input = self.input", `        let result: Result<${P}Output, any Error>`);
      L.push(`        do { result = .success(try await ${P}Action.run(input)) } catch { result = .failure(error) }`);
      if (returned) {
        // A failure still throws: there is no value to hand on, and the dialog may rethrow a better error first.
        L.push(`        let said: IntentDialog = try await ${P}Action.dialog?(input, result) ?? "Done."`);
        L.push(`        return .result(value: try result.get().${swiftId(returned[0])}, dialog: said)`);
      } else {
        L.push(`        if let dialog = ${P}Action.dialog { return .result(dialog: try await dialog(input, result)) }`);
        L.push("        _ = try result.get()", '        return .result(dialog: "Done.")');
      }
      L.push("    }", "}", "");
    }
    L.push(`/// The control for ${a.id}: ${agentDoor ? "Button(_:intent:), the same intent Siri and Shortcuts run" : "a plain Button, since no agent may start it"}.`);
    L.push("@available(iOS 17.0, macOS 14.0, watchOS 10.0, tvOS 17.0, *)");
    L.push(`public struct ${P}Button<Label: View>: View {`);
    L.push(`    public let input: ${P}Input`, "    let label: Label", "");
    L.push(`    public init(_ input: ${P}Input, @ViewBuilder label: () -> Label) {`, "        self.input = input", "        self.label = label()", "    }", "");
    L.push("    public var body: some View {");
    if (agentDoor) L.push(`        Button(intent: ${P}Intent(input)) { label }`);
    else L.push(`        Button { Task { do { _ = try await ${P}Action.run(input) } catch { ${P}Action.failed?(error) } } } label: { label }`);
    L.push(`            .accessibilityHint(Text(verbatim: ${swiftLit(a.description)}))`, "    }", "}", "");
    L.push("@available(iOS 17.0, macOS 14.0, watchOS 10.0, tvOS 17.0, *)");
    L.push(`extension ${P}Button where Label == Text {`);
    L.push(`    public init(_ input: ${P}Input) {`, `        self.init(input) { Text(verbatim: ${swiftLit(a.label)}) }`, "    }", "}", "");
  }
  return `${L.join("\n").replace(/\n+$/, "")}\n`;
}

function reinsSchema(a: Action, f: Field): string {
  if (f.kind === "enum") return `.oneOf([${f.values.map(swiftLit).join(", ")}])`;
  return f.kind === "boolean" ? ".boolean" : `.${f.kind}`;
}

function renderReins(set: ActionSet): string {
  const L: string[] = [
    `// Generated by ${GENERATOR} from the "${set.name}" action set. Don't edit; run generate.`,
    "//",
    "// Reins actions from the same declarations: each calls the handler a press and an App Intent call. Reins is the",
    "// test door that stands in for the person's finger, so person-only actions are here too.",
    "import OuroReins",
    "",
  ];
  for (const a of set.actions) {
    const P = a.names.pascal;
    const fields = personFields(a);
    const props = fields.map(([n, f]) => `${swiftLit(n)}: ${reinsSchema(a, f)}`).join(", ");
    const required = fields.filter(([, f]) => !f.optional).map(([n]) => swiftLit(n)).join(", ");
    L.push(`extension ${P}Input: ReinsInput {`);
    L.push(`    public static var reinsSchema: ReinsSchema { .object(properties: [${props || ":"}], required: [${required}]) }`, "}", "");
  }
  L.push("extension ReinsAction {");
  for (const a of set.actions) {
    const P = a.names.pascal;
    L.push(`    /// ${a.label}: ${a.description}`);
    L.push(`    public static func ${a.names.camel}() -> ReinsAction {`);
    L.push(`        ReinsAction(${swiftLit(a.names.camel)}, ${swiftLit(a.label)}, input: ${P}Input.self) { input in _ = try await ${P}Action.run(input) }`);
    L.push("    }", "");
  }
  L[L.length - 1] = "}";
  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Every projection, the drift check and the live comparison
// ---------------------------------------------------------------------------------------------------------------

/** Every file generate writes, by name. Deterministic: the same set renders the same bytes. */
export function renderActions(set: ActionSet): Map<string, string> {
  const files = new Map<string, string>();
  files.set("actions.json", json({ ...header(set), tool: set.tool, actions: set.actions.map(({ names: _n, cliWords: _c, ...def }) => def) }));
  files.set("commands.json", json({ ...header(set), tool: set.tool, commands: agentDoors(set).map(toCommand), personOnly: Object.fromEntries(set.actions.filter((a) => a.consent === "person-only").map((a) => [a.cliWords, { reason: a.personOnly!.reason, how: a.personOnly!.how }])) }));
  files.set("mcp.json", json({ ...header(set), tools: agentDoors(set).map(toMcpTool), refusals: refusals(set) }));
  files.set("webmcp.json", json({ ...header(set), tools: agentDoors(set).map(toWebMcpTool), refusals: refusals(set) }));
  files.set("web.ts", renderWeb(set));
  files.set("OuroActions.swift", renderSwift(set));
  files.set("OuroActionsReins.swift", renderReins(set));
  return files;
}

/** Every way `found` differs from what the set generates: a missing, extra or different file, at its first differing line. `only` checks just those files. */
/** A projection without its generator's version, so files a newer ouro-actions would stamp differently still match. */
const unstamped = (text: string) => text.replace(/\bouro-actions \d+\.\d+\.\d+\b/g, "ouro-actions");

export function checkGenerated(set: ActionSet, found: ReadonlyMap<string, string>, only?: ReadonlySet<string>): string[] {
  const expected = renderActions(set);
  const problems: string[] = [];
  for (const [path, text] of expected) {
    if (only && !only.has(path)) continue;
    const have = found.get(path);
    if (have === undefined) {
      problems.push(`${path}: missing. Fix: run generate.`);
      continue;
    }
    if (have === text || unstamped(have) === unstamped(text)) continue;
    const a = text.split("\n");
    const b = have.split("\n");
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    problems.push(`${path}:${i + 1}: drifted from its declaration: expected ${JSON.stringify(a[i] ?? "<end of file>")}, found ${JSON.stringify(b[i] ?? "<end of file>")}. Fix: change the declaration and run generate; never edit a generated file.`);
  }
  for (const path of found.keys()) if (!expected.has(path)) problems.push(`${path}: not generated from any declaration. Fix: delete it, or declare what it holds.`);
  return problems;
}

const MCP_HINT_DEFAULTS: Readonly<Record<string, boolean>> = Object.freeze({ readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false });
const sortKeys = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));

/**
 * Every way a live MCP server's tools differ from the declarations: a declared tool missing or with another
 * description, input schema or annotations; a person-only action listed as a tool; a tool nobody declared. `tools` is
 * a `tools/list` result (`{ tools: [...] }`) or its array.
 */
export function compareMcp(set: ActionSet, tools: unknown, options: { undeclared?: readonly string[] } = {}): string[] {
  const list = Array.isArray(tools) ? tools : (tools as { tools?: unknown })?.tools;
  if (!Array.isArray(list)) return ["tools: is not a tools/list result. Fix: pass the server's tools/list result, { tools: [...] }."];
  const live = new Map<string, Record<string, unknown>>();
  const problems: string[] = [];
  list.forEach((t: unknown, i: number) => {
    if (typeof t !== "object" || t === null || typeof (t as Record<string, unknown>)["name"] !== "string") return void problems.push(`tools[${i}]: is not a tool with a name. Fix: serve each tool as { name, description, inputSchema, annotations }.`);
    const name = (t as { name: string }).name;
    if (live.has(name)) problems.push(`${name}: the server lists it twice. Fix: list each tool once.`);
    live.set(name, t as Record<string, unknown>);
  });
  for (const a of set.actions) {
    const t = live.get(a.id);
    if (a.consent === "person-only") {
      if (t) problems.push(`${a.id}: is person-only but the server lists it as a tool. Fix: unlist it; a call answers the refusal in mcp.json.`);
      continue;
    }
    if (!t) {
      problems.push(`${a.id}: declared but the server doesn't list it. Fix: serve the tool from mcp.json.`);
      continue;
    }
    const want = toMcpTool(a);
    if (t["description"] !== want.description) problems.push(`${a.id}: description drifted: expected ${JSON.stringify(want.description)}, found ${JSON.stringify(t["description"])}. Fix: serve the declaration's agent description.`);
    if (!same(t["inputSchema"], want.inputSchema)) problems.push(`${a.id}: input schema drifted: expected ${JSON.stringify(sortKeys(want.inputSchema))}, found ${JSON.stringify(sortKeys(t["inputSchema"]))}. Fix: serve the declaration's input schema.`);
    const ann = (t["annotations"] ?? {}) as Record<string, unknown>;
    // A missing hint means MCP's default, which a client acts on: readOnlyHint false, destructiveHint and openWorldHint true.
    const wanted = want.annotations as unknown as Record<string, boolean | undefined>;
    for (const [k, fallback] of Object.entries(MCP_HINT_DEFAULTS)) if ((ann[k] ?? fallback) !== (wanted[k] ?? fallback)) problems.push(`${a.id}: annotation ${k} is ${k in ann ? JSON.stringify(ann[k]) : `missing (MCP's default, ${MCP_HINT_DEFAULTS[k]})`}, the declaration (consent "${a.consent}"${a.destructive ? ", destructive" : ""}${a.idempotent ? ", idempotent" : ""}) says ${wanted[k] ?? fallback}. Fix: serve the declaration's annotations.`);
  }
  // An app moving onto actions one tool at a time names the tools it hasn't declared yet. The list can only shrink: a
  // name on it that is now declared, or no longer served, is a problem too.
  const undeclared = new Set(options.undeclared ?? []);
  for (const name of live.keys()) if (!set.actions.some((a) => a.id === name) && !undeclared.has(name)) problems.push(`${name}: the server lists a tool no declaration has. Fix: declare it with defineAction.`);
  for (const name of undeclared) {
    if (set.actions.some((a) => a.id === name)) problems.push(`${name}: is declared, so it isn't undeclared any more. Fix: take it off the undeclared list.`);
    else if (!live.has(name)) problems.push(`${name}: is on the undeclared list but the server doesn't list it. Fix: take it off the undeclared list.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The report: what `check --report` writes, in the shape of the Ouro AX X-ray's report.json
// ---------------------------------------------------------------------------------------------------------------

/** One claim of the action claim set (standard/ax/actions.claims.json), as the report needs it. */
export interface ReportClaim {
  id: string;
  tier: "must" | "should";
  rule: string;
}

export interface ActionsReport {
  tool: "ouro-actions";
  checker: { version: string };
  at: string;
  claimSet: { name: "actions"; version: string };
  target: { app: { name: string }; set: string; commit: string | null };
  summary: { claims: number; holding: number; must: number; mustHolding: number; checks: number };
  claims: { id: string; tier: "must" | "should"; holds: boolean; problems: string[] }[];
}

const parseJson = (text: string | undefined): Record<string, unknown> | null => {
  if (text === undefined) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const toolsOf = (doc: Record<string, unknown> | null): Record<string, unknown>[] => (Array.isArray(doc?.["tools"]) ? (doc!["tools"] as Record<string, unknown>[]) : []);
const hintsOf = (doc: Record<string, unknown> | null, name: string): Record<string, unknown> | null => {
  const tool = toolsOf(doc).find((t) => t["name"] === name);
  return tool && typeof tool["annotations"] === "object" ? (tool["annotations"] as Record<string, unknown>) : null;
};
const has = (doc: Record<string, unknown> | null, key: string, name: string) => Boolean(doc && typeof doc[key] === "object" && doc[key] !== null && name in (doc[key] as object));

/**
 * Proves the action claim set's claims on a set's committed projections (the folder `generate` wrote), each from what
 * the files say: projections that equal their declaration; person-only actions offered on no agent door and refused on
 * each; consequential actions marked so on every door, and confirmed in the App Intent. The result is shaped like the
 * Ouro AX X-ray's report.json, so CI uploads it beside an X-ray report and the adoption ledger reads both.
 */
export function actionsReport(set: ActionSet, found: ReadonlyMap<string, string>, claims: readonly ReportClaim[], options: { claimSetVersion: string; app?: string; commit?: string | null; now?: () => Date }): ActionsReport {
  const mcp = parseJson(found.get("mcp.json"));
  const webmcp = parseJson(found.get("webmcp.json"));
  const commands = parseJson(found.get("commands.json"));
  const swift = found.get("OuroActions.swift");
  const commandOf = (a: Action) => (Array.isArray(commands?.["commands"]) ? (commands!["commands"] as Record<string, unknown>[]) : []).find((c) => c["name"] === a.cliWords);
  const proofs: Record<string, () => string[]> = {
    "action.projections-match": () => checkGenerated(set, found),
    "action.one-declaration": () => checkGenerated(set, found).length ? [`the committed projections are not all generated from ${set.name}'s declarations. Fix: run generate.`] : [],
    "action.person-only-refuses": () =>
      set.actions.filter((a) => a.consent === "person-only").flatMap((a) => [
        ...(toolsOf(mcp).some((t) => t["name"] === a.id) ? [`${a.id}: mcp.json offers it as a tool. Fix: run generate.`] : []),
        ...(toolsOf(webmcp).some((t) => t["name"] === a.id) ? [`${a.id}: webmcp.json offers it as a tool. Fix: run generate.`] : []),
        ...(has(mcp, "refusals", a.id) ? [] : [`${a.id}: mcp.json does not refuse it. Fix: run generate.`]),
        ...(has(webmcp, "refusals", a.id) ? [] : [`${a.id}: webmcp.json does not refuse it. Fix: run generate.`]),
        ...(has(commands, "personOnly", a.cliWords) && !commandOf(a) ? [] : [`${a.id}: commands.json does not refuse "${a.cliWords}". Fix: run generate.`]),
        ...(swift !== undefined && swift.includes(`struct ${a.names.pascal}Intent:`) ? [`${a.id}: OuroActions.swift has an App Intent for it. Fix: run generate.`] : []),
      ]),
    "action.consequential-confirms": () =>
      set.actions.filter((a) => a.consent === "consequential").flatMap((a) => {
        const swiftIntent = swift === undefined ? null : swift.slice(swift.indexOf(`struct ${a.names.pascal}Intent:`), swift.indexOf("\n}\n", swift.indexOf(`struct ${a.names.pascal}Intent:`)));
        return [
          ...(hintsOf(mcp, a.id)?.["destructiveHint"] === true ? [] : [`${a.id}: mcp.json does not mark it destructive. Fix: run generate.`]),
          ...(hintsOf(webmcp, a.id)?.["consequentialHint"] === true ? [] : [`${a.id}: webmcp.json does not mark it consequential. Fix: run generate.`]),
          ...(commandOf(a)?.["effect"] === "others" ? [] : [`${a.id}: commands.json does not give "${a.cliWords}" the effect "others", so the CLI does not ask for --why. Fix: run generate.`]),
          ...(swiftIntent === null || swiftIntent.includes("requestConfirmation()") ? [] : [`${a.id}: its App Intent does not call requestConfirmation. Fix: run generate.`]),
        ];
      }),
    "action.agent-description": () => set.actions.filter((a) => !a.agent?.trim()).map((a) => `${a.id}: has no agent description. Fix: write one line for a model in agent.`),
  };
  const results = claims.map((c) => {
    const problems = proofs[c.id]?.() ?? [`no check in ouro-actions ${ACTIONS_VERSION} proves ${c.id}. Fix: use the ouro-actions from the same core release as the claim set.`];
    return { id: c.id, tier: c.tier, holds: problems.length === 0, problems };
  });
  const musts = results.filter((r) => r.tier === "must");
  return {
    tool: "ouro-actions",
    checker: { version: ACTIONS_VERSION },
    at: (options.now ?? (() => new Date()))().toISOString(),
    claimSet: { name: "actions", version: options.claimSetVersion },
    target: { app: { name: options.app ?? set.tool ?? set.name }, set: set.name, commit: options.commit ?? null },
    summary: { claims: results.length, holding: results.filter((r) => r.holds).length, must: musts.length, mustHolding: musts.filter((r) => r.holds).length, checks: results.length },
    claims: results,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The CLI
// ---------------------------------------------------------------------------------------------------------------

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

async function loadSet(path: string): Promise<ActionSet> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as { default?: ActionSet };
  const set = mod.default;
  if (!set || !Array.isArray(set.actions) || typeof set.name !== "string") throw new Error(`${path}: has no default export from defineActions. Fix: export default defineActions("<name>", [ ... ]).`);
  return set;
}

async function readDir(dir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return found;
  }
  for (const name of entries.sort()) {
    if (name.startsWith(".")) continue;
    const text = await readFile(join(dir, name), "utf8").catch((error: { code?: string }) => (error.code === "EISDIR" ? null : Promise.reject(error)));
    if (text !== null) found.set(name, text);
  }
  return found;
}

const USAGE = "usage: node ouro-actions.mts generate <actions.mts> <dir> [--targets <names>] | check <actions.mts> <dir> [--targets <names>] [--report <report.json> [--claims <actions.claims.json>] [--app <name>] [--commit <sha>]] | compare-mcp <actions.mts> <tools.json> [--undeclared <names.json>]";

const REPORT_FLAGS = ["--report", "--claims", "--app", "--commit", "--targets"];

/** The projections `--targets` names, by the short name a person types (`mcp,actions`), and the file each writes. */
export const PROJECTIONS: Readonly<Record<string, string>> = Object.freeze({
  actions: "actions.json",
  commands: "commands.json",
  mcp: "mcp.json",
  webmcp: "webmcp.json",
  web: "web.ts",
  swift: "OuroActions.swift",
  reins: "OuroActionsReins.swift",
});

/** The files a `--targets` list names, or every file when it is absent. Unknown names fail with the list of names. */
export function targetFiles(targets: string | undefined): Set<string> | undefined {
  if (targets === undefined) return undefined;
  const names = targets.split(",");
  const unknown = names.filter((n) => !(n in PROJECTIONS));
  if (unknown.length || names.length === 0) throw new Error(`--targets: ${unknown.length ? unknown.join(", ") : "is empty"} is not a projection. Fix: use any of ${Object.keys(PROJECTIONS).join(", ")}.`);
  return new Set(names.map((n) => PROJECTIONS[n]!));
}

/** check's options after its two arguments: each of --report, --claims, --app and --commit at most once with a value; null when they are not. */
function reportOptions(rest: readonly string[]): Record<string, string> | null {
  const options: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i]!, rest[i + 1]];
    if (!REPORT_FLAGS.includes(flag) || value === undefined || flag in options) return null;
    options[flag] = value;
  }
  const keys = Object.keys(options);
  return keys.length && !("--report" in options) && keys.some((k) => k !== "--targets") ? null : options;
}

/** Runs the CLI; returns the exit code: 0 clean, 1 drift, 2 usage. */
export async function main(argv: readonly string[], io: { out(s: string): void; err(s: string): void }): Promise<number> {
  const [cmd, declarations, target, flag, flagValue, ...rest] = argv;
  const report = cmd === "check" ? reportOptions(argv.slice(3)) : null;
  const flagOk = flag === undefined || (cmd === "compare-mcp" && flag === "--undeclared" && flagValue !== undefined && rest.length === 0) || (cmd === "generate" && flag === "--targets" && flagValue !== undefined && rest.length === 0) || report !== null;
  if (!cmd || !declarations || !target || !["generate", "check", "compare-mcp"].includes(cmd) || !flagOk) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const set = await loadSet(declarations);
  let only: Set<string> | undefined;
  try {
    only = cmd === "generate" ? targetFiles(flag === "--targets" ? flagValue : undefined) : targetFiles(report?.["--targets"]);
  } catch (e) {
    io.err(`ouro-actions: ${(e as Error).message}\n`);
    return 2;
  }
  if (cmd === "generate") {
    await mkdir(target, { recursive: true });
    const files = renderActions(set);
    for (const [path, text] of files) if (!only || only.has(path)) await writeFile(join(target, path), text);
    io.out(`ouro-actions: wrote ${only ? only.size : files.size} files for ${count(set.actions.length, "action")} into ${target}.\n`);
    return 0;
  }
  if (cmd === "check") {
    const found = await readDir(target);
    const problems = checkGenerated(set, found, only);
    for (const p of problems) io.err(`ouro-actions: ${p}\n`);
    if (report?.["--report"]) {
      const claimsPath = report["--claims"] ?? fileURLToPath(new URL("./actions.claims.json", import.meta.url));
      const claimSet = JSON.parse(await readFile(claimsPath, "utf8")) as { version: string; claims: ReportClaim[] };
      const written = actionsReport(set, found, claimSet.claims, { claimSetVersion: claimSet.version, app: report["--app"], commit: report["--commit"] ?? null });
      await mkdir(dirname(resolve(report["--report"])), { recursive: true });
      await writeFile(report["--report"], `${JSON.stringify(written, null, 2)}\n`);
      const { must, mustHolding, claims, holding } = written.summary;
      io.out(`ouro-actions: ${mustHolding} of ${must} must claims and ${holding} of ${claims} claims hold; wrote ${report["--report"]}.\n`);
      const broken = written.claims.filter((c) => c.tier === "must" && !c.holds);
      for (const c of broken) io.err(`ouro-actions: must claim ${c.id} does not hold: ${c.problems[0] ?? "no proof in this ouro-actions"}. See ${report["--report"]}.\n`);
      if (broken.length) return 1;
    }
    if (problems.length) return 1;
    io.out(`ouro-actions: ${count(set.actions.length, "action")}, every projection matches its declaration.\n`);
    return 0;
  }
  let undeclared: string[] | undefined;
  if (flagValue !== undefined) {
    const names: unknown = JSON.parse(await readFile(flagValue, "utf8"));
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
      io.err(`ouro-actions: ${flagValue}: is not a JSON array of tool names. Fix: ["get_recipe", "create_recipe"].\n`);
      return 2;
    }
    undeclared = names;
  }
  const problems = compareMcp(set, JSON.parse(await readFile(target, "utf8")), { undeclared });
  for (const p of problems) io.err(`ouro-actions: ${p}\n`);
  if (problems.length) return 1;
  io.out(`ouro-actions: ${count(set.actions.length, "action")}, the live tools match their declarations.\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`ouro-actions: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    },
  );
}
