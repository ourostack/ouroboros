import * as fs from "node:fs"
import { emitNervesEvent } from "../../nerves/runtime"
import { auditSanctuaryContainerSpec, auditSanctuaryStagedFiles } from "./container-spec-auditor"

export interface ContainerSpecAuditorCliDeps {
  readFile?: (filePath: string) => string
  write?: (text: string) => void
}

function parseModeArguments(args: string[], flags: readonly string[]): Record<string, string> | null {
  if (args.length !== flags.length * 2) return null
  const allowed = new Set(flags)
  const parsed: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!allowed.has(flag!) || Object.prototype.hasOwnProperty.call(parsed, flag!) || !value) return null
    parsed[flag!] = value
  }
  return parsed
}

function parseSingleInspect(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value) || value.length !== 1) return null
    const item = value[0]
    if (!item || typeof item !== "object" || Array.isArray(item)) return null
    return item as Record<string, unknown>
  } catch {
    return null
  }
}

export function runContainerSpecAuditorCli(args: string[], deps: ContainerSpecAuditorCliDeps = {}): number {
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath, "utf8"))
  const write = deps.write ?? ((text: string) => process.stdout.write(text))
  const staged = parseModeArguments(args, ["--template", "--runtime-policy", "--expected-image"])
  const effective = parseModeArguments(args, ["--inspect", "--image-inspect", "--expected-image"])
  const legacyCandidate = parseModeArguments(args, ["--inspect", "--image-inspect", "--expected-image", "--mount-contract"])
  const legacyEffective = legacyCandidate?.["--mount-contract"] === "legacy-alpha742" ? legacyCandidate : null
  const selectedEffective = effective ?? legacyEffective
  if (!staged && !selectedEffective) {
    write(JSON.stringify({ ok: false, error: "usage: staged --template <path> --runtime-policy <path> --expected-image <id>; effective --inspect <path> --image-inspect <path> --expected-image <id> [--mount-contract legacy-alpha742]" }) + "\n")
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.container_spec_auditor_cli_error",
      message: "container spec auditor arguments were invalid",
      meta: { argumentCount: args.length },
    })
    return 2
  }

  if (selectedEffective) {
    let containerText: string
    let imageText: string
    try {
      containerText = readFile(selectedEffective["--inspect"]!)
      imageText = readFile(selectedEffective["--image-inspect"]!)
    } catch (error) {
      write(JSON.stringify({ ok: false, error: "effective audit inputs are unreadable" }) + "\n")
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.container_spec_auditor_cli_error",
        message: "container spec auditor could not read effective inputs",
        meta: { reason: error instanceof Error ? error.message : String(error) },
      })
      return 2
    }
    const containerInspect = parseSingleInspect(containerText)
    const imageInspect = parseSingleInspect(imageText)
    const imageConfig = imageInspect?.Config
    const expectedEnvironment = imageConfig && typeof imageConfig === "object" && !Array.isArray(imageConfig)
      ? (imageConfig as Record<string, unknown>).Env
      : null
    if (!containerInspect || !imageInspect || !Array.isArray(expectedEnvironment) || !expectedEnvironment.every((entry) => typeof entry === "string")) {
      write(JSON.stringify({ ok: false, error: "effective audit inputs must each contain exactly one canonical inspect record" }) + "\n")
      emitNervesEvent({
        level: "error",
        component: "daemon",
        event: "daemon.container_spec_auditor_cli_error",
        message: "container spec auditor effective inputs were invalid",
        meta: { containerValid: !!containerInspect, imageValid: !!imageInspect },
      })
      return 2
    }
    const result = auditSanctuaryContainerSpec(containerInspect, {
      expectedImage: selectedEffective["--expected-image"]!,
      expectedEnvironment,
      mountContract: legacyEffective ? "legacy-alpha742" : "canonical",
    })
    if (imageInspect.Id !== selectedEffective["--expected-image"]) {
      result.ok = false
      result.violations.unshift("reviewed image inspect identity does not match the expected local image ID")
    }
    write(JSON.stringify(result) + "\n")
    return result.ok ? 0 : 1
  }

  let templateXml: string
  let runtimePolicyText: string
  try {
    templateXml = readFile(staged!["--template"]!)
    runtimePolicyText = readFile(staged!["--runtime-policy"]!)
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
  const result = auditSanctuaryStagedFiles({ templateXml, runtimePolicyText, expectedImage: staged!["--expected-image"]! })
  write(JSON.stringify(result) + "\n")
  return result.ok ? 0 : 1
}

export function runContainerSpecAuditorMain(
  isMain: boolean,
  args: string[],
  runner: (cliArgs: string[]) => number,
): void {
  if (isMain) process.exitCode = runner(args)
}

runContainerSpecAuditorMain(require.main === module, process.argv.slice(2), runContainerSpecAuditorCli)
