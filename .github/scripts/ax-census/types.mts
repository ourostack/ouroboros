// The Ouro AX census's shapes. Design: the AX census design, sections 2 to 4. No logic lives here.

/** The consent classes ouro-actions already uses. */
export type Consent = "read" | "write" | "consequential" | "person-only";

/** What can go wrong at a door, as the agent reads it. */
export interface ErrorCard {
  code: string;
  means: string;
  fix: string;
}

/** A namespace an agent loads doors in, with the one line that says when to load it. */
export interface GroupCard {
  id: string;
  when: string;
}

/** The declaration of one agent door. */
export interface DoorCard {
  /** `<kind>:<name>`, such as `mcp:ask`. */
  id: string;
  /** The id of a group card. */
  group: string;
  /** One line: when an agent should pick this door over its neighbours. */
  when: string;
  effect: Consent;
  errors: readonly ErrorCard[];
  aliases?: readonly string[];
  destructive?: true;
  idempotent?: true;
  /** Required for consequential: the approval question, word for word. */
  confirm?: string;
  /** Keep the door loaded up front in a tool catalog; the default is deferred. */
  eager?: true;
}

/** What the code itself says about a door's effect. */
export interface DoorEvidence {
  readOnly?: boolean;
  mutates?: string;
  approval?: boolean;
  /** The card's error codes that appear as literals in the door's handler file outside any card; absent when the walker can't tell. */
  raises?: string[];
  /** CLI: whether running the parser over the path returned a kind its parent path doesn't (false: it never returned). */
  confirmed?: boolean;
  /** CLI: the command kinds the path reaches. */
  kinds?: string[];
}

/** One door a walker found. `file` and `line` point at source, never at built output; `line` is null when the name isn't a literal. */
export interface Door {
  id: string;
  kind: "mcp" | "cli" | "tool" | "approval";
  product: string;
  name: string;
  description: string;
  file: string;
  line: number | null;
  card: DoorCard | null;
  evidence: DoorEvidence;
  /** Other names that reach the same door, such as `down` for `stop`; not doors of their own. */
  aliases?: string[];
  /** The door whose card declares this one, such as `tool:shell` for the approval prompt `approval:shell`. */
  declaredBy?: string;
  /** The walker that found the door; the child sets it. */
  walker?: string;
}

/** A door that counts against zero, as the report lists it. */
export interface Gap {
  id: string;
  kind: string;
  file: string;
  line: number | null;
  walker?: string;
  reasons?: string[];
}

export interface Counts {
  found: number;
  declared: number;
  weak: number;
  undeclared: number;
  /** Code of this kind the walkers saw but couldn't walk to a door. */
  unwalked: number;
}

export interface ProductReport {
  product: string;
  walked: { kinds: string[]; finders: string[] };
  summary: Counts & { stale: number; excluded: number; baseline: number };
  byKind: Record<string, Counts>;
  undeclared: Gap[];
  weak: Gap[];
  unwalked: Gap[];
  excluded: { hit: string; category: string }[];
}

export interface CensusReport {
  ax: "census/1";
  tool: "ouro-census";
  checker: { version: string; sha256: string };
  target: { repo: string | null; ref: string | null; commit: string | null };
  at: string;
  products: ProductReport[];
}

/** What a walker returns: the doors it found and the census errors it hit (such as a name listed twice). */
export interface WalkResult {
  doors: Door[];
  errors: string[];
  /** Code the walker saw but couldn't walk to a door, such as a command kind no walked path returns. Each counts against zero. */
  unwalked?: Gap[];
  /** Code left out under one of the closed exclusion categories, each with the census's own proof (design section 6). */
  excluded?: { hit: string; category: string }[];
}

/** Where a walker reads from, as one source in `ax/census.config.json` names it. */
export interface WalkerOptions {
  product: string;
  module: string;
  source: string;
  root: string;
  /** ts-parser: the parser function's name, exported by `module` and declared in `source`. */
  parser?: string;
  /** ts-parser: the command type to cross-check, as `<file>#<type alias>`. */
  kinds?: string;
  /** CLI walkers: the built declarations that hold the doors' cards, as `<module>#<export>`. */
  cards?: string;
  /** CLI walkers: files that raise error codes for every command (the dispatcher, the gate), beside each door's own. */
  handlers?: string[];
  /** argv-entries: entry modules another walker covers, each with the parser source it must import. */
  claims?: { entry: string; parser: string }[];
  /** tool-schemas: functions that build tools from a connected server's list, as `<file>#<function>`. */
  passthrough?: string[];
  /** tool-schemas: functions that decide approval apart from a tool's policy, as `<file>#<function>`. */
  approvals?: string[];
  /** tool-schemas: functions that re-encode tools the census already counts in another wire shape, as `<file>#<function>`. */
  reshape?: string[];
}

export type Walker = (options: WalkerOptions) => Promise<WalkResult>;
