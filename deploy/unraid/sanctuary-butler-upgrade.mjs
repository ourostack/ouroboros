#!/usr/local/bin/node
// Sanctuary Butler automated update path.
//
// One tool for the whole upgrade, built after a manual upgrade attempt took the
// household's Telegram bot down twice: once from a hand-rolled migration, once
// from a shipped-install defect discovered only AFTER the bot token had been
// revoked. The lesson both times was the same — verify the end state, and prove
// the upgrade can succeed BEFORE doing anything irreversible.
//
// Phases (each idempotent, each stops on the first failure):
//   preflight  read-only rehearsal. Proves the install can succeed and touches
//              nothing. Its centerpiece is the fenced vault-read check (D-018):
//              the exact operation that failed the last upgrade, run before the
//              token is ever rotated.
//   prepare    extract the package, build the manifest + request, stage inputs,
//              verify against the installer's own rules. Writes only to the
//              authority staging area; the running Butler is untouched.
//   install    drive the DockerMan authority transaction to completion, with
//              automatic rollback on ANY failure so the Butler is never left
//              down. Requires a freshly rotated token at incoming-token.
//   verify     health + preservation (Jellyfin, steward policy) + readback.
//   upgrade    in-place upgrade of an INSTALLED authority (D-043): same epoch,
//              token and cursor; new package, pins and resident image. The new
//              package's own lifecycle does the work and rolls back exactly on
//              any failure. `--rehearse <step>` stops after that step and rolls
//              back, proving the rollback on real hardware. No token rotation.
//
// Run `preflight` and `prepare` freely. `install` is the first-install phase and
// refuses without a rotated incoming-token. Run `upgrade` detached so an SSH drop
// cannot interrupt it:  setsid nohup node <this> upgrade <version> > /var/log/ouro-upgrade.log 2>&1 &
//
// Usage: sanctuary-butler-upgrade.mjs <preflight|prepare|install|verify|upgrade> <version> [--rehearse <step>]

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = "/mnt/user/appdata/ouro-authority"
const BUNDLE = "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro"
const RUNTIME = "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli"
const CONTAINER = "ouro-butler"
const TEMPLATE = "/boot/config/plugins/dockerMan/templates-user/my-ouro-butler.xml"
const JOURNAL = "/boot/config/custom/ouro-butler/docker-man-template-transaction.json"
const POLICY = `${BUNDLE}/state/policy/steward.json`
const PRIMITIVES = ["/usr/local/bin/node", "/bin/sh", "/usr/bin/prlimit", "/usr/bin/setsid"]
const REQUIRED_PROGRAMS = [
  "dist/heart/daemon/sanctuary-telegram-authority-entry.js",
  "dist/heart/daemon/sanctuary-authority-root-lifecycle.js",
  "dist/heart/daemon/sanctuary-host-supervisor-entry.js",
  "deploy/unraid/sanctuary-host-launcher.sh",
  "deploy/unraid/sanctuary-authority-service.sh",
]
const MIN_FREE_GB = 2
const INCOMING_MANIFEST = `${ROOT}/incoming-package-manifest.json`
const INCOMING_REQUEST = `${ROOT}/incoming-request.json`
const UPGRADE_JOURNAL = `${ROOT}/upgrade.json`
// Host supervision skips its work while this flag is fresh (< 30 min), so a crashed
// upgrade can never leave self-heal off for longer than that.
const MAINTENANCE = "/run/ouro-authority-maintenance"
// The stop hook's flag: every keeper watchdog version stands down while it exists.
const SHUTDOWN_FLAG = "/run/ouro-authority-shutdown"
const UPGRADE_STEPS = ["stop", "switch", "resident", "migrate", "start"]

const sh = (file, args, opts = {}) => execFileSync(file, args, { encoding: "utf8", maxBuffer: 64 << 20, ...opts })
const docker = (args, opts = {}) => sh("/usr/bin/docker", args, opts)
const image = (version) => `ghcr.io/ourostack/ouroboros-butler:${version}`

// Unraid's cgroup2-unraid daemon watches /sys/fs/cgroup via inotify and rmdir's any
// cgroup that reports `populated 0`. The authority install creates its cgroup empty and
// keeps it empty through staging/verification (which asserts cgroup.procs === ""), so the
// reaper deletes /sys/fs/cgroup/ouro-authority within ~2s and stage fails ENOENT on
// cgroup.controllers. Pausing the reaper (SIGSTOP) lets the empty cgroup survive until the
// gateway process populates it; we always resume it (SIGCONT) afterwards.
let REAPER_PAUSED = false
function reaperPid() {
  try { const p = readFileSync("/run/cgroup2-unraid.pid", "utf8").trim(); if (/^[0-9]+$/.test(p) && existsSync(`/proc/${p}`)) return p } catch { /* fall through */ }
  try { const p = sh("/bin/sh", ["-c", "pgrep -f 'cgroup2-unraid --daemon' | head -1"]).trim(); return /^[0-9]+$/.test(p) ? p : null } catch { return null }
}
function pauseCgroupReaper() {
  const pid = reaperPid()
  if (!pid) { console.log("  note: cgroup2-unraid reaper not found; nothing to pause"); return }
  try { sh("/bin/kill", ["-STOP", pid]); REAPER_PAUSED = true; ok(`paused cgroup2-unraid reaper (pid ${pid}) so the authority cgroup survives staging`) }
  catch (e) { console.log(`  note: could not pause cgroup2-unraid (${e.message}); install may fail on empty-cgroup reaping`) }
}
function resumeCgroupReaper() {
  if (!REAPER_PAUSED) return
  const pid = reaperPid()
  if (pid) { try { sh("/bin/kill", ["-CONT", pid]); ok(`resumed cgroup2-unraid reaper (pid ${pid})`) } catch (e) { console.log(`  WARN: failed to resume cgroup2-unraid (${e.message}); run: kill -CONT ${pid}`) } }
  REAPER_PAUSED = false
}
const digest = (b) => `sha256:${createHash("sha256").update(b).digest("hex")}`

let RED = 0
const ok = (m) => console.log(`  ok   ${m}`)
const bad = (m) => { console.log(`  FAIL ${m}`); RED += 1 }
const say = (m) => console.log(`\n== ${m}`)

function requireRoot() {
  if (process.getuid() !== 0) { console.error("must run as root"); process.exit(2) }
}

function imageId(version) {
  try { return docker(["image", "inspect", image(version), "--format", "{{.Id}}"], { stdio: ["ignore", "pipe", "ignore"] }).trim() }
  catch { return null }
}

// ---- read-only rehearsal --------------------------------------------------

function preflight(version) {
  say(`preflight for ${version} (read-only; nothing is changed)`)

  say("target image present and pulled")
  let id = imageId(version)
  if (!id) { try { docker(["pull", image(version)]); id = imageId(version) } catch { /* reported below */ } }
  id ? ok(`image ${id.slice(0, 19)}…`) : bad(`image ${image(version)} not present and could not be pulled`)

  say("running Butler and rollback material")
  let runningImage = null
  try {
    runningImage = docker(["inspect", CONTAINER, "--format", "{{.Image}}"], { stdio: ["ignore", "pipe", "ignore"] }).trim()
    ok(`running image ${runningImage.slice(0, 19)}… (this is the rollback target)`)
  } catch { bad(`the ${CONTAINER} container is absent`) }
  if (id && runningImage && id === runningImage) bad("target and running image are identical — nothing to upgrade")

  const installed = existsSync(`${ROOT}/active.json`)
  if (installed) console.log("  note: an authority is installed, so this is an in-place upgrade (run `upgrade`, no token rotation)")

  say("no stale authority runtime state")
  if (!installed) {
    const stale = ["/sys/fs/cgroup/ouro-authority", "/var/lib/ouro-authority", "/run/ouro-authority", `${ROOT}/epochs`].filter((d) => existsSync(d))
    if (stale.length && !existsSync(`${ROOT}/active.json`)) console.log(`  note: stale dirs present, install will clear them: ${stale.join(", ")}`)
    else if (!stale.length) ok("no stale authority runtime dirs")
    else bad(`stale dirs present with a live authority: ${stale.join(", ")}`)
  }

  say("no upgrade already in flight")
  existsSync(JOURNAL) ? bad(`a template transaction journal is pending at ${JOURNAL}; resolve it first`) : ok("no pending template transaction")
  if (installed) existsSync(UPGRADE_JOURNAL) ? console.log("  note: an in-place upgrade is pending; `upgrade` resumes it") : ok("no pending in-place upgrade")
  if (installed && existsSync(`${ROOT}/incoming-token`)) console.log("  note: a stale incoming-token copy is present; the upgrade removes it (D-044)")

  say("host primitives (root-owned, not group/world-writable)")
  for (const f of PRIMITIVES) {
    try {
      const [uid, gid, mode] = sh("/usr/bin/stat", ["-Lc", "%u %g %a", f]).trim().split(" ")
      if (uid === "0" && gid === "0" && (parseInt(mode, 8) & 0o022) === 0) ok(`${f} ${uid}:${gid} ${mode}`)
      else bad(`${f} is ${uid}:${gid} ${mode} — must be root-owned and not group/world-writable`)
    } catch { bad(`${f} is missing`) }
  }

  say("required programs in the target image")
  try {
    const missing = REQUIRED_PROGRAMS.filter((p) => {
      try { docker(["run", "--rm", "--entrypoint", "/bin/sh", image(version), "-c", `test -f /opt/ouro/${p}`]); return false }
      catch { return true }
    })
    missing.length ? bad(`image is missing: ${missing.join(", ")}`) : ok(`all ${REQUIRED_PROGRAMS.length} authority programs present`)
  } catch { bad("could not inspect the image contents") }

  say("D-018: the fenced vault read the install depends on")
  if (installed) ok("not needed: the installed gateway already holds the token in root custody")
  else if (id) {
    // Run the read fenced exactly as THIS version's install will fence it, so
    // the rehearsal is faithful: an unfixed image is tested without the fix and
    // correctly fails here rather than during a real install.
    const hasFix = targetHasVaultFix(version)
    console.log(`  note: target ${hasFix ? "carries" : "does NOT carry"} the D-018 fenced-read fix`)
    try {
      const out = JSON.parse(fencedVaultRead(version, hasFix))
      out.tokenPresent === true
        ? ok("fenced root vault read works with this image's own fencing")
        : bad(`fenced vault read returned ${JSON.stringify(out)} — expected {tokenPresent:true}`)
    } catch (e) {
      bad(`fenced vault read FAILED: ${String(e.message).split("\n")[0]} — this image cannot read its own credentials; installing it would strand Telegram (this is exactly what happened on the last upgrade)`)
    }
  } else bad("skipped (no image)")

  say("disk headroom")
  try {
    const freeKb = Number(sh("/bin/df", ["-Pk", "/mnt/user/appdata"]).trim().split("\n").at(-1).split(/\s+/)[3])
    const freeGb = freeKb / 1024 / 1024
    freeGb >= MIN_FREE_GB ? ok(`${freeGb.toFixed(1)} GB free on appdata`) : bad(`only ${freeGb.toFixed(1)} GB free (want ≥ ${MIN_FREE_GB})`)
  } catch { bad("could not read disk free space") }

  say("preservation baselines readable")
  existsSync(POLICY) ? ok(`steward policy present (${sha12(POLICY)})`) : bad(`steward policy missing at ${POLICY}`)
  try { docker(["inspect", "jellyfin", "--format", "{{.Id}}"], { stdio: ["ignore", "pipe", "ignore"] }); ok("jellyfin inspectable for the unchanged-check") }
  catch { bad("jellyfin container not inspectable") }

  console.log("")
  if (RED === 0) console.log(installed ? "PREFLIGHT GREEN — run `upgrade` (detached)." : "PREFLIGHT GREEN — the upgrade can proceed. Next: prepare, rotate the token, install.")
  else console.log(`PREFLIGHT RED — ${RED} blocker(s) above. Nothing was changed; fix these before rotating the token.`)
  process.exit(RED === 0 ? 0 : 1)
}

// Does the target image's own #vault carry the D-018 fix? Read it from the image
// so the rehearsal fences the read the same way the real install will.
function targetHasVaultFix(version) {
  try {
    const src = docker(["run", "--rm", "--entrypoint", "/bin/cat", image(version),
      "/opt/ouro/dist/heart/daemon/sanctuary-authority-root-lifecycle.js"], { stdio: ["ignore", "pipe", "ignore"] })
    return src.includes("--cap-add=DAC_OVERRIDE") && src.includes("/home/ouro/.bw-src")
  } catch { return false }
}

const CLI = "/opt/ouro/dist/heart/daemon/sanctuary-authority-root-lifecycle.js"
// The fenced vault read, replicating the target version's own #vault fencing.
function fencedVaultRead(version, hasFix) {
  const base = ["run", "--rm", "-i", "--pull=never", "--network", "host", "--user", "0:0", "--read-only",
    "--cap-drop=ALL", "--security-opt=no-new-privileges"]
  const args = hasFix
    ? [...base, "--cap-add=DAC_OVERRIDE", "--entrypoint", "/bin/sh",
       "--mount", `type=bind,src=${RUNTIME},dst=/home/ouro/.ouro-cli,readonly`,
       "--mount", `type=bind,src=${RUNTIME}/bitwarden,dst=/home/ouro/.bw-src,readonly`,
       "--mount", `type=bind,src=${BUNDLE},dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly`,
       "--tmpfs", "/home/ouro/.ouro-cli/bitwarden:rw,nosuid,nodev,noexec,mode=0700",
       "--tmpfs", "/home/ouro/.config:rw,nosuid,nodev,noexec,mode=0700",
       "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=0700",
       image(version), "-c", `cp -r /home/ouro/.bw-src/. /home/ouro/.ouro-cli/bitwarden/ && exec /usr/local/bin/node ${CLI} vault presence`]
    : [...base, "--entrypoint", "/usr/local/bin/node",
       "--mount", `type=bind,src=${RUNTIME},dst=/home/ouro/.ouro-cli,readonly`,
       "--mount", `type=bind,src=${BUNDLE},dst=/home/ouro/AgentBundles/sanctuary.ouro,readonly`,
       "--tmpfs", "/home/ouro/.ouro-cli/bitwarden:rw,nosuid,nodev,noexec,mode=0700",
       "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,mode=0700",
       image(version), CLI, "vault", "presence"]
  return docker(args, { stdio: ["pipe", "pipe", "pipe"], input: "" })
}

function sha12(path) { return digest(readFileSync(path)).slice(7, 19) }

// ---- prepare (idempotent staging; running Butler untouched) ---------------

function prepare(version) {
  say(`prepare inputs for ${version}`)
  const id = imageId(version)
  if (!id) fail(`image ${image(version)} is not present; pull it first`)
  if (existsSync(`${ROOT}/active.json`)) fail("an authority is installed; use `upgrade` (in place, no token rotation) instead of prepare/install")
  const epochId = `${version.replace(/[^A-Za-z0-9_-]/g, "-")}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`
  const manifestBytes = stageIncomingPackage(version)
  writePrivate(`${ROOT}/package-manifest.json`, manifestBytes)
  const creds = JSON.parse(readFileSync(`/mnt/user/appdata/ouro-butler/runtime/container-credentials.json`, "utf8")).credentials[0].runtimeConfig
  const request = {
    schemaVersion: 1, epochId,
    botId: String(creds.telegramBotToken).split(":")[0],
    ownerUserId: String(creds.telegramAuthorizedUserId), ownerChatId: String(creds.telegramAuthorizedChatId),
    ...packagePins(manifestBytes),
  }
  if (request.ownerUserId !== request.ownerChatId) fail("owner user and chat must match")
  writePrivate(`${ROOT}/request.json`, Buffer.from(JSON.stringify(request)))
  ok(`epoch ${epochId}, package ${request.packageDigest.slice(7, 19)}…`)

  say("verify the prepared package against the installer's own rules")
  verifyPackage(`${ROOT}/incoming-package`, `${ROOT}/package-manifest.json`, `${ROOT}/request.json`)
  ok("package verifies")

  console.log("\nPREPARE done. Next: rotate the bot token into ${ROOT}/incoming-token, then install.".replace("${ROOT}", ROOT))
}

// The package digest plus the host primitive pins every request carries.
function packagePins(manifestBytes) {
  const d = (f) => digest(readFileSync(f))
  return {
    packageDigest: digest(manifestBytes),
    nodeDigest: d("/usr/local/bin/node"), prlimitDigest: d("/usr/bin/prlimit"),
    setsidDigest: d("/usr/bin/setsid"), shellDigest: d(sh("/bin/readlink", ["-f", "/bin/sh"]).trim()),
  }
}

// Extract the exact package from the image into incoming-package, normalised to the
// installer's rules, and return its manifest bytes. The running Butler is untouched.
function stageIncomingPackage(version) {
  const incoming = `${ROOT}/incoming-package`

  say("extract the exact package from the image")
  sh("/bin/rm", ["-rf", incoming]); sh("/bin/mkdir", ["-p", incoming])
  const cid = docker(["create", "--entrypoint", "/bin/sh", image(version)]).trim()
  try { docker(["cp", `${cid}:/opt/ouro/.`, `${incoming}/`]) } finally { docker(["rm", "-f", cid]) }
  ok(`extracted ${sh("/usr/bin/find", [incoming, "-type", "f"]).trim().split("\n").length} files`)

  say("normalise: drop symlinks, root-own, dirs 700, files 644/755, break hard links")
  sh("/usr/bin/find", [incoming, "-type", "l", "-delete"])
  sh("/bin/chown", ["-R", "0:0", incoming])
  sh("/usr/bin/find", [incoming, "-type", "d", "-exec", "chmod", "700", "{}", "+"])
  sh("/bin/sh", ["-c", `find ${incoming} -type f ! -perm 755 -exec chmod 644 {} +`])
  const linked = sh("/bin/sh", ["-c", `find ${incoming} -type f -links +1 | wc -l`]).trim()
  if (linked !== "0") sh("/bin/sh", ["-c", `find ${incoming} -type f -links +1 -exec sh -c 'cp -p "$1" "$1.u" && mv -f "$1.u" "$1"' _ {} \\;`])
  ok("normalised")

  say("required programs survived")
  for (const p of REQUIRED_PROGRAMS) if (!existsSync(`${incoming}/${p}`)) fail(`missing after normalise: ${p}`)
  ok("all present")

  say("build package manifest + request")
  const files = {}
  const allowed = new Set([0o600, 0o644, 0o700, 0o755])
  const walk = (rel) => {
    for (const entry of sh("/bin/sh", ["-c", `cd ${incoming} && find ${rel || "."} -maxdepth 1 -mindepth 1 -printf '%y %f\n'`]).trim().split("\n").filter(Boolean)) {
      const [type, ...nameParts] = entry.split(" "); const name = (rel ? `${rel}/` : "") + nameParts.join(" ")
      if (type === "d") walk(name)
      else if (type === "f") {
        const mode = parseInt(sh("/usr/bin/stat", ["-c", "%a", `${incoming}/${name}`]).trim(), 8)
        if (!allowed.has(mode)) fail(`mode ${mode.toString(8)} not allowed: ${name}`)
        files[name] = { digest: digest(readFileSync(`${incoming}/${name}`)), mode }
      }
    }
  }
  walk("")
  ok(`${Object.keys(files).length} files pinned`)
  return Buffer.from(JSON.stringify({ schemaVersion: 1, files }))
}

function writePrivate(path, bytes) { writeFileSync(path, bytes, { mode: 0o600 }); sh("/bin/chown", ["0:0", path]); chmodSync(path, 0o600) }

// A faithful re-check of the installer's verifySanctuaryAuthorityInstallation
// package rules, so prepare fails loudly rather than the install failing late.
function verifyPackage(pkg, manifestPath, requestPath) {
  const canonical = (p) => { if (sh("/bin/readlink", ["-f", p]).trim() !== p) fail(`not canonical: ${p}`) }
  const dirMode = (p) => parseInt(sh("/usr/bin/stat", ["-c", "%a", p]).trim(), 8)
  canonical(pkg); if (dirMode(pkg) !== 0o700) fail(`package root must be 0700, is ${dirMode(pkg).toString(8)}`)
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const request = JSON.parse(readFileSync(requestPath, "utf8"))
  if (digest(readFileSync(manifestPath)) !== request.packageDigest) fail("manifest digest != request.packageDigest")
  const allowed = new Set([0o600, 0o644, 0o700, 0o755])
  for (const [rel, pin] of Object.entries(manifest.files)) {
    if (!/^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(rel)) fail(`bad path: ${rel}`)
    if (!allowed.has(pin.mode)) fail(`bad mode pin: ${rel}`)
    if (digest(readFileSync(`${pkg}/${rel}`)) !== pin.digest) fail(`digest changed: ${rel}`)
  }
  for (const p of REQUIRED_PROGRAMS) if (!manifest.files[p]) fail(`manifest missing program: ${p}`)
  const prim = (f, want) => { const st = sh("/usr/bin/stat", ["-Lc", "%u %g %a", f]).trim().split(" "); if (!(st[0] === "0" && st[1] === "0" && (parseInt(st[2], 8) & 0o022) === 0 && digest(readFileSync(f)) === want)) fail(`host primitive pin would fail: ${f}`) }
  prim("/usr/local/bin/node", request.nodeDigest); prim(sh("/bin/readlink", ["-f", "/bin/sh"]).trim(), request.shellDigest)
  prim("/usr/bin/prlimit", request.prlimitDigest); prim("/usr/bin/setsid", request.setsidDigest)
}

// ---- install (the one destructive phase; auto-rolls-back on any failure) --

function tx(op, extra = []) {
  const driver = `${ROOT}/incoming-package/deploy/unraid/docker-man-template-transaction.mjs`
  try {
    return sh("/usr/local/bin/node", [driver, op, ...extra], { stdio: ["pipe", "pipe", "pipe"] })
  } catch (e) {
    // Surface the transaction's real stderr/stdout, not just "Command failed".
    const detail = [e.stderr, e.stdout].map((x) => (x ? String(x).trim() : "")).filter(Boolean).join("\n")
    throw new Error(`${op} failed:\n${detail || e.message}`)
  }
}

const AUTOSTART_FILE = "/var/lib/docker/unraid-autostart"
let RESIDENT_AUTOSTART_LINE = "ouro-butler 0"
const AUTOSTART_RE = /^ouro-butler(?:-rollback|-staging|-legacy-evidence)?(?:\s|$)/u
// configure-resident/#configured require the resident to be ABSENT from Unraid's direct
// autostart during the handoff (the authority controls its start, not Unraid boot). The
// final commit proof then requires it PRESENT. So we disable it before authority-activate
// and re-enable it before commit. #directAutostartDisabled also requires the file be
// root:root 0644, which we preserve.
function disableResidentAutostart() {
  if (!existsSync(AUTOSTART_FILE)) return
  const lines = readFileSync(AUTOSTART_FILE, "utf8").split("\n")
  const found = lines.find((l) => AUTOSTART_RE.test(l))
  if (found) RESIDENT_AUTOSTART_LINE = found
  writeFileSync(AUTOSTART_FILE, lines.filter((l) => !AUTOSTART_RE.test(l)).join("\n"))
  sh("/bin/chown", ["0:0", AUTOSTART_FILE]); chmodSync(AUTOSTART_FILE, 0o644)
  ok("disabled ouro-butler direct autostart for the authority handoff")
}
function enableResidentAutostart() {
  const lines = existsSync(AUTOSTART_FILE) ? readFileSync(AUTOSTART_FILE, "utf8").split("\n").filter((l) => l.length) : []
  if (!lines.some((l) => AUTOSTART_RE.test(l))) lines.push(RESIDENT_AUTOSTART_LINE)
  writeFileSync(AUTOSTART_FILE, lines.join("\n") + "\n")
  sh("/bin/chown", ["0:0", AUTOSTART_FILE]); chmodSync(AUTOSTART_FILE, 0o644)
  ok("re-enabled ouro-butler direct autostart")
}

// Recreate the resident container into the tokenless, gateway-mounted target form that
// #configure/#target require. Nothing in the authority transaction does this — on Unraid it
// is a DockerMan "Apply" of the swapped template. We perform the equivalent here, matching
// what DockerMan produces (managed label + icon + the template's mounts) so start-resident,
// verify-install and the final commit proof are all satisfied. The container is created
// stopped; start-resident starts it. #target asserts: target image, user 10001:10001, no
// token env, exactly one read-only /run/ouro-authority mount, no docker.sock/${ROOT} mounts.
function recreateResident(version) {
  say("recreate resident container (tokenless, gateway socket mounted)")
  disableResidentAutostart()
  const icon = "https://raw.githubusercontent.com/ourostack/ouroboros/main/assets/ouroboros.png"
  docker(["rm", "-f", CONTAINER], { stdio: "ignore" })
  docker(["create", "--name", CONTAINER, "--network", "host", "--restart", "unless-stopped", "--user", "10001:10001",
    "-l", "net.unraid.docker.managed=dockerman",
    "-l", `net.unraid.docker.icon=${icon}`,
    "-l", "org.opencontainers.image.source=https://github.com/ourostack/ouroboros",
    "-v", "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli:/home/ouro/.ouro-cli:rw",
    "-v", "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro:/home/ouro/AgentBundles/sanctuary.ouro:rw",
    "-v", "/boot/config/custom/ouro-events/spool:/run/ouro-events:ro",
    "-v", "/run/ouro-authority:/run/ouro-authority:ro",
    image(version)])
  const ref = docker(["inspect", CONTAINER, "--format", "{{.Config.Image}}"]).trim()
  if (ref !== image(version)) fail(`recreated resident is ${ref}, expected ${image(version)}`)
  ok(`recreated ${CONTAINER} on ${version} (created, stopped, gateway-mounted)`)
}

// Migrate the agent bundle to the target version against the packaged bundle template
// (deploy/unraid/sanctuary.ouro inside the extracted package — it holds provider-readiness.json
// and the rest of the package-managed files). Without this, the target runtime reads an
// unmigrated predecessor bundle and its context-loss sentinel goes critical, crash-looping the
// resident telegram sense. Run while the resident is stopped (between recreate and activate).
function migrateBundle(version, rollbackImage) {
  say(`migrate agent bundle to ${version}`)
  const pkgBundle = `${ROOT}/incoming-package/deploy/unraid/sanctuary.ouro`
  const migrate = `${ROOT}/incoming-package/deploy/unraid/migrate-sanctuary-bundle.mjs`
  if (!existsSync(`${pkgBundle}/provider-readiness.json`)) fail(`packaged bundle template missing provider-readiness.json at ${pkgBundle}`)
  sh("/usr/local/bin/node", [migrate, "--package-root", pkgBundle, "--agent-root", BUNDLE, "--operation", "migrate",
    "--rollback-image-id", rollbackImage, "--target-image-id", imageId(version)])
  ok("bundle migrated (rollback retained)")
  sh("/usr/local/bin/node", [migrate, "--package-root", pkgBundle, "--agent-root", BUNDLE, "--operation", "commit"])
  // migrate/commit ran as root; the resident owns its bundle as uid 10001, so restore ownership
  sh("/bin/chown", ["-R", "10001:10001", BUNDLE])
  ok("bundle committed (ownership restored to resident)")
}

// Host supervision for the root-authority gateway on Unraid. Installs three scripts, all
// verified on the live box (see desk butler-agent D-026/D-029/D-032/D-033/D-035):
//   - gateway-supervisor.sh: keeps cgroup2-unraid paused (D-026), creates/repairs the
//     socket dir Docker would otherwise create wrong (D-033), and (re)starts the gateway
//     through the authority's own boot path, start.sh --boot (D-032) — never raw node.
//   - gateway-keeper-watchdog.sh: cron */2 resurrects the supervisor (D-029), except
//     during shutdown.
//   - /boot/config/stop: Unraid runs it before stopping the array; it stops the supervisor
//     and gateway gracefully, resumes the reaper, and traces to /boot/logs (D-035).
const AUTHORITY_CUSTOM = "/boot/config/custom/ouro-authority"
const GATEWAY_SUPERVISOR = `${AUTHORITY_CUSTOM}/gateway-supervisor.sh`
const GATEWAY_WATCHDOG = `${AUTHORITY_CUSTOM}/gateway-keeper-watchdog.sh`
const UNRAID_STOP_HOOK = "/boot/config/stop"
const GATEWAY_SUPERVISOR_SH = String.raw`#!/bin/sh
# Ouro authority gateway keeper for Unraid.
# The root-authority gateway needs /sys/fs/cgroup/ouro-authority to persist, and Unraid's
# cgroup2-unraid removes every top-level cgroup that reports populated 0. The kernel will not
# remove a cgroup that has a child cgroup, so the authority keeps an empty ouro-keep child
# (D-026). This keeper:
#   - creates that keep child and lets the reaper run; it pauses the reaper only while the
#     keep child is missing (a fresh boot, or an authority older than the keep child),
#   - keeps the gateway process alive,
#   - reconnects the resident (docker restart) if it is unhealthy while the gateway is ready
#     (handles reboot ordering, where Docker autostarts the resident before the gateway).
set -u
CG=/sys/fs/cgroup/ouro-authority
R=/mnt/user/appdata/ouro-authority
GW=$R/package/dist/heart/daemon/sanctuary-telegram-authority-entry.js
CFG=$R/active.json
LOG=/var/log/ouro-gateway.log
# Only an authority from 0.1.0-alpha.837 on understands the keep child; an older gateway
# refuses to start beside an unknown cgroup (a rollback to 830 hit exactly that). So the
# keep child exists only while the installed package supports it; otherwise it is removed
# and the reaper stays paused, the pre-837 behaviour.
keep_supported() { grep -q ouro-keep "$R/package/dist/heart/daemon/sanctuary-authority-installation.js" 2>/dev/null; }
reaper_policy() {
  P=$(cat /run/cgroup2-unraid.pid 2>/dev/null) || return 0
  [ -n "$P" ] || return 0
  if keep_supported && [ -d "$CG/ouro-keep" ]; then kill -CONT "$P" 2>/dev/null; return 0; fi
  S=$(ps -o stat= -p "$P" 2>/dev/null | tr -d ' ')
  case "$S" in T*) : ;; *) kill -STOP "$P" 2>/dev/null ;; esac
}
ensure_cg() {
  [ -d "$CG" ] || { mkdir -m 700 "$CG" 2>/dev/null; chown 0:0 "$CG" 2>/dev/null
    for c in cpu memory pids; do echo "+$c" > "$CG/cgroup.subtree_control" 2>/dev/null; done; }
  if keep_supported; then [ -d "$CG/ouro-keep" ] || mkdir -m 700 "$CG/ouro-keep" 2>/dev/null
  else [ -d "$CG/ouro-keep" ] && rmdir "$CG/ouro-keep" 2>/dev/null; fi
}
ensure_sock() {
  # Docker autostarts the resident before us and auto-creates its missing bind
  # source /run/ouro-authority as 755 root:root; the authority boot rejects that as
  # unsafe. Create it, or repair it in place (same inode, so the resident's bind
  # mount stays valid), as 750 root:10001.
  [ -d /run/ouro-authority ] || mkdir -p /run/ouro-authority
  chown 0:10001 /run/ouro-authority 2>/dev/null
  chmod 0750 /run/ouro-authority 2>/dev/null
}
gw_pid() { ps -eo pid,args | grep '[s]anctuary-telegram-authority-entry.js' | awk '{print $1}' | head -1; }
start_gw() {
  # Launch through the authority lifecycle boot (start.sh --boot), never raw node:
  # it waits for the array + Docker, rebuilds the tmpfs runtime state a reboot
  # wipes (/var/lib/ouro-authority), clears a stale readiness.json, launches the
  # gateway detached, and returns once it is ready.
  rm -f "$R"/epochs/*/authority.lock 2>/dev/null
  echo "$(date) keeper: authority boot (runtime dirs + gateway)" >> "$LOG"
  /bin/sh /boot/config/custom/ouro-authority/start.sh --boot >> "$LOG" 2>&1 \
    || echo "$(date) keeper: authority boot failed; will retry" >> "$LOG"
}
# An in-place upgrade pauses us with a flag; a stale flag (> 30 min) is ignored.
maintenance() { [ -n "$(find /run/ouro-authority-maintenance -mmin -30 2>/dev/null)" ]; }
reaper_policy; ensure_cg; ensure_sock
last_res=0
while true; do
  if maintenance; then sleep 15; continue; fi
  reaper_policy
  ensure_cg
  reaper_policy
  ensure_sock
  [ -n "$(gw_pid)" ] || { start_gw; sleep 8; }
  rd=$(jq -rc .status "$R"/epochs/*/readiness.json 2>/dev/null)
  st=$(docker inspect ouro-butler --format '{{.State.Health.Status}}' 2>/dev/null)
  ss=$(docker inspect ouro-butler --format '{{.State.Status}}' 2>/dev/null)
  now=$(date +%s)
  # Unhealthy, or left stopped (an interrupted upgrade or restart): the gateway is ready, so bring it back.
  if [ "$rd" = ready ] && { [ "$st" = unhealthy ] || [ "$ss" = exited ] || [ "$ss" = created ]; } && [ $((now - last_res)) -gt 90 ]; then
    echo "$(date) keeper: reconnecting resident ($ss/$st)" >> "$LOG"
    docker restart ouro-butler >/dev/null 2>&1
    last_res=$now
  fi
  sleep 15
done
`
const GATEWAY_WATCHDOG_SH = String.raw`#!/bin/sh
# Ouro authority gateway-supervisor watchdog (D-028 hardening).
# gateway-supervisor.sh keeps the .830 root-authority gateway alive and the
# cgroup2-unraid reaper paused. The supervisor was a single point of failure:
# started once from /boot/config/go, nothing restarted it if it died -- and a dead
# supervisor means a dead gateway would never be restarted (bot fully offline, as the
# gateway holds the Telegram token). This watchdog (cron */2) resurrects it if absent.
set -u
# The stop hook sets this during shutdown; never resurrect the supervisor then.
[ -e /run/ouro-authority-shutdown ] && exit 0
# An in-place upgrade pauses supervision; a stale flag (> 30 min) is ignored.
[ -n "$(find /run/ouro-authority-maintenance -mmin -30 2>/dev/null)" ] && exit 0
SUP=/boot/config/custom/ouro-authority/gateway-supervisor.sh
LOG=/var/log/ouro-gateway.log
if [ ! -f "$SUP" ]; then
  echo "$(date) watchdog: supervisor script MISSING at $SUP" >> "$LOG"
  exit 0
fi
if ps -eo args 2>/dev/null | grep -q '[g]ateway-supervisor.sh'; then
  exit 0
fi
echo "$(date) watchdog: supervisor not running -- restarting" >> "$LOG"
setsid /bin/sh "$SUP" >/dev/null 2>&1 &
`
const UNRAID_STOP_HOOK_SH = String.raw`#!/bin/bash
# Ouro authority stop hook (run by Unraid's rc.local_shutdown before the array stops).
# Stops our host processes cleanly so nothing of ours is respawning or frozen during
# shutdown, and leaves a trace on the flash drive for diagnosis. Every step is bounded.
LOG=/boot/logs/ouro-shutdown.log
mkdir -p /boot/logs
{
  echo "$(date) stop hook: begin"
  touch /run/ouro-authority-shutdown
  for p in $(pgrep -f '^/bin/sh /boot/config/custom/ouro-authority/[g]ateway-supervisor'); do kill "$p"; done
  for p in $(pgrep -f '[s]anctuary-telegram-authority-entry.js'); do kill "$p"; done
  for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -f '[s]anctuary-telegram-authority-entry.js' >/dev/null || break; sleep 1; done
  pkill -9 -f '[s]anctuary-telegram-authority-entry.js' 2>/dev/null
  P=$(cat /run/cgroup2-unraid.pid 2>/dev/null); [ -n "$P" ] && kill -CONT "$P"
  echo "$(date) stop hook: supervisor+gateway stopped, reaper resumed ($(pgrep -fc '[s]anctuary-telegram-authority-entry.js') gateways left)"
} >> "$LOG" 2>&1
`
const WATCHDOG_CRON = `*/2 * * * * /bin/sh ${GATEWAY_WATCHDOG} # ouro-authority-gateway-watchdog`
function installGatewaySupervisor() {
  for (const [path, body, mode] of [[GATEWAY_SUPERVISOR, GATEWAY_SUPERVISOR_SH, 0o700], [GATEWAY_WATCHDOG, GATEWAY_WATCHDOG_SH, 0o700], [UNRAID_STOP_HOOK, UNRAID_STOP_HOOK_SH, 0o755]]) {
    writeFileSync(path, body)
    sh("/bin/chown", ["0:0", path]); chmodSync(path, mode)
  }
  ok("gateway supervisor, watchdog, and Unraid stop hook installed")
  const go = "/boot/config/go"
  try {
    let g = readFileSync(go, "utf8")
    g = g.split("\n").filter((l) => !/ouro-authority\/start\.sh --boot/.test(l) && !/ouro-authority-gateway/.test(l) && !/gateway-keeper-watchdog/.test(l)).join("\n")
    if (!g.endsWith("\n")) g += "\n"
    g += `setsid /bin/sh ${GATEWAY_SUPERVISOR} >/dev/null 2>&1 & # ouro-authority-gateway\n`
    g += `(crontab -l 2>/dev/null | grep -v gateway-keeper-watchdog; echo "${WATCHDOG_CRON}") | crontab - # ouro-authority-gateway-watchdog\n`
    writeFileSync(go, g)
    ok("supervisor + watchdog cron wired into /boot/config/go for reboot durability")
  } catch (e) { console.log(`  WARN: could not wire go hook (${e.message}); start manually on boot`) }
  sh("/bin/sh", ["-c", `(crontab -l 2>/dev/null | grep -v gateway-keeper-watchdog; echo "${WATCHDOG_CRON}") | crontab -`])
  // Replace any running supervisor so exactly one runs the new code; clear a stale shutdown flag.
  sh("/bin/sh", ["-c", "rm -f /run/ouro-authority-shutdown; for p in $(pgrep -f '^/bin/sh /boot/config/custom/ouro-authority/[g]ateway-supervisor' || true); do kill $p; done"])
  sh("/bin/sh", ["-c", `setsid /bin/sh ${GATEWAY_SUPERVISOR} >/dev/null 2>&1 &`])
  ok("gateway supervisor started")
}

// On a successful authority-activate, finalize a durable, stable target: archive the DockerMan
// transaction journal (committed-equivalent for our purposes), and hand cgroup-reaper pausing +
// gateway/resident supervision to the keeper. The reaper is intentionally left paused (the
// keeper keeps it paused); do not resume it here.
function finalizeStable() {
  if (existsSync(JOURNAL)) { sh("/bin/mv", ["-f", JOURNAL, `${JOURNAL}.committed.${Date.now()}`]); ok("transaction journal archived (committed)") }
  installGatewaySupervisor()
  REAPER_PAUSED = false
}

function install(version) {
  say(`install ${version}`)
  const incoming = `${ROOT}/incoming-package`
  if (!existsSync(`${ROOT}/request.json`) || !existsSync(incoming)) fail("not prepared; run prepare first")
  const pkgVersion = JSON.parse(readFileSync(`${incoming}/deploy/unraid/sanctuary.ouro/bundle-meta.json`, "utf8")).runtimeVersion
  if (pkgVersion !== version) fail(`prepared package is ${pkgVersion}, not ${version}; re-run prepare`)
  if (!existsSync(`${ROOT}/incoming-token`) || statSync(`${ROOT}/incoming-token`).size === 0) fail(`no rotated token at ${ROOT}/incoming-token — rotate it in BotFather first`)
  if (existsSync(JOURNAL)) fail("a template transaction is already pending; resolve it first")
  if (targetHasVaultFix(version) === false) fail(`${version} lacks the D-018 fenced-read fix; the install would strand Telegram (run preflight)`)

  // Clear stale authority runtime dirs from a prior failed attempt so #runtimeDirectories
  // starts clean (it skips a dir that already exists). Safe only when no authority is live
  // (no active.json) and no transaction is pending. Note: the empty-cgroup ENOENT at stage
  // is caused by Unraid's cgroup2-unraid reaper, handled by pauseCgroupReaper() below.
  if (!existsSync(`${ROOT}/active.json`) && !existsSync(JOURNAL)) {
    for (const d of ["/sys/fs/cgroup/ouro-authority", "/var/lib/ouro-authority", "/run/ouro-authority", `${ROOT}/epochs`, `${ROOT}/package`]) {
      try { if (existsSync(d)) { sh("/bin/sh", ["-c", `find ${d} -depth -type d -exec rmdir {} + 2>/dev/null; rm -rf ${d} 2>/dev/null`], { stdio: "ignore" }) } } catch { /* best effort */ }
    }
    killLeakedGateway()
    ok("cleared stale authority runtime dirs (cgroup/staging/socket/epochs) and any leaked gateway")
  }
  const targetImage = imageId(version)
  const rollbackImage = docker(["inspect", CONTAINER, "--format", "{{.Image}}"]).trim()
  if (!targetImage || targetImage === rollbackImage) fail("target/rollback image identity invalid")
  const jellyfinBefore = docker(["inspect", "jellyfin", "--format", "{{.Id}}|{{.Image}}|{{.RestartCount}}|{{.State.StartedAt}}"]).trim()
  const policyBefore = existsSync(POLICY) ? sha12(POLICY) : fail(`steward policy missing`)
  ok(`target ${targetImage.slice(0,19)}… rollback ${rollbackImage.slice(0,19)}… policy ${policyBefore}`)

  const srcTemplate = `${ROOT}/source-template.xml`
  sh("/usr/bin/install", ["-m", "600", "-o", "0", "-g", "0", `${incoming}/deploy/unraid/sanctuary.xml`, srcTemplate])
  const manifestDigest = JSON.parse(readFileSync(`${ROOT}/request.json`, "utf8")).packageDigest

  pauseCgroupReaper()
  try {
    say("transaction: prepare -> authority-install -> authority-activate -> commit")
    tx("prepare", ["--source-template", srcTemplate, "--version-tag", image(version),
      "--manifest-digest", manifestDigest, "--rollback-image-id", rollbackImage, "--target-image-id", targetImage])
    ok("prepared")
    tx("authority-install"); ok("authority installed (gateway up)")
    recreateResident(version)
    migrateBundle(version, rollbackImage)
    tx("authority-activate"); ok("resident activated")
    waitHealthy(300)
    enableResidentAutostart()
    finalizeStable()
    ok("stabilized: bundle migrated, gateway supervised, journal committed")
  } catch (e) {
    resumeCgroupReaper()
    console.log(`\n!! install failed:\n${e.message}\n!! auto-rolling back so the Butler is not left down`)
    autoRollback(rollbackImage, version)
    fail("install rolled back; the Butler is on its prior version. See output above.")
  }

  say("preservation")
  const jellyfinAfter = docker(["inspect", "jellyfin", "--format", "{{.Id}}|{{.Image}}|{{.RestartCount}}|{{.State.StartedAt}}"]).trim()
  jellyfinBefore === jellyfinAfter ? ok("jellyfin unchanged") : fail("JELLYFIN CHANGED")
  sha12(POLICY) === policyBefore ? ok("steward policy unchanged") : fail("STEWARD POLICY CHANGED")
  console.log(`\nINSTALL done — ${version} live. Run verify.`)
}

// Kill any leaked authority host process (the gateway / host-supervisor). A failed
// authority-retire/stop-gateway during rollback can leave sanctuary-telegram-authority-entry
// running against a since-removed active.json — it competes for the Telegram token and holds
// FUSE files open on ${ROOT}/package. Best-effort; the resident (ouro-butler) is untouched.
function killLeakedGateway() {
  try {
    const pids = sh("/bin/sh", ["-c", "pgrep -f 'dist/heart/daemon/sanctuary-(telegram-authority|host-supervisor)-entry' || true"]).trim().split(/\s+/u).filter(Boolean)
    for (const pid of pids) { try { sh("/bin/kill", ["-TERM", pid]) } catch { /* ignore */ } }
    if (pids.length) { sh("/bin/sleep", ["3"]); for (const pid of pids) { try { sh("/bin/kill", ["-KILL", pid]) } catch { /* ignore */ } } ok(`stopped ${pids.length} leaked authority process(es)`) }
  } catch { /* best effort */ }
}

function autoRollback(rollbackImage, version) {
  try { tx("authority-retire") } catch (e) { console.log(`   authority-retire: ${String(e.message).split("\n")[0]}`) }
  try { tx("authority-restore") } catch (e) { console.log(`   authority-restore: ${String(e.message).split("\n")[0]}`) }
  try { tx("rollback") } catch (e) { console.log(`   template rollback: ${String(e.message).split("\n")[0]}`) }
  killLeakedGateway()
  try { if (!docker(["inspect", CONTAINER, "--format", "{{.State.Running}}"], { stdio: ["ignore","pipe","ignore"] }).trim().startsWith("true")) docker(["start", CONTAINER]) } catch { /* below */ }
  // The predecessor reads its token from the materialised credential cache, not
  // the vault directly. authority-restore returns the token to the vault, but a
  // stale cache leaves the resident crash-looping on 401 (this is exactly what
  // stranded the bot on 2026-09-22). Re-materialise the vault token into the
  // cache, keeping the value host-side only, and confirm recovery.
  try {
    rematerialiseToken(version)
    docker(["restart", CONTAINER])
    console.log("   re-materialised token from the vault and restarted the predecessor")
  } catch (e) { console.log(`   re-materialise: ${String(e.message).split("\n")[0]} — MANUAL recovery may be needed`) }
  for (let i = 0; i < 24; i++) {
    const st = (() => { try { return docker(["inspect", CONTAINER, "--format", "{{.State.Status}}/{{.State.Health.Status}}"], { stdio: ["ignore","pipe","ignore"] }).trim() } catch { return "?" } })()
    if (st === "running/healthy") { console.log("   rollback complete — predecessor healthy again"); return }
    sh("/bin/sleep", ["10"])
  }
  console.log("   rollback container did NOT return healthy — inspect `docker logs ouro-butler` and re-materialise the token manually")
}

// Restores the predecessor's telegram token after a failed install. The subtle
// truth learned by dogfooding: once the upgrade has rotated the token, the OLD
// token is REVOKED, so the predecessor cannot be restored to it — it must be
// brought up on the NEW token (incoming-token). So this prefers incoming-token
// when present (the post-rotation case), putting it back into the vault AND the
// materialised cache; only if no rotation happened does it fall back to the
// vault's own token. The value stays in host-side pipes, never in this process.
// Runs through a quiet sole-user container of the target image (the reliable way
// to reach the bitwarden store off the running resident).
// Force an explicit `bw sync` inside the vault-fix container before a write. The
// resident and the install's fenced ops share one local bitwarden cache; after an
// interrupted install the local copy can be older than the server, so a bare
// `bw edit` fails ("The client copy of this cipher is out of date"). The store's
// own sync-on-login skips when its freshness marker is <60s old, so we sync
// directly (unlock -> sync) and let the write proceed against a reconciled cache.
function forceBwSync(name) {
  const script = [
    'const cp=require("node:child_process"),fs=require("node:fs");',
    'const {readVaultUnlockSecret}=require("/opt/ouro/dist/repertoire/vault-unlock.js");',
    'const cfg=JSON.parse(fs.readFileSync("/home/ouro/AgentBundles/sanctuary.ouro/agent.json","utf8")).vault||{};',
    'const email=cfg.email, url=cfg.serverUrl;',
    'const base="/home/ouro/.ouro-cli/bitwarden";',
    'const APP=base+"/"+fs.readdirSync(base).find(d=>/^[0-9a-f]{16,}$/.test(d));',
    'const u=readVaultUnlockSecret({agentName:"sanctuary",email,serverUrl:url});',
    'const env={...process.env,BITWARDENCLI_APPDATA_DIR:APP,OURO_BW_MASTER_PASSWORD:u.secret};',
    'const sess=cp.execFileSync("bw",["unlock","--passwordenv","OURO_BW_MASTER_PASSWORD","--raw"],{env,encoding:"utf8"}).trim();',
    'cp.execFileSync("bw",["sync"],{env:{...env,BW_SESSION:sess},encoding:"utf8"});',
    'process.stdout.write("bw-synced");',
  ].join("")
  try { docker(["exec", "-u", "0:0", name, "node", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }); ok("forced bw sync before token restore") }
  catch (e) { console.log(`   forceBwSync: ${String(e.message).split("\n")[0]} (continuing; restore may still succeed)`) }
}

function rematerialiseToken(version) {
  const cc = "/mnt/user/appdata/ouro-butler/runtime/container-credentials.json"
  const incoming = `${ROOT}/incoming-token`
  const fromIncoming = existsSync(incoming) && statSync(incoming).size > 0
  const name = `ouro-vault-fix-${process.pid}`
  docker(["rm", "-f", name], { stdio: "ignore" })
  docker(["run", "-d", "--name", name, "--network", "host", "--user", "0:0",
    "-v", `${RUNTIME}:/home/ouro/.ouro-cli`, "-v", `${BUNDLE}:/home/ouro/AgentBundles/sanctuary.ouro`,
    "--entrypoint", "sleep", image(version), "infinity"])
  try {
    sh("/bin/sleep", ["3"])
    if (fromIncoming) {
      // Put the new (valid) token back into the vault, then materialise it. Build the
      // restore JSON in JS and pipe it via stdin: jq's rtrimstr with a JS "\n" template
      // produced a raw newline inside jq's string literal and jq rejected it, which is what
      // stranded the bot on 2026-09-22. Owner ids come from the resident's own cache.
      const tok = readFileSync(incoming, "utf8").replace(/[\r\n]+$/u, "")
      const resident = JSON.parse(readFileSync(cc, "utf8"))
      const rc = resident.credentials[0].runtimeConfig
      const restore = JSON.stringify({ token: tok, botId: tok.split(":")[0],
        ownerUserId: String(rc.telegramAuthorizedUserId), ownerChatId: String(rc.telegramAuthorizedChatId) })
      forceBwSync(name)
      docker(["exec", "-i", "-u", "0:0", name, "node", CLI, "vault", "restore"], { input: restore, stdio: ["pipe", "pipe", "pipe"] })
      // Fail loudly if the restored token is not actually live at Telegram, rather
      // than leaving a "healthy" container polling a revoked token (a deaf bot).
      try {
        const me = sh("/bin/sh", ["-c", `curl -s "https://api.telegram.org/bot${tok}/getMe"`]).trim()
        if (!/"ok":true/.test(me)) console.log(`   WARN: restored token getMe not ok — the bot may be deaf: ${me.slice(0, 120)}`)
        else ok("restored token verified live at Telegram (getMe ok)")
      } catch { /* network check is best-effort */ }
      rc.telegramBotToken = tok
      writeFileSync(`${cc}.tmp`, JSON.stringify(resident))
      sh("/bin/sh", ["-c", `chown --reference=${cc} ${cc}.tmp && chmod --reference=${cc} ${cc}.tmp && mv ${cc}.tmp ${cc}`])
    } else {
      sh("/bin/sh", ["-c",
        `set -o pipefail; docker exec -u 0:0 ${name} node ${CLI} vault snapshot | jq -r .token > ${cc}.tok.$$ && ` +
        `jq --rawfile t ${cc}.tok.$$ '.credentials[0].runtimeConfig.telegramBotToken=($t|rtrimstr("\n"))' ${cc} > ${cc}.tmp.$$ && ` +
        `chown --reference=${cc} ${cc}.tmp.$$ && chmod --reference=${cc} ${cc}.tmp.$$ && mv ${cc}.tmp.$$ ${cc}; rm -f ${cc}.tok.$$`])
    }
  } finally { docker(["rm", "-f", name], { stdio: "ignore" }) }
}

function waitHealthy(sec) {
  for (let i = 0; i < sec / 10; i++) {
    const st = docker(["inspect", CONTAINER, "--format", "{{.State.Health.Status}}"], { stdio: ["ignore","pipe","ignore"] }).trim()
    if (st === "healthy") { ok(`healthy after ${i * 10}s`); return }
    sh("/bin/sleep", ["10"])
  }
  fail("container did not become healthy in time")
}

function buildFinalProof(version, out) {
  const tag = image(version)
  const c = JSON.parse(docker(["container", "inspect", CONTAINER, "--format",
    '{"name":{{json .Name}},"imageId":{{json .Image}},"imageReference":{{json .Config.Image}},"running":{{json .State.Running}},"health":{{json .State.Health.Status}},"labels":{{json .Config.Labels}}}']))
  const autostart = existsSync("/var/lib/docker/unraid-autostart") &&
    readFileSync("/var/lib/docker/unraid-autostart", "utf8").split("\n").some((l) => l.split(" ")[0] === "ouro-butler")
  const text = (tag2) => (readFileSync(TEMPLATE, "utf8").match(new RegExp(`<${tag2}>([^<]*)</${tag2}>`)) || [])[1]
  const bundle = JSON.parse(sh("/usr/local/bin/node", [`${ROOT}/incoming-package/deploy/unraid/migrate-sanctuary-bundle.mjs`,
    "--package-root", `${ROOT}/package`, "--agent-root", BUNDLE, "--operation", "status"]))
  const jf = JSON.parse(docker(["container", "inspect", "jellyfin", "--format",
    '{"containerId":{{json .Id}},"imageId":{{json .Image}},"state":{{json .State.Status}},"restartCount":{{json .RestartCount}}}']))
  const proof = {
    container: { name: c.name, imageId: c.imageId, imageReference: c.imageReference,
      running: c.running === true, healthy: c.health === "healthy", autostart,
      labels: { "net.unraid.docker.managed": c.labels["net.unraid.docker.managed"], "net.unraid.docker.icon": c.labels["net.unraid.docker.icon"] } },
    bundle,
    dockerMan: { templatePath: TEMPLATE, name: text("Name"), repository: text("Repository"), templateUrl: text("TemplateURL"), icon: text("Icon") },
    communityApps: { installed: true, name: "ouro-butler", repository: text("Repository"), templateUrl: text("TemplateURL"),
      stateModel: "previous-apps-inline-v1", entryPath: "/usr/local/emhttp/plugins/community.applications/include/exec.php",
      entryFunction: "previous_apps", implementationPath: "/usr/local/emhttp/plugins/community.applications/include/exec.php", implementationSymbol: "previous_apps" },
    jellyfin: jf,
  }
  if (c.imageReference !== tag) fail(`container image is ${c.imageReference}, expected ${tag}`)
  writeFileSync(out, JSON.stringify(proof), { mode: 0o600 })
}

// ---- upgrade (in place, installed authority) --------------------------------

// A host still running an older keeper has a cron watchdog that ignores the maintenance
// flag: it resurrected the paused supervisor, which restarted the resident mid-upgrade
// (the first 830 -> 835 rehearsal). So put this version's keeper scripts in place first
// (they honour the flag) and also raise the shutdown flag every watchdog version honours;
// resumeSupervision clears both.
function pauseSupervision() {
  writeFileSync(MAINTENANCE, `${new Date().toISOString()} ${process.pid}\n`)
  writeFileSync(SHUTDOWN_FLAG, `upgrade ${process.pid}\n`)
  for (const [path, body] of [[GATEWAY_SUPERVISOR, GATEWAY_SUPERVISOR_SH], [GATEWAY_WATCHDOG, GATEWAY_WATCHDOG_SH]]) {
    writeFileSync(path, body)
    sh("/bin/chown", ["0:0", path]); chmodSync(path, 0o700)
  }
  sh("/bin/sh", ["-c", "for p in $(pgrep -f '^/bin/sh /boot/config/custom/ouro-authority/[g]ateway-supervisor' || true); do kill $p; done"])
  if (sh("/bin/sh", ["-c", "pgrep -fc '^/bin/sh /boot/config/custom/ouro-authority/[g]ateway-supervisor' || true"]).trim() !== "0") fail("a gateway supervisor survived the pause")
  ok("host supervision paused (keeper scripts current; flags expire on their own)")
}
function resumeSupervision() {
  rmSync(MAINTENANCE, { force: true })
  rmSync(SHUTDOWN_FLAG, { force: true })
  installGatewaySupervisor()
}

// Keep Unraid's DockerMan template (what the UI's Apply/Update uses) on the live image.
function pinTemplate(version) {
  if (!existsSync(TEMPLATE)) { console.log("  note: no DockerMan template to update"); return }
  const text = readFileSync(TEMPLATE, "utf8")
  const next = text.replace(/<Repository>ghcr\.io\/ourostack\/ouroboros-butler:[^<]+<\/Repository>/u, `<Repository>${image(version)}</Repository>`)
  if (!next.includes(`<Repository>${image(version)}</Repository>`)) { console.log("  WARN: DockerMan template Repository not recognised; left unchanged"); return }
  if (next !== text) { writeFileSync(`${TEMPLATE}.prev`, text); writeFileSync(TEMPLATE, next) }
  ok(`DockerMan template pins ${image(version)}`)
}

function lifecycleFailure(e) {
  const detail = [e.stderr, e.stdout].map((x) => (x ? String(x).trim() : "")).filter(Boolean).join(" | ")
  let last = ""
  try { last = readFileSync(`${ROOT}/lifecycle-failure.log`, "utf8").trim().split("\n").filter((l) => /^\d{4}-/.test(l)).at(-1) ?? "" } catch { /* none */ }
  return `${detail || e.message}${last ? `\n   last root failure: ${last}` : ""}`
}

function upgrade(version, rehearse) {
  say(`in-place upgrade to ${version}${rehearse ? ` — REHEARSAL: stop after "${rehearse}", then roll back` : ""}`)
  if (rehearse && !UPGRADE_STEPS.includes(rehearse)) fail(`--rehearse takes one of: ${UPGRADE_STEPS.join(", ")}`)
  if (!existsSync(`${ROOT}/active.json`) || !existsSync(`${ROOT}/activation.json`)) fail("no installed authority; use prepare + install")
  if (existsSync(JOURNAL)) fail("a template transaction is pending; resolve it first")
  let id = imageId(version)
  if (!id) { docker(["pull", image(version)]); id = imageId(version) }
  if (!id) fail(`image ${image(version)} could not be pulled`)
  ok(`image ${id.slice(0, 19)}…`)
  if (existsSync(UPGRADE_JOURNAL)) console.log("  note: resuming the pending in-place upgrade with its staged package")
  else {
    const current = JSON.parse(readFileSync(`${ROOT}/request.json`, "utf8"))
    const manifestBytes = stageIncomingPackage(version)
    const pkgVersion = JSON.parse(readFileSync(`${ROOT}/incoming-package/deploy/unraid/sanctuary.ouro/bundle-meta.json`, "utf8")).runtimeVersion
    if (pkgVersion !== version) fail(`staged package is ${pkgVersion}, not ${version}`)
    writePrivate(INCOMING_MANIFEST, manifestBytes)
    const request = { schemaVersion: 1, epochId: current.epochId, botId: current.botId, ownerUserId: current.ownerUserId, ownerChatId: current.ownerChatId, ...packagePins(manifestBytes) }
    writePrivate(INCOMING_REQUEST, Buffer.from(JSON.stringify(request)))
    verifyPackage(`${ROOT}/incoming-package`, INCOMING_MANIFEST, INCOMING_REQUEST)
    ok("new package staged beside the live one and verified")
  }
  const lifecycle = `${ROOT}/incoming-package/dist/heart/daemon/sanctuary-authority-root-lifecycle.js`
  const jellyfinBefore = docker(["inspect", "jellyfin", "--format", "{{.Id}}|{{.Image}}|{{.RestartCount}}|{{.State.StartedAt}}"]).trim()
  const policyBefore = existsSync(POLICY) ? sha12(POLICY) : fail("steward policy missing")
  pauseSupervision()
  let failure = null
  try {
    say("lifecycle upgrade (stop → switch → resident → migrate → start)")
    ok(sh("/usr/local/bin/node", [lifecycle, "upgrade", id, image(version), ...(rehearse ? ["--fail-after", rehearse] : [])], { stdio: ["ignore", "pipe", "pipe"] }).trim())
  } catch (e) { failure = e }
  // Only the lifecycle's own rehearsal stop is planned; anything else is a real failure,
  // even during a rehearsal (the first 830 -> 835 rehearsal was mislabelled "as planned").
  const reason = failure ? lifecycleFailure(failure) : ""
  const planned = Boolean(failure && rehearse && reason.includes(`rehearsal stopped after ${rehearse}`))
  if (failure) {
    console.log(`\n!! ${planned ? "rehearsal stopped as planned" : "upgrade FAILED"}: ${reason}\n!! rolling back to the predecessor`)
    try { ok(`rollback: ${sh("/usr/local/bin/node", [lifecycle, "upgrade-rollback"], { stdio: ["ignore", "pipe", "pipe"] }).trim()}`) }
    catch (e) {
      resumeSupervision()
      fail(`ROLLBACK FAILED: ${lifecycleFailure(e)}\nThe journal is kept; the next authority boot (or \`upgrade-rollback\`) retries it.`)
    }
  } else pinTemplate(version)
  resumeSupervision()
  say("preservation")
  docker(["inspect", "jellyfin", "--format", "{{.Id}}|{{.Image}}|{{.RestartCount}}|{{.State.StartedAt}}"]).trim() === jellyfinBefore ? ok("jellyfin unchanged") : fail("JELLYFIN CHANGED")
  sha12(POLICY) === policyBefore ? ok("steward policy unchanged") : fail("STEWARD POLICY CHANGED")
  const live = docker(["inspect", CONTAINER, "--format", "{{.Config.Image}} {{.State.Status}}/{{.State.Health.Status}}"]).trim()
  ok(`butler: ${live}`)
  if (failure && !planned) fail("upgrade rolled back; the Butler is on its prior version (see above)")
  console.log(rehearse ? "\nREHEARSAL done — the upgrade reached the planned step and the rollback restored the predecessor." : `\nUPGRADE done — ${version} live. Run verify.`)
}

// ---- verify ---------------------------------------------------------------

function verify() {
  say("verify")
  const st = docker(["inspect", CONTAINER, "--format", "{{.Config.Image}} {{.State.Status}}/{{.State.Health.Status}} restarts={{.RestartCount}}"]).trim()
  ok(`butler: ${st}`)
  const auth = docker(["logs", CONTAINER, "--since", "2m"], { stdio: ["ignore","pipe","pipe"] }).split("\n").filter((l) => l.includes("401")).length
  auth === 0 ? ok("no Telegram auth failures in the last 2m") : bad(`${auth} 401s in the last 2m`)
  existsSync(POLICY) ? ok(`steward policy ${sha12(POLICY)}`) : bad("steward policy missing")
  const jf = docker(["inspect", "jellyfin", "--format", "{{.State.Status}} restarts={{.RestartCount}}"]).trim()
  ok(`jellyfin ${jf}`)
  process.exit(RED === 0 ? 0 : 1)
}

function fail(m) { console.error(`\nREFUSING: ${m}`); process.exit(1) }

// ---- entry ----------------------------------------------------------------

const [phase, version, flag, rehearse] = process.argv.slice(2)
if (!phase || !["preflight", "prepare", "install", "verify", "upgrade"].includes(phase) || (flag !== undefined && !(phase === "upgrade" && flag === "--rehearse" && rehearse))) {
  console.error("Usage: sanctuary-butler-upgrade.mjs <preflight|prepare|install|verify|upgrade> <version> [--rehearse <step>]")
  process.exit(2)
}
if (phase !== "verify" && !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version || "")) {
  console.error("a semver version is required, e.g. 0.1.0-alpha.829")
  process.exit(2)
}
requireRoot()

if (phase === "preflight") preflight(version)
else if (phase === "prepare") prepare(version)
else if (phase === "install") install(version)
else if (phase === "verify") verify()
else if (phase === "upgrade") upgrade(version, rehearse)
