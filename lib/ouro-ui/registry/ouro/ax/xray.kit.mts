export { CLAIM_SET, claimSetText, type Claim, type ClaimSurface } from "#ouro-ax/claims.ts";
export { isChecksReport, type ChecksReport } from "#ouro-ax/checks.ts";
export { isReservedPersonOnly, type UiEntry } from "#ouro-ax/component.ts";
export { devCommandIn, devCommandsIn, sourceCheckoutTexts } from "#ouro-ax/dev-commands.ts";
export { checkFailureCopyAllow, vagueFailureIn, vagueFailuresIn, type FailureCopyAllow } from "#ouro-ax/precise-copy.ts";
export { isGenericAudience, isOutcome, validateOutcome } from "#ouro-ax/outcome.ts";
export { hasAnsi, stripAnsi } from "#ouro-ax/terminal.ts";
export { isWait, validateWait } from "#ouro-ax/wait.ts";
export { checkWorkEvent } from "#ouro-ax/work-event.ts";
export { quietPipes, runCli } from "#ouro-ax/cli.ts";
export { defineCli, defineCommand, parse, type FlagSpec, type Input } from "#ouro-ax/command.ts";
export { defineExitCodes } from "#ouro-ax/exit-codes.ts";
export { AxError, isAxError, shellWord } from "#ouro-ax/problem.ts";

// The shared Ouro AX files xray.ts runs on, by the package's imports entry (#ouro-ax/*). They are named here, in an .mts
// file, because the shadcn CLI rewrites a # import in a .ts, .tsx, .js or .jsx file it installs to the app's own path
// alias (~/lib/ouro/ax/cli), which Node cannot resolve; it leaves an .mts file as it is. The export list comes first
// because the CLI drops comments before a file's first statement.
