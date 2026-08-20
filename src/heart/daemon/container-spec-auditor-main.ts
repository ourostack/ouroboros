import * as fs from "node:fs"
import { emitNervesEvent } from "../../nerves/runtime"
import { auditSanctuaryStagedFiles } from "./container-spec-auditor"

export interface ContainerSpecAuditorCliDeps {
  readFile?: (filePath: string) => string
  write?: (text: string) => void
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index >= 0 ? args[index + 1] : undefined
}

export function runContainerSpecAuditorCli(args: string[], deps: ContainerSpecAuditorCliDeps = {}): number {
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"))
  const write = deps.write ?? ((text: string) => process.stdout.write(text))
  const templatePath = valueAfter(args, "--template")
  const runtimePolicyPath = valueAfter(args, "--runtime-policy")
  const expectedImage = valueAfter(args, "--expected-image")
  if (!templatePath || !runtimePolicyPath || !expectedImage || args.length !== 6) {
    write(JSON.stringify({ ok: false, error: "usage: --template <path> --runtime-policy <path> --expected-image <digest>" }) + "\n")
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.container_spec_auditor_cli_error",
      message: "container spec auditor arguments were invalid",
      meta: { argumentCount: args.length },
    })
    return 2
  }
  let templateXml: string
  let runtimePolicyText: string
  try {
    templateXml = readFile(templatePath)
    runtimePolicyText = readFile(runtimePolicyPath)
  } catch (error) {
    write(JSON.stringify({ ok: false, error: "staged audit inputs are unreadable" }) + "\n")
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.container_spec_auditor_cli_error",
      message: "container spec auditor could not read staged files",
      meta: { reason: error instanceof Error ? error.message : String(error) },
    })
    return 2
  }
  const result = auditSanctuaryStagedFiles({ templateXml, runtimePolicyText, expectedImage })
  write(JSON.stringify(result) + "\n")
  return result.ok ? 0 : 1
}

/* v8 ignore next 3 -- exercised by the packaged auditor CLI entrypoint */
if (require.main === module) {
  process.exitCode = runContainerSpecAuditorCli(process.argv.slice(2))
}
