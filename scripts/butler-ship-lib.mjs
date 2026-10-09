// Pure logic and the injected-I/O orchestrator behind scripts/butler-ship.mjs.
// Nothing here touches the network or the host directly: every effect goes through `deps`.

export const REPO = "ourostack/ouroboros"
export const IMAGE_REPO = "ghcr.io/ourostack/ouroboros-butler"
export const REMOTE_UPGRADE = "/tmp/butler-upgrade.mjs"
export const REMOTE_GATE = "/tmp/sanctuary-replay-gate.mjs"
export const REMOTE_NODE = "/usr/local/bin/node"
export const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/
export const CASE_NAME = /^[a-z0-9][a-z0-9-]*$/

export function logPath(version) {
  return `/var/log/ouro-upgrade-${version}.log`
}

export function parseShipArgs(argv, env = {}) {
  const usage = "Usage: butler-ship.mjs <version> [--host sanctuary] [--no-gate] [--plant <case>] [--dry-run]"
  const out = { version: undefined, host: env.BUTLER_HOST || "sanctuary", noGate: false, plant: undefined, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--host" && argv[i + 1]) out.host = argv[++i]
    else if (arg === "--plant" && argv[i + 1]) out.plant = argv[++i]
    else if (arg === "--no-gate") out.noGate = true
    else if (arg === "--dry-run") out.dryRun = true
    else if (!arg.startsWith("--") && out.version === undefined) out.version = arg
    else throw new Error(usage)
  }
  if (!SEMVER.test(out.version || "")) throw new Error(`a semver version is required, e.g. 0.1.0-alpha.873\n${usage}`)
  if (!/^[A-Za-z0-9._-]+$/.test(out.host)) throw new Error("--host must be a plain ssh alias")
  if (out.plant !== undefined && !CASE_NAME.test(out.plant)) throw new Error("--plant takes a case id such as books-up")
  if (out.noGate && out.plant) throw new Error("--plant needs the gate; it cannot be combined with --no-gate")
  return out
}

/** Find the merge commit on main whose subject names the release, e.g. "... (0.1.0-alpha.871) (#1053)". */
export function findReleaseCommit(commits, version) {
  const marker = `(${version})`
  const hit = (Array.isArray(commits) ? commits : []).find((c) => String(c?.commit?.message || "").split("\n")[0].includes(marker))
  return hit ? hit.sha : undefined
}

export const FALLBACK_COMMIT_WALK = 30

/**
 * Fallback when no subject names the version (a stale PR title leaves the squash subject naming an older one):
 * walk main newest-first, read package.json's version at each commit, and pick the OLDEST commit of the newest
 * contiguous run that carries the version. `readVersion(sha)` resolves to a version string or undefined.
 */
export async function findReleaseCommitByPackage(commits, version, readVersion, limit = FALLBACK_COMMIT_WALK) {
  let oldest
  for (const c of (Array.isArray(commits) ? commits : []).slice(0, limit)) {
    if (!c?.sha) continue
    const carries = (await readVersion(c.sha)) === version
    if (carries) oldest = c.sha
    else if (oldest) break
  }
  return oldest
}

export const PUSH_RUN_GRACE_MS = 10 * 60_000

export function commitDate(commits, sha) {
  const hit = (Array.isArray(commits) ? commits : []).find((c) => c.sha === sha)
  const parsed = Date.parse(hit?.commit?.committer?.date || "")
  return Number.isNaN(parsed) ? undefined : parsed
}

/** Decide from the check runs of a commit: "success", "failure" or "pending". */
export function coverageState(runs) {
  const list = Array.isArray(runs) ? runs : []
  if (list.some((r) => r.conclusion === "success")) return "success"
  const finished = list.length > 0 && list.every((r) => r.status === "completed")
  return finished ? "failure" : "pending"
}

export function imageFromConfig(text) {
  const m = /^(?:[^\s]*\/)?ouroboros-butler:(\S+)$/.exec(String(text).trim())
  return m ? m[1] : undefined
}

export function splitLines(text) {
  return String(text).split("\n").map((l) => l.replace(/\r$/, ""))
}

export function isCaseLine(line) {
  return line.startsWith('{"id":')
}

export function isSummaryLine(line) {
  return line.startsWith('{"summary":')
}

export function parseJsonLine(line) {
  try { return JSON.parse(line) } catch { return { raw: line } }
}

/**
 * Classify a FINISHED upgrade log (call it only after the upgrade process has exited). The upgrade prints
 * "upgrade FAILED" and "rolling back" before the rollback runs, so these lines are only conclusive at exit.
 * `terminal` is undefined when the log has no recognisable ending.
 */
export function classifyLog(text) {
  const lines = splitLines(text)
  const has = (re) => lines.some((l) => re.test(l))
  if (has(/^GATE PASS/)) return { terminal: "kept", gated: true }
  if (has(/^GATE FAIL/)) return { terminal: "rolled_back" }
  if (has(/ROLLBACK FAILED/)) return { terminal: "failed" }
  if (has(/upgrade FAILED:/)) return { terminal: has(/^ {2}ok {3}rollback:/) ? "rolled_back" : "failed" }
  if (has(/^REFUSING/)) return { terminal: "refused" }
  if (has(/^UPGRADE done/)) return { terminal: "kept", gated: false }
  return { terminal: undefined }
}

export function parseCases(text) {
  const lines = splitLines(text)
  const cases = lines.filter(isCaseLine).map(parseJsonLine)
  const summaryLine = lines.find(isSummaryLine)
  return { cases, summary: summaryLine ? parseJsonLine(summaryLine).summary : undefined }
}

export function parseVerify(text) {
  const lines = splitLines(text)
  const checks = lines.filter((l) => /^ {2}(ok|FAIL)\s/.test(l)).map((l) => ({ ok: l.startsWith("  ok"), line: l.trim() }))
  const butler = lines.map((l) => /^ {2}ok {3}butler: (\S+) running\/healthy/.exec(l)).find(Boolean)
  return { checks, running_image: butler ? butler[1] : undefined }
}

export function rolledBackImage(text) {
  const m = /^GATE FAIL[^\n]*ROLLED BACK to (\S+)/m.exec(String(text))
  return m ? m[1] : undefined
}

export function buildResult({ version, terminal, log, logText, verifyText, verifyCode }) {
  const { cases, summary } = parseCases(logText)
  const verify = parseVerify(verifyText || "")
  const verifyGreen = verifyCode === 0 && verify.checks.length > 0 && verify.checks.every((c) => c.ok)
  const result = { version, result: terminal, running_image: verify.running_image || rolledBackImage(logText) || null, cases, ...(summary ? { summary } : {}), verify: verify.checks, verify_green: verifyGreen, log }
  const exitCode = terminal === "kept" && verifyGreen ? 0 : 1
  return { result, exitCode }
}

export class ShipError extends Error {}

/**
 * deps: { gh(args), ssh(host, cmd), scp(local, host, remote), writeTemp(name, content) -> path,
 *         sleep(ms), log(line), now() -> ms }
 * Each of gh/ssh/scp resolves to { code, stdout, stderr }.
 */
export async function ship(opts, deps, timing = {}) {
  const { version, host, noGate, plant, dryRun } = opts
  const t = { poll: 30_000, coverage: 45 * 60_000, image: 30 * 60_000, upgrade: 90 * 60_000, ...timing }
  const say = (m) => deps.log(`\n== ${m}`)
  const must = (r, what) => {
    if (r.code !== 0) throw new ShipError(`${what} failed (exit ${r.code}): ${String(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`)
    return r.stdout
  }
  const waitFor = async (what, limit, probe) => {
    const start = deps.now()
    for (;;) {
      const state = await probe()
      if (state === true) return
      if (deps.now() - start >= limit) throw new ShipError(`timed out waiting for ${what}`)
      await deps.sleep(t.poll)
    }
  }

  say(`plan for ${version} on ${host}${dryRun ? " (dry run: read-only steps only)" : ""}`)
  for (const step of ["resolve the release merge commit", "wait for its coverage-gate", `wait for ${IMAGE_REPO}:${version} on the host`, "back up and stage the release's upgrade and gate scripts", "preflight", `start the detached ${noGate ? "UNGATED " : ""}upgrade${plant ? ` (plant ${plant})` : ""}`, "follow the log to a terminal line", "verify"]) deps.log(`  - ${step}`)

  say("1. resolve the release commit")
  const commits = JSON.parse(must(await deps.gh(["api", `repos/${REPO}/commits?sha=main&per_page=100`]), "listing main commits"))
  let sha = findReleaseCommit(commits, version)
  if (!sha) {
    deps.log(`  no subject names ${version}; reading package.json at the latest main commits`)
    sha = await findReleaseCommitByPackage(commits, version, async (ref) => {
      const r = await deps.gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/package.json?ref=${ref}`])
      if (r.code !== 0) return undefined
      try { return JSON.parse(r.stdout).version } catch { return undefined }
    })
  }
  if (!sha) throw new ShipError(`no commit on main names ${version} in its subject (looked at the latest 100); is the release merged?`)
  const mergedAt = commitDate(commits, sha)
  deps.log(`  ok   ${version} is ${sha}`)

  say("2. wait for coverage-gate")
  await waitFor(`coverage-gate on ${sha}`, t.coverage, async () => {
    const runs = JSON.parse(must(await deps.gh(["run", "list", "--repo", REPO, "--workflow", "coverage-gate", "--commit", sha, "--event", "push", "--json", "status,conclusion"]), "listing coverage-gate runs"))
    const state = coverageState(runs)
    if (runs.length === 0 && mergedAt !== undefined && deps.now() - mergedAt >= PUSH_RUN_GRACE_MS) throw new ShipError(`no push-triggered coverage-gate run exists for ${sha} ${Math.round((deps.now() - mergedAt) / 60_000)} minutes after the merge, so publish-container will never publish ${IMAGE_REPO}:${version}; a workflow_dispatch run does not publish. Re-trigger a push-event run (for example a new commit on main) instead of waiting`)
    if (state === "failure") throw new ShipError(`coverage-gate failed on ${sha}`)
    return state === "success"
  })
  deps.log("  ok   coverage-gate succeeded")

  say("3. wait for the image on the host")
  await waitFor(`${IMAGE_REPO}:${version} to resolve on the host`, t.image, async () => (await deps.ssh(host, `docker manifest inspect ${IMAGE_REPO}:${version} >/dev/null 2>&1`)).code === 0)
  deps.log("  ok   image resolves")

  if (!dryRun) {
    say("4. back up and stage scripts")
    const current = (await deps.ssh(host, "docker inspect -f '{{.Config.Image}}' ouro-butler 2>/dev/null")).stdout
    const previous = imageFromConfig(current) || "previous"
    must(await deps.ssh(host, `for f in ${REMOTE_UPGRADE} ${REMOTE_GATE}; do [ -f "$f" ] && cp -p "$f" "$f.bak-${previous}"; done; true`), "backing up host scripts")
    for (const [src, remote] of [["deploy/unraid/sanctuary-butler-upgrade.mjs", REMOTE_UPGRADE], ["deploy/unraid/sanctuary-replay-gate.mjs", REMOTE_GATE]]) {
      const body = must(await deps.gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/${src}?ref=${sha}`]), `fetching ${src} at ${sha}`)
      must(await deps.scp(deps.writeTemp(src.split("/").pop(), body), host, remote), `copying ${src} to the host`)
    }
    deps.log(`  ok   staged scripts from ${sha} (backups: .bak-${previous})`)
  } else deps.log("\n== 4. staging skipped (dry run); preflight runs the scripts already on the host")

  say("5. preflight")
  const pre = await deps.ssh(host, `${REMOTE_NODE} ${REMOTE_UPGRADE} preflight ${version}`)
  pre.stdout.split("\n").forEach((l) => deps.log(l))
  if (pre.code !== 0 || /^PREFLIGHT RED/m.test(pre.stdout) || !/^PREFLIGHT GREEN/m.test(pre.stdout)) throw new ShipError("preflight is not green; nothing was changed")
  if (dryRun) { deps.log("\ndry run complete: steps 1 to 3 and 5 passed"); return { dryRun: true, exitCode: 0 } }

  say("6. start the detached upgrade")
  const log = logPath(version)
  const flags = `${noGate ? " --no-gate" : ""}${plant ? ` --plant ${plant}` : ""}`
  must(await deps.ssh(host, `: > ${log}; setsid nohup ${REMOTE_NODE} ${REMOTE_UPGRADE} upgrade ${version}${flags} > ${log} 2>&1 < /dev/null & echo started`), "starting the upgrade")

  say(`7. follow ${log}`)
  let seen = 0
  let text = ""
  let empty = 0
  const start = deps.now()
  let terminal
  for (;;) {
    const poll = await deps.ssh(host, `cat ${log} 2>/dev/null; echo "@@RUNNING:$(pgrep -f '[b]utler-upgrade.mjs upgrade' >/dev/null && echo 1 || echo 0)"`)
    const m = /@@RUNNING:([01])\s*$/.exec(poll.stdout)
    if (poll.code !== 0 || !m) throw new ShipError(`could not read the upgrade log on the host (exit ${poll.code})`)
    text = poll.stdout.slice(0, m.index)
    const lines = splitLines(text)
    lines.slice(seen).filter((l) => isCaseLine(l) || isSummaryLine(l) || /^(GATE|UPGRADE|REFUSING|PREFLIGHT)|FAILED/.test(l)).forEach((l) => deps.log(l))
    seen = lines.length
    // Only a finished process has a final answer: FAILED and "rolling back" lines appear before the rollback runs.
    if (m[1] === "0") {
      // The detached process may not have started yet on the very first polls.
      if (text.trim() === "" && (empty += 1) <= 3) { await deps.sleep(t.poll); continue }
      terminal = classifyLog(text).terminal
      if (!terminal) { terminal = "failed"; deps.log("  the upgrade process exited without a terminal line") }
      break
    }
    if (deps.now() - start >= t.upgrade) throw new ShipError(`timed out following ${log}; the upgrade may still be running, inspect the host`)
    await deps.sleep(t.poll)
  }

  say("8. verify")
  const ver = await deps.ssh(host, `${REMOTE_NODE} ${REMOTE_UPGRADE} verify`)
  ver.stdout.split("\n").forEach((l) => deps.log(l))
  const { result, exitCode } = buildResult({ version, terminal, log, logText: text, verifyText: ver.stdout, verifyCode: ver.code })
  deps.log(JSON.stringify(result))
  return { result, exitCode }
}
