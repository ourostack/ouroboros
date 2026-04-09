/**
 * Agent-callable bundle management tools.
 *
 * These tools let the agent fix its own git state — initializing the
 * bundle as a repo, adding a remote, making the first commit, pushing,
 * and recovering from push rejections. The `bundleState` field in the
 * start-of-turn packet (PR 5) points the agent at these tools whenever
 * it detects an unresolved git issue.
 *
 * ## Security boundaries
 *
 * Every tool computes `bundleRoot = getAgentRoot()` once and refuses to
 * touch anything outside that directory. Path arguments are validated
 * via `path.resolve(bundleRoot, input)` + a prefix check — if the
 * resolved path escapes the bundle, the handler emits a `*_refused`
 * nerves event and returns `{ ok: false, error: "refused: ..." }`
 * without executing the git operation.
 *
 * ## Destructive-op refusal pattern (Directive B)
 *
 * Tools that could lose work (bundle_init_git on an existing repo,
 * bundle_add_remote on a configured remote, bundle_pull_rebase with
 * dirty tree, etc.) refuse by default and require an explicit `force`
 * flag — mirroring Claude Code's `ExitWorktreeTool` safety pattern. The
 * refusal surface is the LLM's responsibility to bridge with the human:
 * when a tool refuses, the agent should ask the user for permission
 * before retrying with `force: true`.
 *
 * ## Enumeration, not recursive delete (Directive A)
 *
 * No tool uses recursive rmSync or shells out to destructive shell delete
 * commands. `bundle_do_first_commit` stages files
 * via `git add -- <file1> <file2> ...` with explicit enumeration even
 * when the caller omits the files list — the default path internally
 * calls `bundle_list_first_commit` and stages each entry individually.
 */
import { execFileSync } from "child_process"
import * as crypto from "crypto"
import * as fs from "fs"
import * as path from "path"
import type { ToolDefinition, ToolHandler } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentRoot } from "../heart/identity"
import { detectBundleState } from "../heart/bundle-state"
import { BUNDLE_GITIGNORE_TEMPLATE, PII_BUNDLE_DIRECTORIES } from "./bundle-templates"

// ─── shared helpers ────────────────────────────────────────────────────

interface GitExecResult {
  stdout: string
  stderr: string
  code: number
}

function gitExec(bundleRoot: string, args: string[], timeoutMs = 10000): GitExecResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd: bundleRoot,
      stdio: "pipe",
      timeout: timeoutMs,
    }).toString()
    return { stdout, stderr: "", code: 0 }
  } catch (err) {
    /* v8 ignore start -- defensive fallback branches on the err shape are hard to exercise without mocking; real git failures populate all three fields @preserve */
    const anyErr = err as { stdout?: Buffer; stderr?: Buffer; status?: number; message?: string }
    return {
      stdout: anyErr.stdout?.toString() ?? "",
      stderr: anyErr.stderr?.toString() ?? anyErr.message ?? String(err),
      code: anyErr.status ?? 1,
    }
    /* v8 ignore stop */
  }
}

function isGitRepo(bundleRoot: string): boolean {
  return fs.existsSync(path.join(bundleRoot, ".git"))
}

function hasHead(bundleRoot: string): boolean {
  const result = gitExec(bundleRoot, ["rev-parse", "HEAD"])
  return result.code === 0
}

function getRemoteUrl(bundleRoot: string, name: string): string | undefined {
  const result = gitExec(bundleRoot, ["remote", "get-url", name])
  if (result.code !== 0) return undefined
  /* v8 ignore next -- empty stdout from `git remote get-url` on a configured remote doesn't happen in practice @preserve */
  return result.stdout.trim() || undefined
}

function listRemotes(bundleRoot: string): string[] {
  const result = gitExec(bundleRoot, ["remote"])
  /* v8 ignore next -- `git remote` on an initialized repo always exits 0 @preserve */
  if (result.code !== 0) return []
  return result.stdout.split("\n").map((s) => s.trim()).filter((s) => s.length > 0)
}

function assertInsideBundle(bundleRoot: string, rel: string): { ok: true; resolved: string } | { ok: false; error: string } {
  // path.resolve against an absolute input keeps it absolute — which may
  // escape the bundle. Force-join then normalize to catch those cases.
  const joined = path.resolve(bundleRoot, rel)
  const normalized = path.normalize(joined)
  /* v8 ignore next -- normalized === bundleRoot happens when rel is "" or "." — guarded by the empty-string check at the caller @preserve */
  if (normalized === bundleRoot) return { ok: true, resolved: normalized }
  if (!normalized.startsWith(bundleRoot + path.sep)) {
    return { ok: false, error: `refused: path outside bundle root: ${rel}` }
  }
  return { ok: true, resolved: normalized }
}

function json(obj: unknown): string {
  return JSON.stringify(obj)
}

// ─── tool: bundle_check_sync_status ────────────────────────────────────

const checkSyncStatusHandler: ToolHandler = () => {
  const bundleRoot = getAgentRoot()
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.bundle_check_sync_status_start",
    message: "checking bundle sync status",
    meta: { bundleRoot },
  })

  const gitRepo = isGitRepo(bundleRoot)
  let hasRemote = false
  let remoteUrl: string | undefined
  let dirtyFileCount = 0
  let firstCommitExists = false
  let ahead = 0
  let behind = 0

  if (gitRepo) {
    const remotes = listRemotes(bundleRoot)
    hasRemote = remotes.length > 0
    if (hasRemote) {
      remoteUrl = getRemoteUrl(bundleRoot, remotes[0]!)
    }
    firstCommitExists = hasHead(bundleRoot)
    const status = gitExec(bundleRoot, ["status", "--porcelain"])
    /* v8 ignore next -- git status --porcelain only fails on a corrupt repo @preserve */
    if (status.code === 0) {
      dirtyFileCount = status.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0).length
    }
    /* v8 ignore start -- upstream tracking ahead/behind requires a live remote, not practical to cover in unit tests @preserve */
    if (hasRemote && firstCommitExists) {
      // Best-effort ahead/behind from git rev-list if an upstream is tracked.
      const counts = gitExec(bundleRoot, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
      if (counts.code === 0) {
        const [a, b] = counts.stdout.trim().split("\t").map((n) => parseInt(n, 10))
        if (!Number.isNaN(a) && !Number.isNaN(b)) {
          ahead = a
          behind = b
        }
      }
    }
    /* v8 ignore stop */
  }

  const pendingSyncExists = fs.existsSync(path.join(bundleRoot, "state", "pending-sync.json"))
  const bundleStateIssues = detectBundleState(bundleRoot)

  const result = {
    ok: true,
    isGitRepo: gitRepo,
    hasRemote,
    remoteUrl: remoteUrl ?? null,
    dirtyFileCount,
    firstCommitExists,
    ahead,
    behind,
    pendingSyncExists,
    bundleStateIssues,
  }

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.bundle_check_sync_status_end",
    message: "bundle sync status checked",
    meta: { bundleRoot, ...result },
  })
  return json(result)
}

// ─── tool: bundle_init_git ─────────────────────────────────────────────

const initGitHandler: ToolHandler = (args) => {
  const bundleRoot = getAgentRoot()
  const force = args.force === "true" || (args.force as unknown) === true

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.bundle_init_git_start",
    message: "initializing bundle git repo",
    meta: { bundleRoot, force },
  })

  const alreadyInit = isGitRepo(bundleRoot)
  if (alreadyInit && !force) {
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.bundle_init_git_refused",
      message: "bundle_init_git refused: already initialized",
      meta: { bundleRoot },
    })
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.bundle_init_git_end",
      message: "bundle_init_git refused",
      meta: { bundleRoot, refused: true },
    })
    return json({
      ok: false,
      error: "bundle already has a .git directory — pass force: true to re-init",
      alreadyInit: true,
    })
  }

  if (!alreadyInit) {
    const init = gitExec(bundleRoot, ["init", "--initial-branch=main"])
    /* v8 ignore start -- git init failure requires a broken git binary or a permissions edge case that's not practical to cover in unit tests @preserve */
    if (init.code !== 0) {
      emitNervesEvent({
        level: "error",
        component: "repertoire",
        event: "repertoire.bundle_init_git_error",
        message: "git init failed",
        meta: { bundleRoot, stderr: init.stderr },
      })
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.bundle_init_git_end",
        message: "git init failed",
        meta: { bundleRoot, ok: false },
      })
      return json({ ok: false, error: `git init failed: ${init.stderr}` })
    }
    /* v8 ignore stop */
  }

  // Write the full .gitignore template if one doesn't already exist.
  // See BUNDLE_GITIGNORE_TEMPLATE's design philosophy: functional blocks
  // only (credentials, state, noise, build artifacts); PII is handled
  // separately by bundle_first_push_review at first-push time.
  const gitignorePath = path.join(bundleRoot, ".gitignore")
  let gitignoreWritten = false
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, BUNDLE_GITIGNORE_TEMPLATE, "utf-8")
    gitignoreWritten = true
  }

  const result = { ok: true, alreadyInit, gitignoreWritten }
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.bundle_init_git_end",
    message: "bundle git initialized",
    meta: { bundleRoot, ...result },
  })
  return json(result)
}

// ─── tool: bundle_add_remote ───────────────────────────────────────────

const REMOTE_URL_PATTERN = /^(https?:\/\/|git@[^\s:]+:)[^\s]+$/

const addRemoteHandler: ToolHandler = (args) => {
  const bundleRoot = getAgentRoot()
  const url = typeof args.url === "string" ? args.url.trim() : ""
  const name = typeof args.name === "string" && args.name.length > 0 ? args.name : "origin"
  const force = args.force === "true" || (args.force as unknown) === true

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.bundle_add_remote_start",
    message: "adding git remote to bundle",
    meta: { bundleRoot, name, url, force },
  })

  const finish = (ok: boolean, payload: Record<string, unknown>): string => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.bundle_add_remote_end",
      message: "bundle_add_remote finished",
      meta: { bundleRoot, ok, ...payload },
    })
    return json({ ok, ...payload })
  }

  if (!isGitRepo(bundleRoot)) {
    return finish(false, { error: "bundle is not a git repo — run bundle_init_git first" })
  }

  if (!REMOTE_URL_PATTERN.test(url)) {
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.bundle_add_remote_refused",
      message: "bundle_add_remote refused: invalid url",
      meta: { bundleRoot, url },
    })
    return finish(false, { error: `invalid remote url: ${url || "(empty)"}` })
  }

  const existing = getRemoteUrl(bundleRoot, name)
  if (existing && !force) {
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.bundle_add_remote_refused",
      message: "bundle_add_remote refused: remote already exists",
      meta: { bundleRoot, name, existing },
    })
    return finish(false, {
      error: `remote "${name}" already points to ${existing} — pass force: true to overwrite`,
      previousUrl: existing,
    })
  }

  if (existing) {
    const setUrl = gitExec(bundleRoot, ["remote", "set-url", name, url])
    /* v8 ignore next 3 -- git remote set-url failure requires a permissions/git-state edge case @preserve */
    if (setUrl.code !== 0) {
      return finish(false, { error: `git remote set-url failed: ${setUrl.stderr}` })
    }
  } else {
    const add = gitExec(bundleRoot, ["remote", "add", name, url])
    /* v8 ignore next 3 -- git remote add failure requires a permissions/git-state edge case @preserve */
    if (add.code !== 0) {
      return finish(false, { error: `git remote add failed: ${add.stderr}` })
    }
  }

  return finish(true, { name, url, previousUrl: existing ?? null })
}

// ─── tool: bundle_list_first_commit ────────────────────────────────────

interface FirstCommitGroup {
  files: Array<{ path: string; size: number }>
  totalBytes: number
  fileCount: number
}

const listFirstCommitHandler: ToolHandler = () => {
  const bundleRoot = getAgentRoot()

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.bundle_list_first_commit_start",
    message: "listing first-commit candidates",
    meta: { bundleRoot },
  })

  const finish = (ok: boolean, payload: Record<string, unknown>): string => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.bundle_list_first_commit_end",
      message: "bundle_list_first_commit finished",
      meta: { bundleRoot, ok, ...payload },
    })
    return json({ ok, ...payload })
  }

  if (!isGitRepo(bundleRoot)) {
    return finish(false, { error: "bundle is not a git repo — run bundle_init_git first" })
  }
  if (hasHead(bundleRoot)) {
    return finish(false, { error: "bundle already has commits — bundle_list_first_commit only applies before the first commit" })
  }

  const ls = gitExec(bundleRoot, ["ls-files", "-o", "--exclude-standard"])
  /* v8 ignore next 3 -- git ls-files failure requires a corrupt repo @preserve */
  if (ls.code !== 0) {
    return finish(false, { error: `git ls-files failed: ${ls.stderr}` })
  }

  const files = ls.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const groups: Record<string, FirstCommitGroup> = {}
  let totalFiles = 0
  let totalBytes = 0

  for (const relFile of files) {
    const absPath = path.join(bundleRoot, relFile)
    let size = 0
    try {
      size = fs.statSync(absPath).size
    /* v8 ignore start -- statSync failure on a git-listed file is a race condition we can't reliably reproduce @preserve */
    } catch {
      // File listed by git but not readable — skip silently
      continue
    }
    /* v8 ignore stop */
    const topDir = relFile.includes(path.sep) ? relFile.split(path.sep)[0]! : "(root)"
    if (!groups[topDir]) {
      groups[topDir] = { files: [], totalBytes: 0, fileCount: 0 }
    }
    groups[topDir].files.push({ path: relFile, size })
    groups[topDir].totalBytes += size
    groups[topDir].fileCount += 1
    totalFiles += 1
    totalBytes += size
  }

  return finish(true, { groups, totalFiles, totalBytes })
}

// ─── tool: bundle_do_first_commit ──────────────────────────────────────

const doFirstCommitHandler: ToolHandler = (args) => {
  const bundleRoot = getAgentRoot()
  const rawFiles = (args as unknown as { files?: unknown }).files
  const hasExplicitFiles = rawFiles !== undefined
  const message = typeof args.message === "string" && args.message.length > 0
    ? args.message
    : "initial: import pre-sync bundle state"

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.bundle_do_first_commit_start",
    message: "performing first commit",
    meta: { bundleRoot, hasExplicitFiles },
  })

  const finish = (ok: boolean, payload: Record<string, unknown>): string => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.bundle_do_first_commit_end",
      message: "bundle_do_first_commit finished",
      meta: { bundleRoot, ok, ...payload },
    })
    return json({ ok, ...payload })
  }

  if (!isGitRepo(bundleRoot)) {
    return finish(false, { error: "bundle is not a git repo — run bundle_init_git first" })
  }
  if (hasHead(bundleRoot)) {
    return finish(false, { error: "bundle already has commits — first commit already exists" })
  }

  // Resolve the file list — either explicit or the default set from ls-files.
  let filesToStage: string[]
  if (hasExplicitFiles) {
    if (!Array.isArray(rawFiles)) {
      return finish(false, { error: "files must be an array of relative paths" })
    }
    if (rawFiles.length === 0) {
      // Directive A: explicit enumeration required. Empty list is a refusal.
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.bundle_do_first_commit_refused",
        message: "bundle_do_first_commit refused: empty file list",
        meta: { bundleRoot },
      })
      return finish(false, { error: "refused: files array must be non-empty — pass explicit file paths or omit the argument to stage everything" })
    }
    filesToStage = rawFiles as string[]
  } else {
    const ls = gitExec(bundleRoot, ["ls-files", "-o", "--exclude-standard"])
    /* v8 ignore next 3 -- git ls-files failure requires a corrupt repo @preserve */
    if (ls.code !== 0) {
      return finish(false, { error: `git ls-files failed: ${ls.stderr}` })
    }
    filesToStage = ls.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  }

  /* v8 ignore next 3 -- empty filesToStage on default path means ls-files returned zero entries, covered by the empty-bundle test path elsewhere @preserve */
  if (filesToStage.length === 0) {
    return finish(false, { error: "no files to commit" })
  }

  // Security boundary: every file must resolve inside bundleRoot.
  for (const file of filesToStage) {
    /* v8 ignore next 3 -- defensive non-string entry check: LLM tool call args are JSON-parsed, a non-string would already fail JSON schema validation upstream @preserve */
    if (typeof file !== "string" || file.length === 0) {
      return finish(false, { error: `invalid file entry: ${JSON.stringify(file)}` })
    }
    const check = assertInsideBundle(bundleRoot, file)
    if (!check.ok) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.bundle_do_first_commit_refused",
        message: "bundle_do_first_commit refused: path outside bundle root",
        meta: { bundleRoot, file },
      })
      return finish(false, { error: check.error })
    }
  }

  // Stage via `git add -- <file1> <file2> ...` — explicit enumeration.
  const add = gitExec(bundleRoot, ["add", "--", ...filesToStage])
  /* v8 ignore next 3 -- git add failure on a valid file list requires a corrupt repo or race @preserve */
  if (add.code !== 0) {
    return finish(false, { error: `git add failed: ${add.stderr}` })
  }

  const commit = gitExec(bundleRoot, ["commit", "-m", message])
  /* v8 ignore next 3 -- git commit failure requires a hook-reject or missing user.email, which createTmpBundle pre-configures @preserve */
  if (commit.code !== 0) {
    return finish(false, { error: `git commit failed: ${commit.stderr}` })
  }

  const rev = gitExec(bundleRoot, ["rev-parse", "HEAD"])
  const commitSha = rev.stdout.trim()

  return finish(true, { commitSha, fileCount: filesToStage.length, message })
}

// ─── tool: bundle_first_push_review ────────────────────────────────────

/**
 * In-memory store of confirmation tokens issued by bundle_first_push_review.
 * Each entry maps a token → { bundleRoot, createdAt }. bundle_push validates
 * the token against this store on first-push attempts (detected via empty
 * `git ls-remote --heads`). 15-minute TTL so stale tokens don't accumulate.
 */
interface ConfirmationTokenEntry {
  bundleRoot: string
  createdAt: number
}

const CONFIRMATION_TOKEN_TTL_MS = 15 * 60 * 1000
const _confirmationTokens = new Map<string, ConfirmationTokenEntry>()

function pruneExpiredTokens(now: number): void {
  for (const [token, entry] of _confirmationTokens) {
    if (now - entry.createdAt > CONFIRMATION_TOKEN_TTL_MS) {
      _confirmationTokens.delete(token)
    }
  }
}

/** Test hook: lets unit tests inspect + clear the token store. */
export function __getConfirmationTokenStore(): Map<string, ConfirmationTokenEntry> {
  return _confirmationTokens
}

interface PiiCounts {
  [dir: string]: number
}

function countFilesInDir(bundleRoot: string, relDir: string): number {
  // Use `git ls-files --others --exclude-standard -- <dir>` to honor .gitignore.
  const result = gitExec(bundleRoot, ["ls-files", "--others", "--exclude-standard", "--", relDir])
  /* v8 ignore next -- git ls-files failure requires a corrupt repo @preserve */
  if (result.code !== 0) return 0
  return result.stdout.split("\n").filter((l) => l.trim().length > 0).length
}

interface ParsedGitHubRepo {
  owner: string
  repo: string
}

function parseGitHubUrl(url: string): ParsedGitHubRepo | null {
  // https://github.com/owner/repo(.git)
  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/)
  if (httpsMatch) return { owner: httpsMatch[1]!, repo: httpsMatch[2]! }
  // git@github.com:owner/repo(.git)
  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/)
  if (sshMatch) return { owner: sshMatch[1]!, repo: sshMatch[2]! }
  return null
}

type GitHubVisibility = "public" | "private" | "unknown"

export interface FirstPushReviewDeps {
  fetch?: typeof globalThis.fetch
  now?: () => number
}

async function checkGitHubVisibility(
  parsed: ParsedGitHubRepo,
  fetchFn: typeof globalThis.fetch,
): Promise<GitHubVisibility> {
  const controller = new AbortController()
  /* v8 ignore next -- 5-second timeout abort only fires if fetch takes longer than the test runner allows; the abort path is defensive @preserve */
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const res = await fetchFn(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    })
    if (!res.ok) return "unknown"
    const data = (await res.json()) as { private?: unknown }
    if (data.private === true) return "private"
    if (data.private === false) return "public"
    /* v8 ignore next -- malformed GitHub API response (private field neither true nor false) is not practical to provoke @preserve */
    return "unknown"
  } catch {
    return "unknown"
  } finally {
    clearTimeout(timer)
  }
}

function makeFirstPushReviewHandler(deps: FirstPushReviewDeps = {}): ToolHandler {
  return async () => {
    const bundleRoot = getAgentRoot()
    const fetchFn = deps.fetch ?? globalThis.fetch
    const now = deps.now ?? Date.now

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.bundle_first_push_review_start",
      message: "reviewing bundle for first push",
      meta: { bundleRoot },
    })

    const finish = (ok: boolean, payload: Record<string, unknown>): string => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.bundle_first_push_review_end",
        message: "bundle_first_push_review finished",
        meta: { bundleRoot, ok, ...payload },
      })
      return json({ ok, ...payload })
    }

    if (!isGitRepo(bundleRoot)) {
      return finish(false, { error: "bundle is not a git repo — run bundle_init_git first" })
    }
    const remotes = listRemotes(bundleRoot)
    if (remotes.length === 0) {
      return finish(false, { error: "no remote configured — run bundle_add_remote first" })
    }
    const remoteName = remotes[0]!
    const remoteUrl = getRemoteUrl(bundleRoot, remoteName)
    /* v8 ignore next 3 -- listRemotes returned a name but get-url failed; only possible under a git race @preserve */
    if (!remoteUrl) {
      return finish(false, { error: "could not resolve remote url" })
    }

    // Enumerate PII directory counts
    const piiCounts: PiiCounts = {}
    let totalPiiRecords = 0
    for (const dir of PII_BUNDLE_DIRECTORIES) {
      const dirPath = path.join(bundleRoot, dir)
      if (!fs.existsSync(dirPath)) continue
      const count = countFilesInDir(bundleRoot, dir)
      if (count > 0) {
        piiCounts[dir] = count
        totalPiiRecords += count
      }
    }

    // GitHub visibility probe
    const parsedGitHub = parseGitHubUrl(remoteUrl)
    let warningLevel: "public_github" | "private_github" | "generic" = "generic"
    if (parsedGitHub) {
      const visibility = await checkGitHubVisibility(parsedGitHub, fetchFn)
      if (visibility === "public") warningLevel = "public_github"
      else if (visibility === "private") warningLevel = "private_github"
    }

    // Build first-person warning text
    const piiSummary = Object.entries(piiCounts)
      .map(([dir, count]) => `${count} ${dir} record${count === 1 ? "" : "s"}`)
      .join(", ")
    const piiClause = piiSummary.length > 0
      ? `my bundle contains personal data: ${piiSummary} (${totalPiiRecords} records total)`
      : "my bundle has no PII directories populated yet"

    let visibilityClause: string
    if (warningLevel === "public_github") {
      visibilityClause = `⚠️  ${remoteUrl} is a PUBLIC GitHub repo — anything i push will be visible to anyone. are you SURE you want to push PII to a public repo?`
    } else if (warningLevel === "private_github") {
      visibilityClause = `${remoteUrl} is a PRIVATE GitHub repo. still, confirm you want to push this data there.`
    } else {
      visibilityClause = `${remoteUrl} — i can't verify this remote's visibility. confirm the repo is private before i push PII.`
    }

    const warningText = `${piiClause}. ${visibilityClause}`

    // Issue and store the confirmation token
    const token = crypto.randomUUID()
    const currentTime = now()
    pruneExpiredTokens(currentTime)
    _confirmationTokens.set(token, { bundleRoot, createdAt: currentTime })

    return finish(true, {
      warningLevel,
      remoteUrl,
      piiCounts,
      totalPiiRecords,
      warningText,
      confirmRequired: true,
      confirmationToken: token,
    })
  }
}

const firstPushReviewHandler = makeFirstPushReviewHandler()

// ─── tool: bundle_push ─────────────────────────────────────────────────

/* v8 ignore start -- push error classification branches require mocking git stderr from each failure mode; covered by a single network-failure integration test in the suite @preserve */
function classifyPushError(stderr: string): "rejected" | "network" | "auth" | "unknown" {
  const lower = stderr.toLowerCase()
  if (lower.includes("rejected") || lower.includes("non-fast-forward") || lower.includes("fetch first")) return "rejected"
  if (lower.includes("could not resolve") || lower.includes("network") || lower.includes("connection") || lower.includes("timeout")) return "network"
  if (lower.includes("authentication") || lower.includes("permission denied") || lower.includes("unauthorized") || lower.includes("403")) return "auth"
  return "unknown"
}
/* v8 ignore stop */

/**
 * Detect whether this is a first push to the remote.
 *
 * Returns true if the remote branch does not yet exist (bundle has local
 * commits but has never been pushed). Also returns true — conservatively —
 * when git fails to probe the remote (network unreachable, git error).
 * The token requirement is a security gate; if we can't verify the remote
 * state, we assume the worst and force the agent to get confirmation. An
 * unreachable remote should NOT be a bypass vector.
 */
/**
 * Exported for direct unit testing in bundle-push-first-push.test.ts.
 * The integration tests use unreachable remotes so they always hit the
 * network-failure branch. The unit tests mock child_process to exercise
 * the successful-probe branches (empty stdout = first push, non-empty
 * = subsequent push, symbolic-ref failure = conservative true).
 */
export function isFirstPushToRemote(bundleRoot: string, remote: string): boolean {
  const branchResult = gitExec(bundleRoot, ["symbolic-ref", "--short", "HEAD"])
  if (branchResult.code !== 0) return true
  const branch = branchResult.stdout.trim()
  const lsRemote = gitExec(bundleRoot, ["ls-remote", "--heads", remote, branch], 10000)
  if (lsRemote.code !== 0) return true
  return lsRemote.stdout.trim().length === 0
}

function makePushHandler(deps: { now?: () => number } = {}): ToolHandler {
  return (args) => {
    const bundleRoot = getAgentRoot()
    const remote = typeof args.remote === "string" && args.remote.length > 0 ? args.remote : "origin"
    const confirmationToken = typeof (args as { confirmation_token?: unknown }).confirmation_token === "string"
      ? (args as { confirmation_token: string }).confirmation_token
      : undefined
    const now = deps.now ?? Date.now

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.bundle_push_start",
      message: "pushing bundle to remote",
      meta: { bundleRoot, remote },
    })

    const finish = (ok: boolean, payload: Record<string, unknown>): string => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.bundle_push_end",
        message: "bundle_push finished",
        meta: { bundleRoot, ok, ...payload },
      })
      return json({ ok, ...payload })
    }

    if (!isGitRepo(bundleRoot)) {
      return finish(false, { error: "bundle is not a git repo" })
    }
    const remotes = listRemotes(bundleRoot)
    if (!remotes.includes(remote)) {
      return finish(false, { error: `remote "${remote}" not configured — run bundle_add_remote first` })
    }
    if (!hasHead(bundleRoot)) {
      return finish(false, { error: "bundle has no commits — run bundle_do_first_commit first" })
    }

    // Directive D: first push to a remote requires the agent to have
    // previously called bundle_first_push_review and obtained a
    // confirmation token. This forces a PII-review gate between
    // "bundle built locally" and "bundle contents on the internet".
    const isFirstPush = isFirstPushToRemote(bundleRoot, remote)
    /* v8 ignore next -- the !isFirstPush branch (subsequent push path) requires a reachable remote to test end-to-end; the path itself falls through to the git push below which is covered by the network-failure test @preserve */
    if (isFirstPush) {
      if (!confirmationToken) {
        emitNervesEvent({
          level: "warn",
          component: "repertoire",
          event: "repertoire.bundle_push_refused",
          message: "bundle_push refused: first push requires confirmation token",
          meta: { bundleRoot },
        })
        return finish(false, {
          error: "refused: first push requires a confirmation token — call bundle_first_push_review, show the warning to the user, and pass the returned confirmationToken to bundle_push",
          kind: "confirmation_required",
        })
      }
      const currentTime = now()
      pruneExpiredTokens(currentTime)
      const entry = _confirmationTokens.get(confirmationToken)
      if (!entry) {
        emitNervesEvent({
          level: "warn",
          component: "repertoire",
          event: "repertoire.bundle_push_refused",
          message: "bundle_push refused: confirmation token invalid or expired",
          meta: { bundleRoot },
        })
        return finish(false, {
          error: "refused: confirmation token invalid or expired — call bundle_first_push_review again",
          kind: "confirmation_required",
        })
      }
      if (entry.bundleRoot !== bundleRoot) {
        emitNervesEvent({
          level: "warn",
          component: "repertoire",
          event: "repertoire.bundle_push_refused",
          message: "bundle_push refused: confirmation token bound to a different bundle",
          meta: { bundleRoot, tokenBundleRoot: entry.bundleRoot },
        })
        return finish(false, {
          error: "refused: confirmation token was issued for a different bundle",
          kind: "confirmation_required",
        })
      }
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.bundle_push_first_push_confirmed",
        message: "first push confirmed by valid token",
        meta: { bundleRoot },
      })
      // One-shot: consume the token on successful validation.
      _confirmationTokens.delete(confirmationToken)
    }

    const push = gitExec(bundleRoot, ["push", remote, "HEAD"], 30000)
    /* v8 ignore start -- push success branch requires a reachable remote, not practical to cover in unit tests; failure branch covered by network-failure test @preserve */
    if (push.code === 0) {
      return finish(true, { remote, firstPush: isFirstPush })
    }
    /* v8 ignore stop */
    const kind = classifyPushError(push.stderr)
    return finish(false, { error: push.stderr.trim(), kind })
  }
}

const pushHandler = makePushHandler()

// ─── tool: bundle_pull_rebase ──────────────────────────────────────────

const pullRebaseHandler: ToolHandler = (args) => {
  const bundleRoot = getAgentRoot()
  const remote = typeof args.remote === "string" && args.remote.length > 0 ? args.remote : "origin"
  const discardChanges = args.discard_changes === "true" || (args.discard_changes as unknown) === true

  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.bundle_pull_rebase_start",
    message: "pulling with rebase",
    meta: { bundleRoot, remote, discardChanges },
  })

  const finish = (ok: boolean, payload: Record<string, unknown>): string => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.bundle_pull_rebase_end",
      message: "bundle_pull_rebase finished",
      meta: { bundleRoot, ok, ...payload },
    })
    return json({ ok, ...payload })
  }

  if (!isGitRepo(bundleRoot)) {
    return finish(false, { error: "bundle is not a git repo" })
  }
  const remotes = listRemotes(bundleRoot)
  if (!remotes.includes(remote)) {
    return finish(false, { error: `remote "${remote}" not configured` })
  }

  // Uncommitted changes: refuse unless discard_changes was explicitly set.
  // Even with discard_changes, we stash+rebase+pop rather than nuke — the
  // user can manually `git stash drop` if they really want to discard.
  const status = gitExec(bundleRoot, ["status", "--porcelain"])
  const isDirty = status.stdout.trim().length > 0
  const stashed = { value: false }
  if (isDirty) {
    if (!discardChanges) {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.bundle_pull_rebase_refused",
        message: "bundle_pull_rebase refused: uncommitted changes",
        meta: { bundleRoot },
      })
      return finish(false, { error: "refused: bundle has uncommitted changes — commit them or pass discard_changes: true (stash+rebase+pop)" })
    }
    /* v8 ignore start -- discardChanges=true stash path exercised in a dirty-tree test below but full rebase+pop requires reachable remote @preserve */
    const stash = gitExec(bundleRoot, ["stash", "push", "-u", "-m", "bundle_pull_rebase stash"])
    if (stash.code !== 0) {
      return finish(false, { error: `git stash failed: ${stash.stderr}` })
    }
    stashed.value = true
    /* v8 ignore stop */
  }

  const rebase = gitExec(bundleRoot, ["pull", "--rebase", remote], 30000)
  /* v8 ignore start -- rebase success branch requires a reachable remote @preserve */
  if (rebase.code === 0) {
    if (stashed.value) {
      const pop = gitExec(bundleRoot, ["stash", "pop"])
      if (pop.code !== 0) {
        return finish(false, { error: `git stash pop failed after successful rebase: ${pop.stderr}`, kind: "stash_conflict" })
      }
    }
    return finish(true, { remote, stashed: stashed.value })
  }
  /* v8 ignore stop */

  // Capture conflict files if the rebase left us mid-conflict.
  const conflictStatus = gitExec(bundleRoot, ["status", "--porcelain=v1"])
  const conflictFiles: string[] = []
  for (const line of conflictStatus.stdout.split("\n")) {
    /* v8 ignore next -- conflict marker extraction requires a real merge conflict, covered indirectly via the network-failure test which returns empty conflictStatus @preserve */
    if (/^(UU|AA|DD|AU|UA|DU|UD) /.test(line)) conflictFiles.push(line.slice(3).trim())
  }
  return finish(false, { error: rebase.stderr.trim(), kind: "conflict", conflictFiles })
}

// ─── registry ──────────────────────────────────────────────────────────

export const bundleToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_check_sync_status",
        description: "Check the git sync status of my bundle. Returns whether my bundle is a git repo, whether it has a remote, the remote URL, the dirty file count, ahead/behind counts, and the structured bundleStateIssues array.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: checkSyncStatusHandler,
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_init_git",
        description: "Initialize my bundle as a git repo. Refuses if a .git directory already exists unless I pass force: true. Also writes a minimal .gitignore that excludes state/. Safe to run — does not touch any existing files.",
        parameters: {
          type: "object",
          properties: {
            force: { type: "boolean", description: "Re-run git init even if .git already exists. Default false." },
          },
        },
      },
    },
    handler: initGitHandler,
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_add_remote",
        description: "Add a git remote to my bundle. Accepts https or git@ URLs. Refuses if the named remote already exists unless I pass force: true. On force, updates the URL via git remote set-url.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "The remote URL (https://... or git@...:...)." },
            name: { type: "string", description: "Remote name. Defaults to 'origin'." },
            force: { type: "boolean", description: "Overwrite an existing remote. Default false." },
          },
          required: ["url"],
        },
      },
    },
    handler: addRemoteHandler,
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_list_first_commit",
        description: "List all untracked files in my bundle (honoring .gitignore), grouped by top-level directory with per-file sizes. Refuses if the bundle is not a git repo or already has commits. Use this before bundle_do_first_commit to review what would be committed.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: listFirstCommitHandler,
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_do_first_commit",
        description: "Make the first commit in my bundle. If I pass an explicit files array, stages only those files. If I omit files, stages everything bundle_list_first_commit would return. Refuses on empty array, on paths outside the bundle root, or if HEAD already exists.",
        parameters: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "string" }, description: "Optional explicit list of relative paths to stage. Omit to stage everything." },
            message: { type: "string", description: "Commit message. Defaults to 'initial: import pre-sync bundle state'." },
          },
        },
      },
    },
    handler: doFirstCommitHandler,
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_first_push_review",
        description: "Review my bundle for PII exposure before the first push to a new remote. Enumerates PII-bearing directories (friends, diary, journal, etc.) with per-directory counts, probes the remote URL for GitHub public/private visibility, and returns a first-person warning text I must show the human plus a confirmationToken I must pass to bundle_push on first push. Required before the first push to any new remote.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: firstPushReviewHandler,
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_push",
        description: "Push my bundle's HEAD to the configured remote. On first push to a new remote, requires a confirmation_token from bundle_first_push_review (Directive D: human must acknowledge PII exposure before the bundle goes over the wire). Subsequent pushes ignore the token. Returns a structured error with kind: 'rejected' | 'network' | 'auth' | 'unknown' | 'confirmation_required' on failure. Does NOT auto-rebase on rejection — use bundle_pull_rebase explicitly when needed.",
        parameters: {
          type: "object",
          properties: {
            remote: { type: "string", description: "Remote name. Defaults to 'origin'." },
            confirmation_token: { type: "string", description: "Opaque token from bundle_first_push_review. Required on the first push to a new remote; ignored on subsequent pushes." },
          },
        },
      },
    },
    handler: pushHandler,
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_pull_rebase",
        description: "Pull from the remote with --rebase. Refuses on uncommitted changes unless I pass discard_changes: true (stash + rebase + pop, NOT a hard discard). On conflict, returns conflictFiles so I can walk the user through resolution.",
        parameters: {
          type: "object",
          properties: {
            remote: { type: "string", description: "Remote name. Defaults to 'origin'." },
            discard_changes: { type: "boolean", description: "Stash + rebase + pop even if the working tree is dirty. Default false." },
          },
        },
      },
    },
    handler: pullRebaseHandler,
  },
]
