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
}

/** One door a walker found. `file` and `line` point at source, never at built output; `line` is null when the name isn't a literal. */
export interface Door {
  id: string;
  kind: "mcp";
  product: string;
  name: string;
  description: string;
  file: string;
  line: number | null;
  card: DoorCard | null;
  evidence: DoorEvidence;
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
}

export interface ProductReport {
  product: string;
  walked: { kinds: string[]; finders: string[] };
  summary: Counts & { unwalked: number; stale: number; excluded: number; baseline: number };
  byKind: Record<string, Counts>;
  undeclared: Gap[];
  weak: Gap[];
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
}

/** Where a walker reads from, as one source in `ax/census.config.json` names it. */
export interface WalkerOptions {
  product: string;
  module: string;
  source: string;
  root: string;
}

export type Walker = (options: WalkerOptions) => Promise<WalkResult>;
