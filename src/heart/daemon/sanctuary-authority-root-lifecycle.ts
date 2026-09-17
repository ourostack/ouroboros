import { execFileSync, spawn } from "node:child_process"
import { createHash, createPrivateKey } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"
import { FileTelegramOffsetStore } from "../../senses/telegram-client"
import { verifySanctuaryAuthorityInstallation } from "./sanctuary-authority-installation"
import { prepareSanctuaryAuthorityEpoch, readSanctuaryAuthorityEpoch, retireSanctuaryAuthorityEpoch, releaseSanctuaryAuthorityToken } from "./sanctuary-authority-epoch"
import { FileSanctuaryTelegramAuthorityGateway, sanctuaryTelegramAuthorityStatePath } from "./sanctuary-telegram-authority-gateway"
import type { SanctuaryTelegramAuthorityConfig } from "./sanctuary-telegram-authority-entry"
import { openSanctuaryResidentAuthority } from "../../senses/sanctuary-authority-resident"
import { migrateSanctuaryAuthorityVault } from "./sanctuary-authority-vault-migration"
import { withSessionTurnLease } from "../../mind/session-transaction"
import { emitNervesEvent } from "../../nerves/runtime"

const ROOT = "/mnt/user/appdata/ouro-authority"
const BUNDLE = "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro"
const RUNTIME = "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli"
const OFFSET = `${BUNDLE}/state/senses/telegram/offset.json`
const SOCKET = "/run/ouro-authority"
const STAGING = "/var/lib/ouro-authority/staging"
const CGROUP = "/sys/fs/cgroup/ouro-authority"
const BOOT = "/boot/config/custom/ouro-authority/start.sh"
const BOOT_LINE = `/bin/sh ${BOOT} --boot & # ouro-authority`
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const digest = (value: string | Buffer) => `sha256:${createHash("sha256").update(value).digest("hex")}`
interface Request {
  schemaVersion: 1
  epochId: string
  botId: string
  ownerUserId: string
  ownerChatId: string
  packageDigest: string
  nodeDigest: string
  prlimitDigest: string
  setsidDigest: string
  shellDigest: string
}
interface Transaction { targetImageId: string; rollbackImageId: string }
interface Container {
  Name: string
  Image: string
  State: { Running: boolean; Health?: { Status: string } }
  Config: { User: string; Env: string[] }
  Mounts: { Source: string; Destination: string; RW: boolean }[]
}

// The prefix is a filesystem-fixture seam; the production CLI never accepts it.
export class SanctuaryAuthorityRootLifecycle {
  readonly #request: Request
  readonly #transaction: Transaction
  readonly #prefix: string
  readonly #uid: number
  readonly #gid: number
  readonly #socketGid: number
  constructor(transaction: Transaction, options: { prefix?: string; expectedUid?: number; expectedGid?: number; socketGroupId?: number } = {}) {
    this.#prefix = options.prefix ?? ""
    this.#uid = options.expectedUid ?? 0
    this.#gid = options.expectedGid ?? 0
    this.#socketGid = options.socketGroupId ?? 10001
    if (process.getuid!() !== this.#uid || process.getgid!() !== this.#gid) throw new Error("Sanctuary root lifecycle requires root")
    if (!DIGEST.test(transaction.targetImageId) || !DIGEST.test(transaction.rollbackImageId) || transaction.targetImageId === transaction.rollbackImageId) throw new Error("Sanctuary root lifecycle image identity is invalid")
    this.#transaction = { targetImageId: transaction.targetImageId, rollbackImageId: transaction.rollbackImageId }
    this.#directory(ROOT)
    const request = JSON.parse(this.#private(`${ROOT}/request.json`)) as Request
    if (!request || Object.keys(request).sort().join(",") !== "botId,epochId,nodeDigest,ownerChatId,ownerUserId,packageDigest,prlimitDigest,schemaVersion,setsidDigest,shellDigest"
      || request.schemaVersion !== 1 || !/^[A-Za-z0-9_-]{1,128}$/u.test(request.epochId)
      || ![request.botId, request.ownerUserId, request.ownerChatId].every((id) => typeof id === "string" && /^[1-9][0-9]*$/u.test(id))
      || request.ownerUserId !== request.ownerChatId
      || ![request.packageDigest, request.nodeDigest, request.prlimitDigest, request.setsidDigest, request.shellDigest].every((pin) => typeof pin === "string" && DIGEST.test(pin))) throw new Error("Sanctuary root lifecycle request is invalid")
    this.#request = request
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_root_lifecycle_loaded", message: "Sanctuary root lifecycle identity loaded", meta: { epochId: request.epochId, targetImageId: transaction.targetImageId } })
  }

  plan() {
    const { epochId, botId, ownerUserId, ownerChatId, packageDigest } = this.#request
    return { schemaVersion: 1, epochId, botId, ownerUserId, ownerChatId, packageDigest, publicKeyDigest: null, predecessorContract: "canonical-pre-gateway", targetContract: "canonical-gateway" }
  }

  async boot(): Promise<boolean> {
    if (!fs.existsSync(this.#p(`${ROOT}/activation.json`))) return false
    this.#record(`${ROOT}/activation.json`, { ...this.#transaction, state: "active", epochId: this.#request.epochId })
    if (fs.existsSync(this.#p("/boot/config/custom/ouro-butler/docker-man-template-transaction.json"))) throw new Error("Sanctuary pending installation requires recovery, not boot")
    this.#assertNoForeignPoller()
    this.#target()
    if (this.#containers().some((container) => container.Name !== "/ouro-butler" && container.State.Running)) throw new Error("Sanctuary rollback resident is running")
    this.#runtimeDirectories()
    this.#verifyPackage(undefined, false)
    // Boot may already have a tokenless resident under Docker's restart policy.
    // Only handoff requires us to start it strictly after gateway readiness.
    await this.#startGateway(true)
    return true
  }

  repinExecution(prlimitDigest: string, setsidDigest: string): void {
    if (![prlimitDigest, setsidDigest].every(pin => DIGEST.test(pin))) throw new Error("Reviewed execution digests are required")
    if (fs.existsSync(this.#p("/boot/config/custom/ouro-butler/docker-man-template-transaction.json"))) throw new Error("Finish the pending installation before re-pinning")
    this.#record(`${ROOT}/activation.json`, { ...this.#transaction, state: "active", epochId: this.#request.epochId })
    this.#verifyPackage(undefined, false)
    if (this.#pid() !== null) throw new Error("Stop the verified gateway process before re-pinning")
    for (const name of ["executions", "supervisors"]) {
      const directory = `${this.#epochRoot()}/${name}`
      if (fs.existsSync(this.#p(directory))) {
        this.#directory(directory)
        if (fs.readdirSync(this.#p(directory)).length !== 0) throw new Error("Resolve pending execution state before re-pinning")
      }
    }
    if (fs.readdirSync(this.#p(CGROUP)).some(name => fs.lstatSync(this.#p(`${CGROUP}/${name}`)).isDirectory())) throw new Error("Resolve pending cgroups before re-pinning")
    this.#verifyPrimitive("/usr/bin/prlimit", prlimitDigest)
    this.#verifyPrimitive("/usr/bin/setsid", setsidDigest)
    const currentRequest = JSON.parse(this.#private(`${ROOT}/request.json`))
    if (JSON.stringify(currentRequest) !== JSON.stringify(this.#request)) throw new Error("Sanctuary re-pin request changed")
    const configuration = { ...this.#configuration(), hostPrlimitDigest: prlimitDigest, hostSetsidDigest: setsidDigest }
    const current = JSON.parse(this.#private(`${ROOT}/active.json`))
    if (JSON.stringify({ ...current, hostPrlimitDigest: prlimitDigest, hostSetsidDigest: setsidDigest }) !== JSON.stringify(configuration)) throw new Error("Sanctuary re-pin configuration changed")
    const request = { ...this.#request, prlimitDigest, setsidDigest }
    // Request-first interruption leaves the old runtime pins fail-closed; repeating the command completes publication.
    this.#write(`${ROOT}/request.json`, JSON.stringify(request))
    this.#write(`${ROOT}/active.json`, JSON.stringify(configuration))
    this.#request.prlimitDigest = prlimitDigest
    this.#request.setsidDigest = setsidDigest
    emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_execution_pins_refreshed", message: "Reviewed Sanctuary execution pins refreshed; gateway restart required", meta: { prlimitDigest, setsidDigest } })
  }

  effect(step: string) {
    const effects: Record<string, { read(): boolean | Promise<boolean>; apply(): void | Promise<void> }> = {
      "freeze-resident": { read: () => this.#frozen(), apply: () => this.#freeze() },
      "stage-authority": { read: () => this.#staged(), apply: () => this.#stage() },
      "verify-token-rotation": { read: () => this.#rotated(), apply: () => this.#rotate() },
      "transfer-cursor": { read: () => this.#transferred(), apply: () => this.#transfer() },
      "remove-resident-token": { read: () => this.#tokensAbsent(), apply: () => { this.#requireStopped(); this.#vault("remove") } },
      "start-gateway": { read: () => this.#ready(), apply: () => this.#startGateway() },
      "configure-resident": { read: () => this.#configured(), apply: () => this.#configure() },
      "start-resident": { read: () => this.#target().State.Running, apply: () => this.#startResident() },
      "verify-install": { read: () => this.#active(), apply: () => this.#activate() },
      "rollback:freeze-resident": { read: () => this.#frozen() && !fs.existsSync(this.#p(`${ROOT}/activation.json`)), apply: () => { this.#remove(`${ROOT}/activation.json`); this.#freeze() } },
      "rollback:retire-registrations": { read: () => this.#retiredProcess(), apply: () => this.#retireProcess() },
      "rollback:reconcile-executions": { read: () => this.#retiredProcess(), apply: () => this.#retireProcess() },
      "rollback:stop-gateway": { read: () => this.#retiredProcess() && this.#pid() === null, apply: () => this.#stopGateway() },
      "rollback:end-epoch": { read: () => this.#epoch().state === "retired", apply: () => this.#endEpoch() },
      "rollback:restore-token-cursor": { read: () => this.#restoredToken(), apply: () => this.#restoreToken() },
      "rollback:restore-resident": { read: () => this.#rollback().State.Running, apply: () => this.#restoreResident() },
      "rollback:verify-rollback": { read: () => this.#rollbackVerified(), apply: () => this.#verifyRollback() },
    }
    const effect = effects[step]
    if (!effect) throw new Error("Sanctuary root lifecycle effect is invalid")
    const beforeDigest = digest(`${this.#request.epochId}:${step}:before`)
    const afterDigest = digest(`${this.#request.epochId}:${step}:after`)
    return {
      beforeDigest, afterDigest,
      readback: async () => await effect.read() ? afterDigest : beforeDigest,
      apply: async () => { await effect.apply() },
    }
  }

  #frozen(): boolean {
        this.#assertNoForeignPoller()
        if (!this.#containers().every((container) => !container.State.Running) || !fs.existsSync(this.#p(`${this.#epochRoot()}/migration.json`))) return false
        this.#migration()
        return true
  }
  #freeze(): void {
        this.#assertNoForeignPoller()
        for (const container of this.#containers()) {
          if (![this.#transaction.targetImageId, this.#transaction.rollbackImageId].includes(container.Image)) throw new Error("Sanctuary resident image changed")
          if (container.State.Running) this.#docker(["stop", "--time", "30", container.Name.slice(1)])
        }
        if (this.#containers().some((container) => container.State.Running)) throw new Error("Sanctuary resident did not stop")
        if (fs.existsSync(this.#p(`${this.#epochRoot()}/migration.json`))) { this.#migration(); return }
        if (fs.existsSync(this.#p(`${ROOT}/active.json`))) {
          const previous = JSON.parse(this.#private(`${ROOT}/active.json`)) as SanctuaryTelegramAuthorityConfig
          const epoch = readSanctuaryAuthorityEpoch(previous.epochRoot, { expectedUid: this.#uid, expectedGid: this.#gid })
          if (epoch.state !== "retired" || !fs.existsSync(path.join(previous.epochRoot, "handoff.json"))
            || fs.existsSync(this.#p(`${ROOT}/activation.json`))) throw new Error("Sanctuary previous epoch handoff is incomplete")
        }
        // A missing cursor is not a fresh install: it is lost handoff evidence.
        fs.lstatSync(this.#p(OFFSET))
        const predecessorCursor = new FileTelegramOffsetStore(this.#p(OFFSET)).load()
        const snapshot = this.#vault("snapshot") as { token: string; botId: string; ownerUserId: string; ownerChatId: string }
        if (["botId", "ownerUserId", "ownerChatId"].some((key) => snapshot[key as keyof typeof snapshot] !== this.#request[key as keyof Request])) throw new Error("Sanctuary predecessor identity changed")
        this.#write(`${ROOT}/epochs/${this.#request.epochId}/previous-token`, snapshot.token)
        this.#write(`${this.#epochRoot()}/migration.json`, JSON.stringify({ ...this.plan(), ...this.#transaction, predecessorCursor }))
  }

  #epochRoot(): string { return `${ROOT}/epochs/${this.#request.epochId}` }
  #migration(): { predecessorCursor: number } {
    const value = JSON.parse(this.#private(`${this.#epochRoot()}/migration.json`))
    for (const [key, expected] of Object.entries({ ...this.plan(), ...this.#transaction })) {
      if (value[key] !== expected) throw new Error("Sanctuary root migration identity changed")
    }
    if (!Number.isSafeInteger(value.predecessorCursor) || value.predecessorCursor < 0) throw new Error("Sanctuary root migration cursor is invalid")
    return value
  }
  #directory(absolute: string, mode = 0o700, gid = this.#gid): void {
    const directory = this.#p(absolute)
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true, mode })
      fs.chownSync(directory, this.#uid, gid)
      fs.chmodSync(directory, mode)
    }
    const stat = fs.lstatSync(directory)
    if (!stat.isDirectory() || stat.uid !== this.#uid || stat.gid !== gid || (stat.mode & 0o7777) !== mode || fs.realpathSync(directory) !== directory) throw new Error("Sanctuary root lifecycle directory is unsafe")
  }
  #verifyPackage(packageRoot = `${ROOT}/package`, hostExecution = true): void {
    verifySanctuaryAuthorityInstallation({
      packageRoot: this.#p(packageRoot), manifestPath: this.#p(`${ROOT}/package-manifest.json`), manifestDigest: this.#request.packageDigest,
      stateRoot: this.#p(this.#epochRoot()), stagingRoot: this.#p(STAGING), socketRoot: this.#p(SOCKET), cgroupRoot: this.#p(CGROUP),
      expectedUid: this.#uid, expectedGid: this.#gid, socketGroupId: this.#socketGid, mountInfo: fs.readFileSync(this.#p("/proc/self/mountinfo"), "utf8"),
    })
    const manifest = JSON.parse(this.#private(`${ROOT}/package-manifest.json`, 0o600, 8 * 1024 * 1024))
    for (const program of ["dist/heart/daemon/sanctuary-telegram-authority-entry.js", "dist/heart/daemon/sanctuary-authority-root-lifecycle.js", "dist/heart/daemon/sanctuary-host-supervisor-entry.js", "deploy/unraid/sanctuary-host-launcher.sh", "deploy/unraid/sanctuary-authority-service.sh"]) {
      if (!Object.hasOwn(manifest.files, program)) throw new Error("Sanctuary authority package program is absent")
    }
    for (const [file, expected] of [
      ["/usr/local/bin/node", this.#request.nodeDigest], ["/bin/sh", this.#request.shellDigest],
      ...(hostExecution ? [["/usr/bin/prlimit", this.#request.prlimitDigest], ["/usr/bin/setsid", this.#request.setsidDigest]] : []),
    ]) {
      this.#verifyPrimitive(file!, expected!)
    }
  }
  #verifyPrimitive(file: string, expected: string): void {
    const actual = this.#p(file)
    const stat = fs.statSync(actual)
    if (!stat.isFile() || stat.uid !== this.#uid || stat.gid !== this.#gid || (stat.mode & 0o022) !== 0 || (stat.mode & 0o111) === 0 || digest(fs.readFileSync(actual)) !== expected) throw new Error("Sanctuary host primitive pin changed")
  }
  #staged(hostExecution = true): boolean {
    if (!fs.existsSync(this.#p(`${this.#epochRoot()}/stage.json`))) return false
    this.#record(`${this.#epochRoot()}/stage.json`, { packageDigest: this.#request.packageDigest })
    this.#verifyPackage(undefined, hostExecution)
    if (this.#bootScript().text.split("\n").filter((line) => line === BOOT_LINE).length !== 1
      || digest(this.#private(BOOT)) !== digest(fs.readFileSync(this.#p(`${ROOT}/package/deploy/unraid/sanctuary-authority-service.sh`)))) throw new Error("Sanctuary installed boot lifecycle changed")
    return true
  }
  #runtimeDirectories(): void {
    for (const directory of [this.#epochRoot(), STAGING, CGROUP]) this.#directory(directory)
    this.#directory(SOCKET, 0o750, this.#socketGid)
    // Add only the required controllers; never replace another owner's controls.
    for (const root of ["/sys/fs/cgroup", CGROUP]) {
      const control = this.#p(`${root}/cgroup.subtree_control`)
      if (fs.existsSync(control)) {
        const enabled = fs.readFileSync(control, "utf8").trim().split(/\s+/u)
        const missing = ["cpu", "memory", "pids"].filter((name) => !enabled.includes(name))
        if (missing.length) fs.writeFileSync(control, missing.map((name) => `+${name}`).join(" "))
      }
    }
  }
  #stage(hostExecution = true): void {
    this.#migration()
    this.#runtimeDirectories()
    this.#verifyPackage(`${ROOT}/incoming-package`, hostExecution)
    const manifest = JSON.parse(this.#private(`${ROOT}/package-manifest.json`, 0o600, 8 * 1024 * 1024)) as { files: Record<string, { digest: string; mode: number }> }
    this.#directory(`${ROOT}/package`)
    for (const [relative, pin] of Object.entries(manifest.files)) {
      const destination = `${ROOT}/package/${relative}`
      this.#directory(path.dirname(destination))
      if (fs.existsSync(this.#p(destination))) {
        const stat = fs.lstatSync(this.#p(destination))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== this.#uid || stat.gid !== this.#gid || (stat.mode & 0o7777) !== pin.mode || fs.realpathSync(this.#p(destination)) !== this.#p(destination)) throw new Error("Sanctuary installed package destination is unsafe")
        if (digest(fs.readFileSync(this.#p(destination))) !== pin.digest) throw new Error("Sanctuary installed package conflicts with its pin")
      } else {
        fs.copyFileSync(this.#p(`${ROOT}/incoming-package/${relative}`), this.#p(destination), fs.constants.COPYFILE_EXCL)
      }
      fs.chmodSync(this.#p(destination), pin.mode)
    }
    this.#verifyPackage(undefined, hostExecution)
    const { text: boot, mode: bootMode } = this.#bootScript()
    if (boot.split("\n").some((line) => line.includes("ouro-authority") && line !== BOOT_LINE)) throw new Error("Sanctuary boot ownership is ambiguous")
    this.#write(BOOT, fs.readFileSync(this.#p(`${ROOT}/package/deploy/unraid/sanctuary-authority-service.sh`), "utf8"))
    if (!boot.split("\n").includes(BOOT_LINE)) this.#write("/boot/config/go", `${boot}${boot.endsWith("\n") ? "" : "\n"}${BOOT_LINE}\n`, bootMode)
    this.#write(`${this.#epochRoot()}/stage.json`, JSON.stringify({ packageDigest: this.#request.packageDigest }))
  }
  #epoch() {
    const epoch = readSanctuaryAuthorityEpoch(this.#p(this.#epochRoot()), { expectedUid: this.#uid, expectedGid: this.#gid })
    if (epoch.epochId !== this.#request.epochId || epoch.botId !== this.#request.botId || epoch.ownerUserId !== this.#request.ownerUserId
      || epoch.ownerChatId !== this.#request.ownerChatId || epoch.packageDigest !== this.#request.packageDigest
      || epoch.predecessorCursor !== this.#migration().predecessorCursor) throw new Error("Sanctuary root epoch identity changed")
    return epoch
  }
  #rotated(): boolean {
    if (!fs.existsSync(this.#p(`${this.#epochRoot()}/epoch.json`))) return false
    if (this.#epoch().state !== "prepared") throw new Error("Sanctuary root epoch is retired")
    return true
  }
  async #rotate(hostExecution = true): Promise<void> {
    if (!this.#frozen() || !this.#staged(hostExecution)) throw new Error("Sanctuary root installation must be frozen and staged")
    const token = this.#private(`${ROOT}/incoming-token`).trim()
    this.#write(`${this.#epochRoot()}/current-token`, token)
    await prepareSanctuaryAuthorityEpoch({
      root: this.#p(this.#epochRoot()), epochId: this.#request.epochId, tokenPath: this.#p(`${this.#epochRoot()}/current-token`),
      previousTokenPath: this.#p(`${this.#epochRoot()}/previous-token`), botId: this.#request.botId,
      ownerUserId: this.#request.ownerUserId, ownerChatId: this.#request.ownerChatId,
      predecessorCursor: this.#migration().predecessorCursor, packageDigest: this.#request.packageDigest,
    }, {
      expectedUid: this.#uid, expectedGid: this.#gid, now: () => new Date().toISOString(),
      probe: async (value) => {
        const response = await fetch(`https://api.telegram.org/bot${value}/getMe`, { signal: AbortSignal.timeout(15_000) })
        const body = await response.json() as { ok?: boolean; result?: { id?: number } }
        return { status: response.status, botId: body.ok === true && Number.isSafeInteger(body.result?.id) ? String(body.result!.id) : null }
      },
    })
  }
  #gateway() {
    const epoch = this.#epoch()
    return new FileSanctuaryTelegramAuthorityGateway(this.#p(`${this.#epochRoot()}/agent`), {
      targetHost: "sanctuary", botId: epoch.botId, ownerUserId: epoch.ownerUserId, ownerChatId: epoch.ownerChatId,
      keyId: epoch.epochId, publicKeyDigest: epoch.publicKeyDigest, privateKey: createPrivateKey(this.#private(`${this.#epochRoot()}/issuer.pem`)),
    })
  }
  #transferred(): boolean {
    if (!fs.existsSync(this.#p(`${ROOT}/active.json`))) return false
    if (!fs.existsSync(sanctuaryTelegramAuthorityStatePath(this.#p(`${this.#epochRoot()}/agent`)))) return false
    if (JSON.stringify(JSON.parse(this.#private(`${ROOT}/active.json`))) !== JSON.stringify(this.#configuration())) throw new Error("Sanctuary root configuration changed during handoff")
    if (this.#gateway().cursor() !== this.#migration().predecessorCursor) throw new Error("Sanctuary root handoff cursor changed")
    return true
  }
  #transfer(): void {
    if (!this.#frozen() || !this.#rotated()) throw new Error("Sanctuary root epoch is not ready for cursor handoff")
    this.#gateway().initializeCursor(this.#epoch().predecessorCursor)
    this.#write(`${ROOT}/active.json`, JSON.stringify(this.#configuration()))
  }
  #configuration(): SanctuaryTelegramAuthorityConfig {
    const epoch = this.#epoch()
    const program = `${ROOT}/package/dist/heart/daemon/sanctuary-host-supervisor-entry.js`
    const launcher = `${ROOT}/package/deploy/unraid/sanctuary-host-launcher.sh`
    const config: SanctuaryTelegramAuthorityConfig = {
      schemaVersion: 1, targetHost: "sanctuary", botId: epoch.botId, ownerUserId: epoch.ownerUserId, ownerChatId: epoch.ownerChatId,
      keyId: epoch.epochId, publicKeyDigest: epoch.publicKeyDigest, socketGroupId: this.#socketGid,
      agentRoot: this.#p(`${this.#epochRoot()}/agent`), epochRoot: this.#p(this.#epochRoot()),
      tokenPath: epoch.tokenPath, privateKeyPath: this.#p(`${this.#epochRoot()}/issuer.pem`),
      socketPath: this.#p(`${SOCKET}/authority.sock`), readinessPath: this.#p(`${this.#epochRoot()}/readiness.json`), lockPath: this.#p(`${this.#epochRoot()}/authority.lock`),
      hostStagingRoot: this.#p(STAGING), hostExecutionStateRoot: this.#p(`${this.#epochRoot()}/executions`), hostSupervisorStateRoot: this.#p(`${this.#epochRoot()}/supervisors`),
      hostCgroupRoot: this.#p(CGROUP), hostSupervisorProgramPath: this.#p(program), hostSupervisorProgramDigest: digest(fs.readFileSync(this.#p(program))),
      hostLauncherPath: this.#p(launcher), hostLauncherDigest: digest(fs.readFileSync(this.#p(launcher))),
      hostPrlimitPath: this.#p("/usr/bin/prlimit"), hostPrlimitDigest: this.#request.prlimitDigest,
      hostSetsidPath: this.#p("/usr/bin/setsid"), hostSetsidDigest: this.#request.setsidDigest, hostShellPath: this.#p("/bin/sh"), hostShellDigest: this.#request.shellDigest,
      packageRoot: this.#p(`${ROOT}/package`), packageManifestPath: this.#p(`${ROOT}/package-manifest.json`), packageManifestDigest: this.#request.packageDigest,
    }
    return config
  }
  #requireStopped(): void {
    this.#assertNoForeignPoller()
    if (this.#containers().some((container) => container.State.Running)) throw new Error("Sanctuary resident must be stopped")
  }
  #tokensAbsent(): boolean {
    const presence = this.#vault("presence") as { tokenPresent: boolean }
    if (!presence || Object.keys(presence).join(",") !== "tokenPresent" || typeof presence.tokenPresent !== "boolean") throw new Error("Sanctuary vault presence readback is invalid")
    return !presence.tokenPresent
  }
  #pid(): number | null {
    const lock = `${this.#epochRoot()}/authority.lock`
    if (!fs.existsSync(this.#p(lock))) return null
    const pid = Number(this.#private(lock))
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Sanctuary gateway process lock is invalid")
    if (!fs.existsSync(this.#p(`/proc/${pid}`))) return null
    const status = fs.readFileSync(this.#p(`/proc/${pid}/status`), "utf8")
    const command = fs.readFileSync(this.#p(`/proc/${pid}/cmdline`), "utf8")
    const expected = [this.#p("/usr/local/bin/node"), this.#p(`${ROOT}/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js`), "--config", this.#p(`${ROOT}/active.json`), ""].join("\0")
    if (!status.split("\n").includes(`Uid:\t${this.#uid}\t${this.#uid}\t${this.#uid}\t${this.#uid}`) || command !== expected) throw new Error("Sanctuary gateway process identity changed")
    return pid
  }
  async #ready(): Promise<boolean> {
    if (!fs.existsSync(this.#p(`${this.#epochRoot()}/readiness.json`))) return false
    if (this.#pid() === null) throw new Error("Sanctuary gateway readiness has no live process")
    const epoch = this.#epoch()
    const readiness = JSON.parse(this.#private(`${this.#epochRoot()}/readiness.json`))
    if (readiness.status !== "ready" || readiness.botId !== epoch.botId || readiness.publicKeyDigest !== epoch.publicKeyDigest) throw new Error("Sanctuary gateway readiness identity changed")
    const authority = openSanctuaryResidentAuthority({}, {}, { configPath: this.#p(`${SOCKET}/resident.json`), expectedUid: this.#uid, expectedGid: this.#socketGid })
    try {
      const snapshot = await authority.cursorSnapshot()
      if (snapshot.keyId !== epoch.epochId || snapshot.botId !== epoch.botId || snapshot.publicKeyDigest !== epoch.publicKeyDigest || snapshot.cursor < epoch.predecessorCursor) throw new Error("Sanctuary gateway signed readiness changed")
      return true
    } finally { authority.authorityTransport.api.stop() }
  }
  async #wait(check: () => boolean | Promise<boolean>, timeoutMs = 120_000): Promise<void> {
    const until = Date.now() + timeoutMs
    while (!await check()) {
      if (Date.now() >= until) throw new Error("Sanctuary root lifecycle readback timed out")
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  async #startGateway(boot = false): Promise<void> {
    if (!boot) this.#requireStopped()
    this.#verifyPackage(undefined, !boot)
    if (!this.#tokensAbsent() || !this.#rotated()) throw new Error("Sanctuary root token custody is not exclusive")
    if (this.#pid() === null) {
      this.#remove(`${this.#epochRoot()}/readiness.json`)
      const child = spawn(this.#p("/usr/local/bin/node"), [this.#p(`${ROOT}/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js`), "--config", this.#p(`${ROOT}/active.json`)], {
        cwd: "/", env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, detached: true, stdio: "ignore",
      })
      child.unref()
      let failed = false
      child.once("error", () => { failed = true })
      await this.#wait(async () => {
        if (failed) throw new Error("Sanctuary gateway launch failed")
        return this.#ready()
      })
    } else await this.#wait(() => this.#ready())
  }
  #target(): Container {
    const target = this.#containers().find((container) => container.Name === "/ouro-butler")
    if (!target || target.Image !== this.#transaction.targetImageId || target.Config.User !== "10001:10001"
      || target.Config.Env.some((entry) => /telegram.*token|bot.*token/iu.test(entry))
      || target.Mounts.filter((mount) => mount.Source === SOCKET && mount.Destination === SOCKET && mount.RW === false).length !== 1
      || target.Mounts.some((mount) => mount.Source === "/var/run/docker.sock" || mount.Source.startsWith(ROOT))) throw new Error("Sanctuary target resident is not tokenless and gateway-mounted")
    return target
  }
  #configured(): boolean {
    if (!fs.existsSync(this.#p(`${this.#epochRoot()}/configured.json`))) return false
    this.#record(`${this.#epochRoot()}/configured.json`, { epochId: this.#request.epochId, targetImageId: this.#transaction.targetImageId })
    this.#target()
    return this.#tokensAbsent() && this.#directAutostartDisabled()
  }
  async #configure(): Promise<void> {
    this.#requireStopped()
    this.#target()
    if (!this.#tokensAbsent() || !this.#directAutostartDisabled() || !await this.#ready()) throw new Error("Sanctuary gateway must be ready and direct autostart disabled before configuring the resident")
    this.#write(`${this.#epochRoot()}/configured.json`, JSON.stringify({ epochId: this.#request.epochId, targetImageId: this.#transaction.targetImageId }))
  }
  async #startResident(): Promise<void> {
    this.#assertNoForeignPoller()
    if (!this.#configured() || !await this.#ready()) throw new Error("Sanctuary gateway must be ready before resident startup")
    if (this.#containers().some((container) => container.Name !== "/ouro-butler" && container.State.Running)) throw new Error("Sanctuary rollback resident is running")
    if (!this.#target().State.Running) this.#docker(["start", "ouro-butler"])
    await this.#wait(() => this.#target().State.Running && this.#target().State.Health?.Status === "healthy")
  }
  async #active(): Promise<boolean> {
    if (!fs.existsSync(this.#p(`${ROOT}/activation.json`))) return false
    this.#record(`${ROOT}/activation.json`, { ...this.#transaction, state: "active", epochId: this.#request.epochId })
    return this.#configured() && this.#target().State.Running && this.#target().State.Health?.Status === "healthy" && await this.#ready()
  }
  async #activate(): Promise<void> {
    if (!this.#configured() || !this.#target().State.Running || this.#target().State.Health?.Status !== "healthy" || !await this.#ready()) throw new Error("Sanctuary activation readback failed")
    this.#write(`${ROOT}/activation.json`, JSON.stringify({ ...this.#transaction, state: "active", epochId: this.#request.epochId }))
  }
  #retiredProcess(): boolean {
    const retirement = `${this.#epochRoot()}/retirement.json`
    if (!fs.existsSync(this.#p(retirement))) return false
    const proof = JSON.parse(this.#private(retirement))
    const epoch = this.#epoch()
    if (proof.schemaVersion !== 1 || proof.keyId !== epoch.epochId || proof.publicKeyDigest !== epoch.publicKeyDigest || proof.quiescent !== true
      || !Number.isSafeInteger(proof.cursor) || proof.cursor < epoch.predecessorCursor
      || fs.readdirSync(this.#p(CGROUP)).some((entry) => fs.lstatSync(this.#p(`${CGROUP}/${entry}`)).isDirectory())) throw new Error("Sanctuary gateway retirement cleanup is unproven")
    return true
  }
  async #retireProcess(): Promise<void> {
    this.#requireStopped()
    if (this.#retiredProcess()) return
    // An interrupted installation may never have published an epoch/config.
    // Complete only the root prerequisites needed to retire it; never start
    // ingress or a resident while recovering this rollback intent.
    if (!fs.existsSync(this.#p(`${this.#epochRoot()}/epoch.json`))) {
      if (!this.#staged(false)) this.#stage(false)
      await this.#rotate(false)
    }
    if (!fs.existsSync(this.#p(`${ROOT}/active.json`)) || JSON.parse(this.#private(`${ROOT}/active.json`)).keyId !== this.#request.epochId) this.#transfer()
    this.#verifyPackage(undefined, false)
    const pid = this.#pid()
    if (pid !== null) {
      process.kill(pid, "SIGUSR2")
      await this.#wait(() => this.#retiredProcess(), 1_020_000)
    } else {
      execFileSync(this.#p("/usr/local/bin/node"), [this.#p(`${ROOT}/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js`), "--config", this.#p(`${ROOT}/active.json`), "--retire-only"], {
        encoding: "utf8", timeout: 1_020_000, stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, cwd: "/",
      })
      if (!this.#retiredProcess()) throw new Error("Sanctuary gateway retirement readback failed")
    }
  }
  async #stopGateway(): Promise<void> {
    if (!this.#retiredProcess()) throw new Error("Sanctuary gateway must retire before stopping")
    const pid = this.#pid()
    if (pid !== null) {
      process.kill(pid, "SIGTERM")
      await this.#wait(() => this.#pid() === null)
    }
    this.#remove(`${this.#epochRoot()}/readiness.json`)
  }
  #endEpoch(): void {
    if (!this.#retiredProcess() || this.#pid() !== null) throw new Error("Sanctuary gateway must retire and stop before ending its epoch")
    const proof = JSON.parse(this.#private(`${this.#epochRoot()}/retirement.json`))
    retireSanctuaryAuthorityEpoch(this.#p(this.#epochRoot()), { expectedUid: this.#uid, expectedGid: this.#gid, quiescent: true, cursor: proof.cursor })
  }
  #restoredToken(): boolean {
    if (this.#epoch().state !== "retired" || !fs.existsSync(this.#p(`${this.#epochRoot()}/restored.json`))
      || !fs.existsSync(this.#p(`${this.#epochRoot()}/handoff.json`)) || fs.existsSync(this.#p(`${this.#epochRoot()}/current-token`)) || fs.existsSync(this.#p(`${ROOT}/incoming-token`))) return false
    this.#record(`${this.#epochRoot()}/restored.json`, { tokenDigest: this.#epoch().tokenDigest, cursor: this.#epoch().terminalCursor })
    const token = this.#vault("snapshot") as { token: string }
    return digest(token.token) === this.#epoch().tokenDigest && new FileTelegramOffsetStore(this.#p(OFFSET)).load() >= this.#epoch().terminalCursor!
  }
  #restoreToken(): void {
    this.#requireStopped()
    const epoch = this.#epoch()
    if (epoch.state !== "retired" || this.#pid() !== null || !this.#retiredProcess()) throw new Error("Sanctuary epoch must retire before token handoff")
    if (this.#restoredToken()) return
    const token = fs.existsSync(this.#p(`${this.#epochRoot()}/current-token`))
      ? this.#private(`${this.#epochRoot()}/current-token`).trim() : (this.#vault("snapshot") as { token: string }).token
    if (digest(token) !== epoch.tokenDigest) throw new Error("Sanctuary current token handoff identity changed")
    this.#vault("restore", { token, botId: epoch.botId, ownerUserId: epoch.ownerUserId, ownerChatId: epoch.ownerChatId })
    new FileTelegramOffsetStore(this.#p(OFFSET)).save(epoch.terminalCursor!)
    // Restore the original resident ownership; root must not strand a root-owned cursor.
    fs.chownSync(this.#p(OFFSET), this.#uid === 0 ? 10001 : this.#uid, this.#uid === 0 ? 10001 : this.#gid)
    this.#write(`${this.#epochRoot()}/restored.json`, JSON.stringify({ tokenDigest: epoch.tokenDigest, cursor: epoch.terminalCursor }))
    const restored = this.#vault("snapshot") as { token: string }
    if (digest(restored.token) !== epoch.tokenDigest || new FileTelegramOffsetStore(this.#p(OFFSET)).load() !== epoch.terminalCursor) throw new Error("Sanctuary token and cursor handoff readback failed")
    releaseSanctuaryAuthorityToken(this.#p(this.#epochRoot()), { expectedUid: this.#uid, expectedGid: this.#gid, tokenDigest: epoch.tokenDigest, cursor: epoch.terminalCursor! })
    if (fs.existsSync(this.#p(`${ROOT}/incoming-token`))) {
      if (digest(this.#private(`${ROOT}/incoming-token`).trim()) !== epoch.tokenDigest) throw new Error("Sanctuary incoming token changed during handoff")
      this.#remove(`${ROOT}/incoming-token`)
    }
  }
  #rollback(): Container {
    const resident = this.#containers().find((container) => container.Name === "/ouro-butler")
    if (!resident || resident.Image !== this.#transaction.rollbackImageId || resident.Config.User !== "10001:10001"
      || resident.Mounts.some((mount) => mount.Source === SOCKET || mount.Destination === SOCKET)) throw new Error("Sanctuary rollback image or socket mount has not been restored")
    return resident
  }
  async #restoreResident(): Promise<void> {
    this.#assertNoForeignPoller()
    if (!this.#restoredToken() || this.#pid() !== null) throw new Error("Sanctuary rollback token handoff is incomplete")
    const resident = this.#rollback()
    if (!resident.State.Running) this.#docker(["start", "ouro-butler"])
    await this.#wait(() => this.#rollback().State.Health?.Status === "healthy" && this.#rollback().State.Running)
  }
  #rollbackVerified(): boolean {
    return fs.existsSync(this.#p(`${this.#epochRoot()}/rollback.json`)) && this.#restoredToken() && this.#pid() === null && this.#rollback().State.Running && this.#rollback().State.Health?.Status === "healthy"
  }
  #verifyRollback(): void {
    if (!this.#restoredToken() || this.#pid() !== null || !this.#rollback().State.Running || this.#rollback().State.Health?.Status !== "healthy") throw new Error("Sanctuary rollback readback failed")
    this.#write(`${this.#epochRoot()}/rollback.json`, JSON.stringify({ epochId: this.#request.epochId, state: "retired" }))
  }
  #remove(absolute: string): void {
    if (!fs.existsSync(this.#p(absolute))) return
    this.#private(absolute)
    fs.unlinkSync(this.#p(absolute))
    const directory = fs.openSync(path.dirname(this.#p(absolute)), fs.constants.O_RDONLY)
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  }
  #directAutostartDisabled(): boolean {
    const file = this.#p("/var/lib/docker/unraid-autostart")
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== this.#uid || stat.gid !== this.#gid || (stat.mode & 0o7777) !== 0o644) throw new Error("Sanctuary DockerMan autostart state is unsafe")
    return !fs.readFileSync(file, "utf8").split("\n").some((line) => /^ouro-butler(?:-rollback|-staging|-legacy-evidence)?(?:\s|$)/u.test(line))
  }
  #p(absolute: string) { return `${this.#prefix}${absolute}` }
  #bootScript(): { text: string; mode: number } {
    const mode = fs.lstatSync(this.#p("/boot/config/go")).mode & 0o7777
    if (![0o600, 0o644, 0o700, 0o755].includes(mode)) throw new Error("Sanctuary boot script metadata is unsafe")
    return { text: this.#private("/boot/config/go", mode), mode }
  }
  #record(absolute: string, expected: Record<string, unknown>): void {
    const value = JSON.parse(this.#private(absolute))
    if (!value || Object.keys(value).sort().join(",") !== Object.keys(expected).sort().join(",")
      || Object.entries(expected).some(([key, entry]) => value[key] !== entry)) throw new Error("Sanctuary root lifecycle record identity changed")
  }
  #private(absolute: string, mode = 0o600, maxBytes = 1024 * 1024): string {
    const file = this.#p(absolute)
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== this.#uid || stat.gid !== this.#gid || (stat.mode & 0o7777) !== mode
        || fs.realpathSync(file) !== file || stat.size < 1 || stat.size > maxBytes) throw new Error("Sanctuary root lifecycle private file is unsafe")
      return fs.readFileSync(fd, "utf8")
    } finally { fs.closeSync(fd) }
  }
  #write(absolute: string, value: string, mode = 0o600): void {
    const file = this.#p(absolute)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const parent = fs.lstatSync(path.dirname(file))
    if (parent.uid !== this.#uid || parent.gid !== this.#gid
      || !(absolute === "/boot/config/go" ? [0o700, 0o755] : [0o700]).includes(parent.mode & 0o7777)
      || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error("Sanctuary root lifecycle parent is unsafe")
    // This temporary belongs exclusively to the fenced root transaction.
    const temporary = `${file}.tmp`
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
    let owned = false
    try {
      try {
        const stat = fs.fstatSync(fd)
        if (stat.nlink !== 1 || !stat.isFile() || stat.uid !== this.#uid || stat.gid !== this.#gid || ![0o600, mode].includes(stat.mode & 0o7777)) throw new Error("Sanctuary root lifecycle temporary is unsafe")
        owned = true
        fs.ftruncateSync(fd, 0)
        fs.writeFileSync(fd, value)
        fs.fchmodSync(fd, mode)
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      fs.renameSync(temporary, file)
    } catch (error) {
      if (owned) fs.unlinkSync(temporary)
      throw error
    }
    const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY)
    try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  }
  #docker(args: string[], input?: string): string {
    return execFileSync("/usr/bin/docker", args, { encoding: "utf8", input, maxBuffer: 1024 * 1024, timeout: 120_000, stdio: ["pipe", "pipe", "pipe"] })
  }
  #containers(): Container[] {
    const names = this.#docker(["ps", "-a", "--format", "{{json .}}"]).trim().split("\n").filter(Boolean).map((line) => String(JSON.parse(line).Names))
    return names.filter((name) => ["ouro-butler", "ouro-butler-rollback"].includes(name)).flatMap((name) => JSON.parse(this.#docker(["inspect", name])) as Container[])
  }
  #assertNoForeignPoller(): void {
    const names = this.#docker(["ps", "--format", "{{json .}}"]).trim().split("\n").filter(Boolean).map((line) => String(JSON.parse(line).Names))
    for (const name of names) {
      if (["ouro-butler", "ouro-butler-rollback"].includes(name)) continue
      const containers = JSON.parse(this.#docker(["inspect", name])) as Container[]
      if (containers.some((container) => container.Mounts.some((mount) => mount.Source === BUNDLE || mount.Source === RUNTIME))) throw new Error("Sanctuary has an unowned possible direct poller")
    }
  }
  #vault(operation: string, input?: unknown): unknown {
    return JSON.parse(this.#docker([
      "run", "--rm", "-i", "--pull=never", "--network", "host", "--user", "0:0", "--read-only", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--entrypoint", "/usr/local/bin/node",
      "--mount", `type=bind,src=${RUNTIME},dst=/home/ouro/.ouro-cli,readonly`,
      "--mount", `type=bind,src=${BUNDLE},dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly`,
      "--tmpfs", "/home/ouro/.ouro-cli/bitwarden:rw,nosuid,nodev,noexec,mode=0700",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=0700",
      this.#transaction.targetImageId, "/opt/ouro/dist/heart/daemon/sanctuary-authority-root-lifecycle.js", "vault", operation,
    ], input === undefined ? undefined : JSON.stringify(input)))
  }
}

export async function runSanctuaryAuthorityRootCli(argv: string[], write = (text: string) => process.stdout.write(text)): Promise<void> {
  if (process.getuid!() !== 0 || process.getgid!() !== 0) throw new Error("Sanctuary root lifecycle requires root")
  if (argv.length === 2 && argv[0] === "vault") {
    const input = argv[1] === "restore" ? JSON.parse(fs.readFileSync(0, "utf8")) : undefined
    write(`${JSON.stringify(await migrateSanctuaryAuthorityVault(argv[1]!, input))}\n`)
    return
  }
  const repin = argv.length === 3 && argv[0] === "repin-execution"
  if (!repin && (argv.length !== 1 || argv[0] !== "boot")) throw new Error("Usage: sanctuary-authority-root-lifecycle <boot|repin-execution <prlimit-sha256> <setsid-sha256>|vault snapshot|vault presence|vault remove|vault restore>")
  await withSessionTurnLease("/boot/config/custom/ouro-butler/docker-man-template-transaction.json", async () => {
    const activationPath = `${ROOT}/activation.json`
    if (!fs.existsSync(activationPath)) {
      if (repin) throw new Error("Sanctuary authority is not active")
      return
    }
    const activation = JSON.parse(fs.readFileSync(activationPath, "utf8")) as Transaction
    const lifecycle = new SanctuaryAuthorityRootLifecycle(activation)
    if (repin) {
      lifecycle.repinExecution(argv[1]!, argv[2]!)
      write('{"repinned":true,"gatewayRestartRequired":true}\n')
    } else await lifecycle.boot()
  }, { timeoutMs: 0, confinementRoot: "/boot/config/custom/ouro-butler" })
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === __filename) {
  void runSanctuaryAuthorityRootCli(process.argv.slice(2)).catch(() => {
    process.stderr.write("Sanctuary root lifecycle failed; inspect the root transaction and repair its failed boundary.\n")
    process.exitCode = 1
  })
}
