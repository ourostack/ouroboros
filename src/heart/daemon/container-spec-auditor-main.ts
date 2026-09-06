import * as fs from "node:fs"
import { emitNervesEvent } from "../../nerves/runtime"
import { auditSanctuaryContainerSpec, auditSanctuaryPersistentTemplate, auditSanctuaryStagedFiles } from "./container-spec-auditor"

const { decodeUtf8 } = require("../../../deploy/unraid/docker-man-template-xml.cjs") as { decodeUtf8(input: string | Uint8Array): string }

export interface ContainerSpecAuditorCliDeps {
  readFile?: (filePath: string) => string | Uint8Array
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
  const readFile = deps.readFile ?? ((filePath: string) => fs.readFileSync(filePath))
  const readText = (filePath: string) => decodeUtf8(readFile(filePath))
  const write = deps.write ?? ((text: string) => process.stdout.write(text))
  const staged = parseModeArguments(args, ["--template", "--runtime-policy", "--expected-image"])
  const persistent = parseModeArguments(args, ["--persistent-template", "--runtime-policy", "--expected-image-reference"])
  const effective = parseModeArguments(args, ["--inspect", "--image-inspect", "--expected-image", "--expected-image-reference", "--expected-icon"])
  const sourceCandidate = parseModeArguments(args, ["--inspect", "--image-inspect", "--expected-image", "--mount-contract"])
  const sourceContract = sourceCandidate?.["--mount-contract"]
  const sourceEffective = sourceContract === "legacy-alpha742" || sourceContract === "prepackage-alpha797" ? sourceCandidate : null
  const selectedEffective = effective ?? sourceEffective
  if (!staged && !persistent && !selectedEffective) {
    write(JSON.stringify({ ok: false, error: "usage: staged --template <path> --runtime-policy <path> --expected-image <id>; persistent --persistent-template <path> --runtime-policy <path> --expected-image-reference <tag>; effective --inspect <path> --image-inspect <path> --expected-image <id> --expected-image-reference <tag> --expected-icon <url>; source compatibility effective --inspect <path> --image-inspect <path> --expected-image <id> --mount-contract <legacy-alpha742|prepackage-alpha797>" }) + "\n")
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
      containerText = readText(selectedEffective["--inspect"]!)
      imageText = readText(selectedEffective["--image-inspect"]!)
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
      expectedImageReference: selectedEffective["--expected-image-reference"],
      expectedIcon: selectedEffective["--expected-icon"],
      mountContract: sourceContract === "legacy-alpha742" || sourceContract === "prepackage-alpha797" ? sourceContract : "canonical",
    })
    if (imageInspect.Id !== selectedEffective["--expected-image"]) {
      result.ok = false
      result.violations.unshift("reviewed image inspect identity does not match the expected local image ID")
    }
    write(JSON.stringify(result) + "\n")
    return result.ok ? 0 : 1
  }

  const templateArguments = persistent ?? staged!
  const templatePath = persistent ? templateArguments["--persistent-template"]! : templateArguments["--template"]!
  let templateXml: string
  let runtimePolicyText: string
  try {
    templateXml = readText(templatePath)
    runtimePolicyText = readText(templateArguments["--runtime-policy"]!)
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
  const result = persistent
    ? auditSanctuaryPersistentTemplate({ templateXml, runtimePolicyText, expectedImageReference: persistent["--expected-image-reference"]! })
    : auditSanctuaryStagedFiles({ templateXml, runtimePolicyText, expectedImage: staged!["--expected-image"]! })
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
