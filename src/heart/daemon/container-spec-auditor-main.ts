import * as fs from "node:fs"
import { emitNervesEvent } from "../../nerves/runtime"
import { auditSanctuaryContainerSpec } from "./container-spec-auditor"

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
  const inspectPath = valueAfter(args, "--inspect")
  const expectedImage = valueAfter(args, "--expected-image")
  if (!inspectPath || !expectedImage || args.length !== 4) {
    write(JSON.stringify({ ok: false, error: "usage: --inspect <path> --expected-image <digest>" }) + "\n")
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.container_spec_auditor_cli_error",
      message: "container spec auditor arguments were invalid",
      meta: { argumentCount: args.length },
    })
    return 2
  }
  let value: unknown
  try {
    value = JSON.parse(readFile(inspectPath))
  } catch (error) {
    write(JSON.stringify({ ok: false, error: "inspect payload is unreadable JSON" }) + "\n")
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.container_spec_auditor_cli_error",
      message: "container spec auditor could not read inspect JSON",
      meta: { reason: error instanceof Error ? error.message : String(error) },
    })
    return 2
  }
  const result = auditSanctuaryContainerSpec(value, { expectedImage })
  write(JSON.stringify(result) + "\n")
  return result.ok ? 0 : 1
}

if (require.main === module) {
  process.exitCode = runContainerSpecAuditorCli(process.argv.slice(2))
}
