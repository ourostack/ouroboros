import { spawnSync } from "child_process"
import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { parseCanonicalJson } from "./canonical-json"
import type { ProcessProof } from "./process-identity"

const MAXIMUM_OUTPUT_BYTES = 8192

export interface ProcessProofRunner {
  readFile(filePath: string): Buffer
  realpath(filePath: string): string
  run(executable: string, argv: string[], maximumOutputBytes: number): {
    status: number | null
    stdout: string
    stderr: string
  }
}

export interface DarwinProcessProofOptions {
  platform: string
  arch: string
  helperPath: string
  helperSha256: string
  runner: ProcessProofRunner
}

export const defaultProcessProofRunner: ProcessProofRunner = {
  readFile: (filePath) => fs.readFileSync(filePath),
  realpath: (filePath) => fs.realpathSync(filePath),
  run: (executable, argv, maximumOutputBytes) => {
    const result = spawnSync(executable, argv, {
      encoding: "utf8",
      maxBuffer: maximumOutputBytes,
      env: {},
    })
    return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }
  },
}

function parseProof(value: unknown, expectedPid: number, runner: ProcessProofRunner): ProcessProof {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "executableRealpath,pid,schemaVersion,startIdentity,uid"
  ) {
    throw new Error("process proof output has an invalid schema")
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || record.pid !== expectedPid) throw new Error("process proof output does not match the request")
  if (!Number.isSafeInteger(record.uid) || (record.uid as number) < 0) throw new Error("process proof output has an invalid UID")
  if (typeof record.startIdentity !== "string" || !/^darwin-proc:\d+:\d{6}$/.test(record.startIdentity)) {
    throw new Error("process proof output has an invalid microsecond start identity")
  }
  if (typeof record.executableRealpath !== "string" || !path.isAbsolute(record.executableRealpath)) {
    throw new Error("process proof output has an invalid executable realpath")
  }
  if (runner.realpath(record.executableRealpath) !== record.executableRealpath) {
    throw new Error("process proof executable path is not canonical")
  }
  return {
    pid: expectedPid,
    uid: record.uid as number,
    startIdentity: record.startIdentity,
    executableRealpath: record.executableRealpath,
  }
}

export function inspectDarwinProcess(pid: number, options: DarwinProcessProofOptions): ProcessProof {
  if (options.platform !== "darwin") throw new Error(`unsupported process-proof platform: ${options.platform}`)
  if (options.arch !== "arm64" && options.arch !== "x64") {
    throw new Error(`unsupported process-proof architecture: ${options.arch}`)
  }
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process proof PID must be a positive integer")
  if (!/^[a-f0-9]{64}$/.test(options.helperSha256)) throw new Error("process-proof helper provenance hash is invalid")

  const observedSha256 = createHash("sha256").update(options.runner.readFile(options.helperPath)).digest("hex")
  if (observedSha256 !== options.helperSha256) throw new Error("process-proof helper hash does not match release provenance")

  const result = options.runner.run(options.helperPath, ["--pid", String(pid)], MAXIMUM_OUTPUT_BYTES)
  if (result.status !== 0) throw new Error(`process proof helper failed with status ${result.status ?? "unknown"}`)
  if (result.stderr.length > 0) throw new Error("process proof helper wrote unexpected stderr")
  if (Buffer.byteLength(result.stdout, "utf8") > MAXIMUM_OUTPUT_BYTES) throw new Error("process proof output exceeds the bounded protocol")
  if (!result.stdout.endsWith("\n") || result.stdout.slice(0, -1).includes("\n")) {
    throw new Error("process proof output must contain one canonical record")
  }

  const proof = parseProof(parseCanonicalJson(result.stdout.slice(0, -1)), pid, options.runner)
  emitNervesEvent({
    component: "heart",
    event: "heart.runtime_darwin_process_proof_observed",
    message: "observed release-bound Darwin process proof",
    meta: { pid: proof.pid, uid: proof.uid, arch: options.arch },
  })
  return proof
}
