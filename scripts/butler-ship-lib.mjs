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

export function baselineLogPath(version) {
  return `/var/log/ouro-baseline-${version}.log`
}

// The release's own gate, run against the live version before the upgrade, must finish inside the upgrade's own gate cap.
export const BASELINE_RUN_SECONDS = 95 * 60
export const FAILING_ON_LIVE_TOO = "failing-on-live-too"

export function parseShipArgs(argv, env = {}) {
  const usage = "Usage: butler-ship.mjs <version> [--host sanctuary] [--no-gate] [--no-baseline] [--plant <case>] [--dry-run]"
  const out = { version: undefined, host: env.BUTLER_HOST || "sanctuary", noGate: false, noBaseline: false, plant: undefined, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--host" && argv[i + 1]) out.host = argv[++i]
    else if (arg === "--plant" && argv[i + 1]) out.plant = argv[++i]
    else if (arg === "--no-gate") out.noGate = true
    else if (arg === "--no-baseline") out.noBaseline = true
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
export async function findReleaseCommitByPackage(commits, version, readVersion, limit = FALLBACK_COMMIT_WALK, unreadable = []) {
  let oldest
  for (const c of (Array.isArray(commits) ? commits : []).slice(0, limit)) {
    if (!c?.sha) continue
    const read = await readVersion(c.sha)
    // An unreadable commit (gh failed, not JSON, no version) is inconclusive: it neither joins nor ends the run.
    if (typeof read !== "string") { unreadable.push(c.sha); continue }
    if (read === version) oldest = c.sha
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

/**
 * One row per case: its status on the live version, on the candidate, and what that meant for the release. The candidate's gate
 * already applied the rule (a case that failed on live too does not block); this only lays the two runs side by side.
 */
export function compareCases(liveCases, candidateCases) {
  const status = (list) => new Map((Array.isArray(list) ? list : []).filter((c) => typeof c?.id === "string").map((c) => [c.id, String(c.status)]))
  const live = status(liveCases)
  const candidate = status(candidateCases)
  const verdict = (s) => (s === "fail" ? "blocks" : s === FAILING_ON_LIVE_TOO ? "failing on live too" : s ?? "not run")
  const ids = [...candidate.keys(), ...[...live.keys()].filter((id) => !candidate.has(id))]
  return ids.map((id) => ({ id, live: live.get(id) ?? "not run", candidate: candidate.get(id) ?? "not run", verdict: verdict(candidate.get(id)) }))
}

export function formatComparison(rows) {
  const width = Math.max(4, ...rows.map((r) => r.id.length))
  const line = (a, b, c, d) => `  ${a.padEnd(width)}  ${b.padEnd(19)}  ${c.padEnd(19)}  ${d}`
  return [line("case", "live", "candidate", "verdict"), ...rows.map((r) => line(r.id, r.live, r.candidate, r.verdict === "failing on live too" ? "FAILING ON LIVE TOO (does not block)" : r.verdict === "blocks" ? "BLOCKS" : r.verdict))]
}

export function buildResult({ version, terminal, log, logText, verifyText, verifyCode, baseline }) {
  const { cases, summary } = parseCases(logText)
  const verify = parseVerify(verifyText || "")
  const verifyGreen = verifyCode === 0 && verify.checks.length > 0 && verify.checks.every((c) => c.ok)
  const live = baseline?.cases ? { baseline: { log: baseline.log, ...(baseline.summary ? { summary: baseline.summary } : {}), cases: baseline.cases }, comparison: compareCases(baseline.cases, cases) } : { baseline: { skipped: baseline?.skipped ?? "not run" } }
  const result = { version, result: terminal, running_image: verify.running_image || rolledBackImage(logText) || null, cases, ...(summary ? { summary } : {}), ...live, verify: verify.checks, verify_green: verifyGreen, log }
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
  const { version, host, noGate, noBaseline, plant, dryRun } = opts
  const t = { poll: 30_000, coverage: 45 * 60_000, image: 30 * 60_000, baseline: 100 * 60_000, upgrade: 90 * 60_000, ...timing }
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
  for (const step of ["resolve the release merge commit", "wait for its coverage-gate", `wait for ${IMAGE_REPO}:${version} on the host`, "back up and stage the release's upgrade and gate scripts", "preflight", ...(noGate || noBaseline ? [] : ["run the release's gate against the live version (the baseline)"]), `start the detached ${noGate ? "UNGATED " : ""}upgrade${plant ? ` (plant ${plant})` : ""}`, "follow the log to a terminal line", "verify"]) deps.log(`  - ${step}`)

  say("1. resolve the release commit")
  const commits = JSON.parse(must(await deps.gh(["api", `repos/${REPO}/commits?sha=main&per_page=100`]), "listing main commits"))
  let sha = findReleaseCommit(commits, version)
  if (!sha) {
    deps.log(`  no subject names ${version}; reading package.json at the latest main commits`)
    const unreadable = []
    sha = await findReleaseCommitByPackage(commits, version, async (ref) => {
      const r = await deps.gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/package.json?ref=${ref}`])
      if (r.code !== 0) return null
      try { return JSON.parse(r.stdout).version } catch { return null }
    }, FALLBACK_COMMIT_WALK, unreadable)
    if (unreadable.length > 0) deps.log(`  WARN package.json could not be read at ${unreadable.join(", ")}${sha ? `; chose ${sha} without them, so check it is the release merge` : ""}`)
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

  // A case can only show the candidate is worse if it passes on the live version: run the release's own gate (staged in step 4)
  // against the live Butler first, then hand its results to the upgrade's gate.
  let baseline
  if (noGate) baseline = { skipped: "--no-gate" }
  else if (noBaseline) baseline = { skipped: "--no-baseline" }
  else {
    say("6. baseline: run the release's gate against the live version")
    baseline = await runBaseline(version, host, deps, t)
    if (baseline.skipped) deps.log(`  WARN no live baseline (${baseline.skipped}); every gate failure will block the release`)
    else {
      deps.log(`  ok   live baseline: ${baseline.cases.filter((c) => c.status === "fail").length} of ${baseline.cases.length} cases fail on the live version too`)
    }
  }

  say("7. start the detached upgrade")
  const log = logPath(version)
  const flags = `${noGate ? " --no-gate" : ""}${plant ? ` --plant ${plant}` : ""}`
  const env = baseline.cases ? `OURO_REPLAY_BASELINE=${baseline.log} ` : ""
  must(await deps.ssh(host, `: > ${log}; ${env}setsid nohup ${REMOTE_NODE} ${REMOTE_UPGRADE} upgrade ${version}${flags} > ${log} 2>&1 < /dev/null & echo started`), "starting the upgrade")

  say(`8. follow ${log}`)
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
    lines.slice(seen).filter((l) => isCaseLine(l) || isSummaryLine(l) || /^(GATE|UPGRADE|REFUSING|PREFLIGHT|BASELINE)|FAILED|FAILING ON LIVE TOO/.test(l)).forEach((l) => deps.log(l))
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

  say("9. verify")
  const ver = await deps.ssh(host, `${REMOTE_NODE} ${REMOTE_UPGRADE} verify`)
  ver.stdout.split("\n").forEach((l) => deps.log(l))
  const { result, exitCode } = buildResult({ version, terminal, log, logText: text, verifyText: ver.stdout, verifyCode: ver.code, baseline })
  if (result.comparison) {
    say("live baseline and candidate, side by side")
    formatComparison(result.comparison).forEach((l) => deps.log(l))
  }
  deps.log(JSON.stringify(result))
  return { result, exitCode }
}

/**
 * Runs the staged gate against the live Butler, detached (it takes as long as the upgrade's gate), and follows its log until the
 * process exits. Returns { log, cases, summary }, or { skipped } when no usable baseline came out of it, in which case the
 * upgrade's gate stays strict. Throws only when the run might still be going, because the upgrade must not start beside it.
 */
async function runBaseline(version, host, deps, t) {
  const log = baselineLogPath(version)
  const started = await deps.ssh(host, `: > ${log}; setsid nohup timeout -s KILL ${BASELINE_RUN_SECONDS} ${REMOTE_NODE} ${REMOTE_GATE} run > ${log} 2>&1 < /dev/null & echo "@@PID:$!"`)
  const pid = /@@PID:(\d+)/.exec(started.stdout)?.[1]
  if (started.code !== 0 || !pid) return { skipped: `the live run did not start (exit ${started.code})` }
  const start = deps.now()
  let seen = 0
  let text = ""
  for (;;) {
    const poll = await deps.ssh(host, `cat ${log} 2>/dev/null; echo "@@RUNNING:$(kill -0 ${pid} 2>/dev/null && echo 1 || echo 0)"`)
    const m = /@@RUNNING:([01])\s*$/.exec(poll.stdout)
    if (poll.code !== 0 || !m) throw new ShipError(`could not read the live baseline log ${log} on the host (exit ${poll.code}); nothing was upgraded`)
    text = poll.stdout.slice(0, m.index)
    const lines = splitLines(text)
    lines.slice(seen).filter((l) => isCaseLine(l) || isSummaryLine(l)).forEach((l) => deps.log(`  live ${l}`))
    seen = lines.length
    if (m[1] === "0") break
    if (deps.now() - start >= t.baseline) throw new ShipError(`timed out following the live baseline ${log}; it may still be running (pid ${pid}), so nothing was upgraded`)
    await deps.sleep(t.poll)
  }
  const { cases, summary } = parseCases(text)
  const usable = cases.filter((c) => typeof c.id === "string")
  if (usable.length === 0) return { skipped: `the live run wrote no case results to ${log}` }
  return { log, cases: usable.map((c) => ({ id: c.id, status: c.status })), ...(summary ? { summary } : {}) }
}
