export { quietPipes, runCli, type CliIo } from "#ouro-ax/cli.ts";
export { defineCli, defineCommand, type Cli, type CommandDef, type FlagSpec, type Input } from "#ouro-ax/ax-command.ts";
export { outcome, type Outcome } from "#ouro-ax/outcome.ts";
export { AxError, commandLine } from "#ouro-ax/problem.ts";

// The shared Ouro AX files flows.ts runs on, by the package's imports entry (#ouro-ax/*). They are named here, in an .mts
// file, because the shadcn CLI rewrites a # import in a .ts, .tsx, .js or .jsx file it installs to the app's own path
// alias (~/lib/ouro/ax/cli), which Node cannot resolve; it leaves an .mts file as it is. The export list comes first
// because the CLI drops comments before a file's first statement.
