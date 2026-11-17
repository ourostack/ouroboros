export { devCommandIn } from "#ouro-ax/dev-commands.ts";
export { FINDINGS_EXIT_CODE } from "#ouro-ax/exit-codes.ts";
export { errorMessage } from "#ouro-ax/problem.ts";

// The shared Ouro AX files surfaces.ts runs on, by the package's imports entry (#ouro-ax/*). They are named here, in an .mts
// file, because the shadcn CLI rewrites a # import in a .ts, .tsx, .js or .jsx file it installs to the app's own path
// alias (~/lib/ouro/ax/cli), which Node cannot resolve; it leaves an .mts file as it is. The export list comes first
// because the CLI drops comments before a file's first statement.
