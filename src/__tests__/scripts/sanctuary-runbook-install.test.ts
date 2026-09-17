import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { SanctuaryAuthorityRootLifecycle } from "../../heart/daemon/sanctuary-authority-root-lifecycle"

const runbook = fs.readFileSync("deploy/unraid/README.txt", "utf8")
const oldImage = "sha256:589b7cf8f96d139ee9fd86204a183126aadcbd3fbfb406063709be303397b1b2"
const newImage = `sha256:${"b".repeat(64)}`
const legacyImage = "sha256:681449ad47a2621705cd339b481e6339236b31dc65e195b1cf5025d0f2191d7d"
function helper(name: string): string {
  const start = runbook.indexOf(`    ${name}() {`)
  expect(start, name).toBeGreaterThan(-1)
  const end = runbook.indexOf("\n    }", start)
  expect(end, name).toBeGreaterThan(start)
  return runbook.slice(start, end + 6).replace(/^ {4}/gmu, "").replaceAll("/usr/local/bin/node", process.execPath)
}

describe("S6 executable runbook integration", () => {
  it("retains the small private-record cap separately from the complete package manifest", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s6-runbook-reader-cap-")))
    const state = path.join(root, "mnt/user/appdata/ouro-authority")
    try {
      fs.mkdirSync(state, { recursive: true, mode: 0o700 })
      fs.writeFileSync(path.join(state, "request.json"), " ".repeat(1_048_577), { mode: 0o600 })
      expect(() => new SanctuaryAuthorityRootLifecycle({ targetImageId: newImage, rollbackImageId: oldImage }, {
        prefix: root, expectedUid: process.getuid!(), expectedGid: process.getgid!(),
      })).toThrow("Sanctuary root lifecycle private file is unsafe")
      const source = fs.readFileSync("src/heart/daemon/sanctuary-authority-root-lifecycle.ts", "utf8")
      expect(source).toContain('JSON.parse(this.#private(`${ROOT}/package-manifest.json`, 0o600, 8 * 1024 * 1024))')
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it("prepares a complete package, dependency links, exact hashes and repeatable recovery inputs without token writes", () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "s6-runbook-inputs-")))
    const state = path.join(root, "authority")
    const source = path.join(root, "package")
    const sha = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    const write = (relative: string, bytes: string, mode = 0o600) => {
      const file = path.join(source, relative)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, bytes, { mode })
    }
    try {
      for (const asset of ["package.json", "npm-shrinkwrap.json", "dist/heart/daemon/sanctuary-authority-root-lifecycle.js", "dist/heart/daemon/sanctuary-telegram-authority-entry.js", "dist/heart/daemon/sanctuary-host-supervisor-entry.js", "deploy/unraid/sanctuary-host-launcher.sh", "deploy/unraid/sanctuary-authority-service.sh"]) write(asset, "package-bytes")
      write("node_modules/dependency/index.js", "dependency-bytes", 0o700)
      write("node_modules/dependency/package.json", "{}")
      fs.mkdirSync(path.join(source, "node_modules/.bin"))
      fs.symlinkSync("../dependency/index.js", path.join(source, "node_modules/.bin/tool"))
      fs.mkdirSync(state, { mode: 0o700 })
      const token = path.join(state, "incoming-token")
      const input = helper("prepare_sanctuary_authority_inputs")
      const program = input.slice(input.indexOf("\n", input.indexOf("<<'NODE'")) + 1, input.indexOf("\nNODE"))
        .replaceAll("/mnt/user/appdata/ouro-authority", state)
        .replaceAll("stat.uid !== 0", `stat.uid !== ${process.getuid!()}`)
        .replaceAll("stat.gid !== 0", `stat.gid !== ${process.getgid!()}`)
        .replaceAll('primitive("/usr/local/bin/node")', `primitive(${JSON.stringify(process.execPath)})`)
        .replaceAll('primitive("/usr/bin/prlimit")', 'primitive("/bin/sh")')
        .replaceAll('primitive("/usr/bin/setsid")', 'primitive("/bin/sh")')
        .replaceAll('stat.uid !== ' + process.getuid!() + ' || stat.gid !== ' + process.getgid!() + ' || (stat.mode & 0o022)', '(stat.mode & 0o022)')
      const run = (epoch = "epoch1", bot = "8541786263", owner = "42") => spawnSync(process.execPath, ["-", source, epoch, bot, owner], { input: program, encoding: "utf8" })
      const first = run()
      expect(first.status, first.stderr).toBe(0)
      expect(fs.existsSync(token), "package compatibility is proven before human token input").toBe(false)
      fs.writeFileSync(token, "synthetic-human-input", { mode: 0o600 })
      const manifestPath = path.join(state, "package-manifest.json")
      const requestPath = path.join(state, "request.json")
      const manifestBytes = fs.readFileSync(manifestPath)
      const requestBytes = fs.readFileSync(requestPath)
      const manifest = JSON.parse(manifestBytes.toString())
      const request = JSON.parse(requestBytes.toString())
      expect(request).toEqual({
        schemaVersion: 1, epochId: "epoch1", botId: "8541786263", ownerUserId: "42", ownerChatId: "42",
        packageDigest: sha(manifestBytes), nodeDigest: sha(fs.readFileSync(process.execPath)),
        prlimitDigest: sha(fs.readFileSync("/bin/sh")), setsidDigest: sha(fs.readFileSync("/bin/sh")), shellDigest: sha(fs.readFileSync("/bin/sh")),
      })
      expect(Object.keys(manifest.files)).toHaveLength(10)
      for (const [file, pin] of Object.entries(manifest.files) as [string, { digest: string; mode: number }][]) {
        const installed = path.join(state, "incoming-package", file)
        expect(sha(fs.readFileSync(installed))).toBe(pin.digest)
        const stat = fs.lstatSync(installed)
        expect(stat.isFile()).toBe(true)
        expect(stat.nlink).toBe(1)
        expect(stat.mode & 0o777).toBe(pin.mode)
      }
      expect(run().status).toBe(0)
      expect(fs.readFileSync(manifestPath)).toEqual(manifestBytes)
      expect(fs.readFileSync(requestPath)).toEqual(requestBytes)
      expect(fs.readFileSync(token, "utf8")).toBe("synthetic-human-input")
      for (const args of [["epoch2"], ["../bad"], ["epoch1", "other"], ["epoch1", "8541786263", "-42"]]) expect(run(...args).status).not.toBe(0)
      const stale = path.join(state, "incoming-package", "unreviewed")
      fs.writeFileSync(stale, "extra")
      expect(run().stderr).toContain("unexpected incoming package residue")
      fs.unlinkSync(stale)
      fs.chmodSync(token, 0o644)
      expect(run().stderr).toContain("unsafe authority input file")
      fs.chmodSync(token, 0o600)
      fs.writeFileSync(path.join(source, "package.json"), "changed")
      expect(run().stderr).toContain("conflicts with retained recovery bytes")
      fs.writeFileSync(path.join(source, "package.json"), "package-bytes")
      fs.symlinkSync("/bin/sh", path.join(source, "escape"))
      expect(run().stderr).toContain("package link escapes")
      fs.unlinkSync(path.join(source, "escape"))
      fs.symlinkSync(".", path.join(source, "cycle"))
      expect(run().stderr).toContain("package link cycle")
      fs.unlinkSync(path.join(source, "cycle"))
      fs.unlinkSync(manifestPath)
      fs.unlinkSync(requestPath)
      for (let index = 0; index < 10_000; index++) write(`node_modules/dependency/full-inventory-${index}.js`, "payload")
      const complete = run()
      expect(complete.status, complete.stderr).toBe(0)
      expect(fs.statSync(manifestPath).size).toBeGreaterThan(1_048_576)
      fs.unlinkSync(manifestPath)
      fs.unlinkSync(requestPath)
      const deepPath = Array.from({ length: 3 }, () => "d".repeat(190)).join("/")
      for (let index = 0; index < 12_000; index++) write(`node_modules/dependency/${deepPath}/full-inventory-${index}.js`, "payload")
      const oversized = run()
      expect(oversized.status).not.toBe(0)
      expect(oversized.stderr).toContain("complete package manifest exceeds the root lifecycle 8388608-byte limit")
      expect(fs.existsSync(manifestPath)).toBe(false)
      expect(fs.existsSync(requestPath)).toBe(false)
      expect(fs.readFileSync(token, "utf8")).toBe("synthetic-human-input")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  }, 300_000)

  it("retains authority custody across every failure in the executable activation and four-to-three rollback arm", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "s6-runbook-rollback-"))
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("\nBackup:"))
    const start = update.indexOf('    if test "$(inspect_registry_manifest_digest "$VERSION_IMAGE")')
    const end = update.indexOf('\n    migrate_sanctuary_package_managed_bundle "$IMAGE_ID" commit', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const activation = update.slice(start, end).replace(/^ {4}/gmu, "").replaceAll("/usr/local/bin/node", "transaction")
    const create = helper("create_sanctuary_container")
    const retire = helper("retire_sanctuary_authority_if_pending").replaceAll(process.execPath, "transaction")
    const restore = helper("start_only_butler_for_recovery").replaceAll(process.execPath, "transaction")
    const script = `set -eu
record() { printf '%s\\n' "$*" >>"$LOG"; }
fail() { test "$FAIL" != "$1"; }
inspect_registry_manifest_digest() { fail manifest || return 31; printf '%s' "$MANIFEST_DIGEST"; }
sanctuary_image_mount_contract() { printf canonical-gateway; }
read_sanctuary_authority_state() { cat "$STATE/authority"; }
transaction() {
  record "$2"
  fail "$2" || return 32
  case "$2" in
    authority-activate) test -f "$STATE/new-mounts" || return 1; printf true >"$STATE/running" ;;
    authority-retire) printf retired >"$STATE/authority"; printf false >"$STATE/running" ;;
    authority-restore) test "$(cat "$STATE/authority")" = retired; test "$(cat "$STATE/image")" = "$OLD"; printf true >"$STATE/running" ;;
    rollback) test "$(cat "$STATE/authority")" = retired; test "$(cat "$STATE/running")" = true ;;
  esac
}
docker() {
  case "$*" in
    "image inspect --format {{.Id}} "*) printf '%s' "$IMAGE_ID" ;;
    "create --pull=never --name ouro-butler "*)
      record "$*"; printf '%s' "$IMAGE_ID" >"$STATE/image"; printf '%s' "$*" >"$STATE/new-mounts"; fail create || return 33 ;;
    "inspect --format {{.Image}} ouro-butler") cat "$STATE/image" ;;
    "inspect --format {{.Image}} ouro-butler-rollback") printf '%s' "$OLD" ;;
    "inspect --format {{.State.Running}} ouro-butler-rollback") printf false ;;
    "inspect --format {{.State.Running}} ouro-butler") cat "$STATE/running" ;;
    "container inspect ouro-butler") test -f "$STATE/image" ;;
    "stop ouro-butler") record stop; printf false >"$STATE/running" ;;
    "rm --force ouro-butler") record remove; fail remove || return 34; rm "$STATE/image" ;;
    "rename ouro-butler-rollback ouro-butler")
      test "$(cat "$STATE/authority")" = retired; record rename-three-mount-predecessor
      printf '%s' "$OLD" >"$STATE/image"; cp "$STATE/old-mounts" "$STATE/restored-mounts" ;;
    *) record "unexpected:$*"; return 90 ;;
  esac
}
audit_effective() { record audit; fail audit; }
assert_only_running_butler() { record "residents:$1"; }
assert_update_source() { test "$(cat "$STATE/authority")" = retired; record audit-three-mount-predecessor; }
wait_butler_ready() { record ready; if test "$(cat "$STATE/authority")" != retired; then fail ready; fi; }
enable_butler_autostart() { record autostart; fail autostart; }
migrate_sanctuary_package_managed_bundle() { test "$(cat "$STATE/authority")" = retired; record "bundle:$2"; }
${create}
${retire}
${restore}
${activation}`
    try {
      for (const fault of ["none", "manifest", "create", "audit", "authority-activate", "ready", "mark-committing", "authority-retire", "remove"]) {
        const state = path.join(root, fault)
        fs.mkdirSync(state)
        fs.writeFileSync(path.join(state, "authority"), "installing")
        fs.writeFileSync(path.join(state, "running"), "false")
        fs.writeFileSync(path.join(state, "old-mounts"), "runtime:rw\nbundle:rw\nevents:ro\n")
        const log = path.join(state, "log")
        fs.writeFileSync(log, "")
        // Retirement/removal faults are reached by first failing the target audit.
        const scenarioScript = ["authority-retire", "remove"].includes(fault) ? script.replace("fail audit;", "return 35;") : script
        const result = spawnSync("/bin/sh", ["-c", scenarioScript], { encoding: "utf8", env: { ...process.env, STATE: state, LOG: log, FAIL: fault, IMAGE_ID: newImage, OLD: oldImage, ROLLBACK_IMAGE_ID: oldImage, VERSION_IMAGE: "new", TARGET_MOUNT_CONTRACT: "canonical-gateway", AUDIT_RUNNER_IMAGE_ID: newImage, TEMPLATE_ICON: "icon", MANIFEST_DIGEST: "digest", STAGED_DOCKERMAN_TRANSACTION: "transaction" } })
        const calls = fs.readFileSync(log, "utf8")
        expect(result.status === 0, `${fault}: ${result.stderr}\n${calls}`).toBe(fault === "none")
        if (fault === "none") {
          expect(calls).toContain("authority-activate")
          expect(calls).not.toContain("authority-retire")
        } else if (!["authority-retire", "remove"].includes(fault)) {
          expect(calls.indexOf("authority-retire")).toBeLessThan(calls.indexOf("bundle:rollback"))
          expect(calls.indexOf("bundle:rollback")).toBeLessThan(calls.indexOf("authority-restore"))
          expect(calls.indexOf("authority-restore")).toBeLessThan(calls.lastIndexOf("rollback"))
          expect(fs.readFileSync(path.join(state, "restored-mounts"), "utf8")).toBe("runtime:rw\nbundle:rw\nevents:ro\n")
        } else {
          expect(calls).not.toContain("authority-restore")
          expect(calls).not.toContain("autostart")
        }
        if (fs.existsSync(path.join(state, "new-mounts"))) {
          const mounts = fs.readFileSync(path.join(state, "new-mounts"), "utf8")
          expect(mounts.match(/--mount /gu)).toHaveLength(4)
          expect(mounts).toContain("src=/run/ouro-authority,dst=/run/ouro-authority,readonly")
        }
      }
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
  it("selects the exact image contract rather than the unchanged alpha816 package version", () => {
    const script = `set -eu
validate_exact_image_id() { return 0; }
docker() { printf '%s' "$LABEL"; }
${helper("sanctuary_image_mount_contract")}
sanctuary_image_mount_contract "$IMAGE"`
    for (const [image, label, expected] of [
      [oldImage, "", "canonical-pre-gateway"], [newImage, "canonical-gateway", "canonical-gateway"],
      [legacyImage, "", "legacy-alpha742"], [newImage, "", null], [oldImage, "canonical-gateway", null],
      [newImage, "canonical", null], [legacyImage, "canonical-gateway", null],
    ] as const) {
      const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...process.env, IMAGE: image, LABEL: label } })
      expect(result.status === 0, `${image} ${label}: ${result.stderr}`).toBe(expected !== null)
      if (expected) expect(result.stdout.trim()).toBe(expected)
    }
  })

  it("requires an explicit mount contract at every runbook audit boundary", () => {
    const audit = helper("audit_effective")
    expect(audit).not.toContain("${4-canonical}")
    expect(audit).toContain('canonical-pre-gateway|canonical-gateway)')
    expect(audit).toContain('set -- --mount-contract "$AUDIT_MOUNT_CONTRACT" --expected-image-reference')
    for (const call of runbook.split("\n").filter((line) => /--(?:persistent-template|template) \/audit/u.test(line))) {
      expect(call).toContain("--mount-contract")
    }
    expect(runbook).not.toMatch(/audit_effective .+ canonical /u)
  })

  it("stages the full package and root-only request inputs before the lifecycle can import its owners", () => {
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("\nBackup:"))
    expect(update).toContain('docker cp "$EVENT_ASSET_CONTAINER:/opt/ouro/." "$STAGED_PACKAGE_ROOT/"')
    expect(update).toContain('STAGED_DOCKERMAN_TRANSACTION="$STAGED_PACKAGE_ROOT/deploy/unraid/docker-man-template-transaction.mjs"')
    expect(update).toContain('prepare_sanctuary_authority_inputs "$STAGED_PACKAGE_ROOT"')
    expect(update.indexOf('prepare_sanctuary_authority_inputs "$STAGED_PACKAGE_ROOT"')).toBeLessThan(update.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" prepare'))
    const inputs = helper("prepare_sanctuary_authority_inputs")
    for (const field of ["incoming-package", "package-manifest.json", "request.json", "incoming-token", "packageDigest", "nodeDigest", "prlimitDigest", "setsidDigest", "shellDigest"]) expect(inputs).toContain(field)
    expect(inputs).not.toContain("getUpdates")
    expect(inputs).not.toContain("writeFileSync(token")
  })

  it("orders installation, mounted readiness, and activation without altering cold-boot restart policy", () => {
    const update = runbook.slice(runbook.indexOf("Update:"), runbook.indexOf("\nBackup:"))
    const install = update.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" authority-install')
    const readiness = update.indexOf('verify_sanctuary_telegram_readiness "$IMAGE_ID"')
    const activate = update.indexOf('"$STAGED_DOCKERMAN_TRANSACTION" authority-activate')
    const oldReadiness = update.indexOf('verify_sanctuary_telegram_readiness "$ROLLBACK_IMAGE_ID"')
    const tokenInput = update.indexOf("\n    receive_sanctuary_authority_token\n")
    expect(oldReadiness).toBeGreaterThan(-1)
    expect(tokenInput).toBeGreaterThan(oldReadiness)
    expect(tokenInput).toBeGreaterThan(update.indexOf('prepare_sanctuary_authority_inputs "$STAGED_PACKAGE_ROOT"'))
    expect(tokenInput).toBeGreaterThan(update.indexOf("if disable_butler_autostart"))
    expect(tokenInput).toBeGreaterThan(update.indexOf('(exit "$AUTOSTART_DISABLE_STATUS")'))
    expect(install).toBeGreaterThan(update.indexOf("if disable_butler_autostart"))
    expect(readiness).toBeGreaterThan(install)
    expect(activate).toBeGreaterThan(readiness)
    expect(update.slice(install, activate)).not.toContain("docker start ouro-butler")
    expect(helper("verify_sanctuary_telegram_readiness")).toContain('--mount "type=bind,src=/run/ouro-authority,dst=/run/ouro-authority,readonly"')
    expect(runbook).toContain("unless-stopped and DockerMan autostart remain unchanged")
    expect(runbook).toContain("90-second config materializer")
    expect(runbook).toContain("fresh signed telegram.cursor.snapshot logical progress digest")
    expect(runbook).not.toContain("root-owned typed zero-poller fact")
    expect(runbook).not.toContain("Telegram bootstrap refreshes the canonical agent vault")
  })

  it("blocks legacy recovery before any bundle rollback or raw resident start while authority is pending", () => {
    const recover = helper("recover_pending_sanctuary_bundle_migration")
    expect(recover.indexOf("retire_sanctuary_authority_if_pending")).toBeGreaterThan(-1)
    expect(recover.indexOf("retire_sanctuary_authority_if_pending")).toBeLessThan(recover.indexOf('migrate_sanctuary_package_managed_bundle "$RECOVERY_IMAGE_ID" rollback'))
    expect(helper("start_only_butler_for_recovery")).toContain("authority-restore")
    const template = helper("recover_dockerman_template_transaction")
    expect(template).toContain("retire_sanctuary_authority_if_pending")
  })

  it("executes the real create and rollback shell fixtures with four then three mounts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "s6-runbook-mounts-"))
    try {
      const source = helper("create_sanctuary_container")
      const script = `set -eu
validate_exact_image_id() { return 0; }
sanctuary_image_mount_contract() { if test "$1" = "$OLD"; then printf canonical-pre-gateway; else printf canonical-gateway; fi; }
docker() {
  if test "$1 $2" = "image inspect"; then if test "$5" = old; then printf '%s' "$OLD"; else printf '%s' "$NEW"; fi
  else printf '%s\\n' "$*" >>"$LOG"; fi
}
${source}
create_sanctuary_container "$NEW" new canonical-gateway
create_sanctuary_container "$OLD" old canonical-pre-gateway`
      const log = path.join(root, "calls")
      const result = spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: { ...process.env, OLD: oldImage, NEW: newImage, LOG: log } })
      expect(result.status, result.stderr).toBe(0)
      const calls = fs.readFileSync(log, "utf8").trim().split("\n")
      expect(calls).toHaveLength(2)
      expect(calls.map((call) => (call.match(/--mount /gu) ?? []).length)).toEqual([4, 3])
      expect(calls[0]).toContain("type=bind,src=/run/ouro-authority,dst=/run/ouro-authority,readonly")
      expect(calls[1]).not.toContain("/run/ouro-authority")
      for (const call of calls) expect(call).toContain("--restart unless-stopped --user 10001:10001")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
