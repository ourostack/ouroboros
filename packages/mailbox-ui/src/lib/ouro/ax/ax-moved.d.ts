declare module "#ouro-ax/command.ts" {
  // An import of a file that moved fails here, and the error names the new path. Apps delete the old file, so the import resolves to these declarations.
  export const AGENT_FLAG: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const argUsage: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const BUILTIN_FLAGS: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const checkInput: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const checkOwner: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const commandWords: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const defineCli: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const defineCommand: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const exampleArgv: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const findCommand: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const flagsOf: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const flagUsage: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const inputSchema: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const invocation: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const parse: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const toArgv: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export const usageOf: { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };

  export type ArgSpec = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type Cli<C = unknown> = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never; readonly context?: C };
  export type CliDef<C = unknown> = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never; readonly context?: C };
  export type CommandDef<R = unknown, C = unknown> = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never; readonly result?: R; readonly context?: C };
  export type FlagSpec = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type FlagType = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type HelpAsked = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type Input = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type InputValue = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type JsonSchema = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type Meaning = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type Parsed = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type PersonOnly = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type RunContext = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never };
  export type SelfScope<C = unknown> = { "Moved: import from #ouro-ax/ax-command.ts (#2757)": never; readonly context?: C };
}

declare module "#ouro-ax/claims.ts" {
  export const checkClaimSet: { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export const CLAIM_SCOPES: { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export const CLAIM_SET: { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export const CLAIM_SET_VERSION: { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export const claimSetText: { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export const loadClaimSet: { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };

  export type Claim = { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export type ClaimEvidence = { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export type ClaimScope = { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export type ClaimSet = { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export type ClaimSurface = { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
  export type ClaimTier = { "Moved: import from #ouro-ax/ax-claims.ts (#2757)": never };
}
