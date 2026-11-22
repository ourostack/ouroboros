/**
 * Agent-callable bundle management tools.
 *
 * These tools let the agent fix its own git state — initializing the
 * bundle as a repo, adding a remote, making the first commit, and syncing
 * with the remote (bundle_push and bundle_pull_rebase both run the shared
 * merge-only `syncNow`; neither ever leaves a rebase, a merge or a stash). The `bundleState` field in the
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
 * bundle_add_remote on a configured remote, etc.) refuse by default and require an explicit `force`
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
import type { ToolDefinition, ToolErrorCard, ToolHandler } from "./tools-base"
import { emitNervesEvent } from "../nerves/runtime"
import { getAgentRoot } from "../heart/identity"
import { detectBundleState } from "../heart/bundle-state"
import { listRemoteRefs, syncNow } from "../heart/sync"
import type { SyncConfig } from "../heart/config"
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
    if (hasRemote && firstCommitExists) {
      // Against the last fetched sync branch, named explicitly; no upstream config is assumed.
      const config = bundleSyncConfig(bundleRoot)
      const counts = gitExec(bundleRoot, ["rev-list", "--left-right", "--count", `HEAD...refs/remotes/${config.remote}/${config.branch}`])
      if (counts.code === 0) {
        const [a, b] = counts.stdout.trim().split("\t").map((n) => parseInt(n, 10))
        ahead = a
        behind = b
      }
    }
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
      error: "bundle already has a .git directory — pass force: true to re-init", code: "already-initialized",
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
      return json({ ok: false, error: `git init failed: ${init.stderr}`, code: "git-failed" })
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
    return finish(false, { error: "bundle is not a git repo — run bundle_init_git first", code: "not-a-repo" })
  }

  if (!REMOTE_URL_PATTERN.test(url)) {
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.bundle_add_remote_refused",
      message: "bundle_add_remote refused: invalid url",
      meta: { bundleRoot, url },
    })
    return finish(false, { error: `invalid remote url: ${url || "(empty)"}`, code: "invalid-remote-url" })
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
      error: `remote "${name}" already points to ${existing} — pass force: true to overwrite`, code: "remote-exists",
      previousUrl: existing,
    })
  }

  if (existing) {
    const setUrl = gitExec(bundleRoot, ["remote", "set-url", name, url])
    /* v8 ignore next 3 -- git remote set-url failure requires a permissions/git-state edge case @preserve */
    if (setUrl.code !== 0) {
      return finish(false, { error: `git remote set-url failed: ${setUrl.stderr}`, code: "git-failed" })
    }
  } else {
    const add = gitExec(bundleRoot, ["remote", "add", name, url])
    /* v8 ignore next 3 -- git remote add failure requires a permissions/git-state edge case @preserve */
    if (add.code !== 0) {
      return finish(false, { error: `git remote add failed: ${add.stderr}`, code: "git-failed" })
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
    return finish(false, { error: "bundle is not a git repo — run bundle_init_git first", code: "not-a-repo" })
  }
  if (hasHead(bundleRoot)) {
    return finish(false, { error: "bundle already has commits — bundle_list_first_commit only applies before the first commit", code: "already-committed" })
  }

  const ls = gitExec(bundleRoot, ["ls-files", "-o", "--exclude-standard"])
  /* v8 ignore next 3 -- git ls-files failure requires a corrupt repo @preserve */
  if (ls.code !== 0) {
    return finish(false, { error: `git ls-files failed: ${ls.stderr}`, code: "git-failed" })
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
    return finish(false, { error: "bundle is not a git repo — run bundle_init_git first", code: "not-a-repo" })
  }
  if (hasHead(bundleRoot)) {
    return finish(false, { error: "bundle already has commits — first commit already exists", code: "already-committed" })
  }

  // Resolve the file list — either explicit or the default set from ls-files.
  let filesToStage: string[]
  if (hasExplicitFiles) {
    if (!Array.isArray(rawFiles)) {
      return finish(false, { error: "files must be an array of relative paths", code: "invalid-files" })
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
      return finish(false, { error: "refused: files array must be non-empty — pass explicit file paths or omit the argument to stage everything", code: "invalid-files" })
    }
    filesToStage = rawFiles as string[]
  } else {
    const ls = gitExec(bundleRoot, ["ls-files", "-o", "--exclude-standard"])
    /* v8 ignore next 3 -- git ls-files failure requires a corrupt repo @preserve */
    if (ls.code !== 0) {
      return finish(false, { error: `git ls-files failed: ${ls.stderr}`, code: "git-failed" })
    }
    filesToStage = ls.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  }

  /* v8 ignore next 3 -- empty filesToStage on default path means ls-files returned zero entries, covered by the empty-bundle test path elsewhere @preserve */
  if (filesToStage.length === 0) {
    return finish(false, { error: "no files to commit", code: "nothing-to-commit" })
  }

  // Security boundary: every file must resolve inside bundleRoot.
  for (const file of filesToStage) {
    /* v8 ignore next 3 -- defensive non-string entry check: LLM tool call args are JSON-parsed, a non-string would already fail JSON schema validation upstream @preserve */
    if (typeof file !== "string" || file.length === 0) {
      return finish(false, { error: `invalid file entry: ${JSON.stringify(file)}`, code: "invalid-files" })
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
      return finish(false, { error: check.error, code: "outside-bundle" })
    }
  }

  // Stage via `git add -- <file1> <file2> ...` — explicit enumeration.
  const add = gitExec(bundleRoot, ["add", "--", ...filesToStage])
  /* v8 ignore next 3 -- git add failure on a valid file list requires a corrupt repo or race @preserve */
  if (add.code !== 0) {
    return finish(false, { error: `git add failed: ${add.stderr}`, code: "git-failed" })
  }

  const commit = gitExec(bundleRoot, ["commit", "-m", message])
  /* v8 ignore next 3 -- git commit failure requires a hook-reject or missing user.email, which createTmpBundle pre-configures @preserve */
  if (commit.code !== 0) {
    return finish(false, { error: `git commit failed: ${commit.stderr}`, code: "git-failed" })
  }

  const rev = gitExec(bundleRoot, ["rev-parse", "HEAD"])
  const commitSha = rev.stdout.trim()

  return finish(true, { commitSha, fileCount: filesToStage.length, message })
}

// ─── tool: bundle_first_push_review ────────────────────────────────────

/**
 * Process-local store of confirmation tokens issued by bundle_first_push_review.
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
      return finish(false, { error: "bundle is not a git repo — run bundle_init_git first", code: "not-a-repo" })
    }
    const remotes = listRemotes(bundleRoot)
    if (remotes.length === 0) {
      return finish(false, { error: "no remote configured — run bundle_add_remote first", code: "no-remote" })
    }
    const remoteName = remotes[0]!
    const remoteUrl = getRemoteUrl(bundleRoot, remoteName)
    /* v8 ignore next 3 -- listRemotes returned a name but get-url failed; only possible under a git race @preserve */
    if (!remoteUrl) {
      return finish(false, { error: "could not resolve remote url", code: "git-failed" })
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

// ─── tools: bundle_push and bundle_pull_rebase ─────────────────────────

export type FirstPushProbe = { kind: "first" } | { kind: "pushed" } | { kind: "unreachable"; error: string }

/**
 * Whether a push to `remote` would be the first push of `branch`: "first" when
 * the remote has no such branch, "pushed" when it has. The remote is asked
 * through sync's own ls-remote (the same flags and environment as sync's push,
 * so in the container it goes through the ouro-sync ssh). A failed ls-remote
 * is "unreachable", never taken for a first push or for a pushed one.
 *
 * Exported for direct unit testing in bundle-push-first-push.test.ts.
 */
export async function probeFirstPush(bundleRoot: string, remote: string, branch: string): Promise<FirstPushProbe> {
  const listed = await listRemoteRefs(bundleRoot, remote, [`refs/heads/${branch}`])
  if (!listed.ok) return { kind: "unreachable", error: listed.error }
  return listed.refs.length === 0 ? { kind: "first" } : { kind: "pushed" }
}

/** How long a bundle tool waits for the bundle sync lock before reporting busy. */
const BUNDLE_TOOL_SYNC_WAIT_MS = 10_000

/** The bundle's sync remote and branch from agent.json: the agent cannot name another remote. */
function bundleSyncConfig(bundleRoot: string): SyncConfig {
  let remote = "origin"
  let branch = "main"
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(bundleRoot, "agent.json"), "utf-8")) as { sync?: { remote?: unknown; branch?: unknown } }
    if (typeof parsed.sync?.remote === "string" && parsed.sync.remote.length > 0) remote = parsed.sync.remote
    if (typeof parsed.sync?.branch === "string" && parsed.sync.branch.length > 0) branch = parsed.sync.branch
  } catch {
    // No readable agent.json: the defaults.
  }
  return { enabled: true, remote, branch }
}

/**
 * Both tools sync the bundle through `syncNow`: commit, fetch, merge, push,
 * under the bundle lock. A conflict is aborted and recorded by sync itself,
 * so no tool call leaves a merge, a rebase or a stash behind.
 */
function makeSyncHandler(toolName: "bundle_push" | "bundle_pull_rebase", deps: { now?: () => number } = {}): ToolHandler {
  return async (args) => {
    const bundleRoot = getAgentRoot()
    const confirmationToken = typeof (args as { confirmation_token?: unknown }).confirmation_token === "string"
      ? (args as { confirmation_token: string }).confirmation_token
      : undefined
    const now = deps.now ?? Date.now
    const config = bundleSyncConfig(bundleRoot)
    const remote = config.remote

    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.bundle_sync_tool_start",
      message: "syncing bundle from a tool",
      meta: { bundleRoot, tool: toolName, remote },
    })

    const finish = (ok: boolean, payload: Record<string, unknown>): string => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.bundle_sync_tool_end",
        message: "bundle sync tool finished",
        meta: { bundleRoot, tool: toolName, ok, ...payload },
      })
      return json({ ok, ...payload })
    }
    const refuse = (message: string, error: string): string => {
      emitNervesEvent({
        level: "warn",
        component: "repertoire",
        event: "repertoire.bundle_push_refused",
        message,
        meta: { bundleRoot, tool: toolName },
      })
      return finish(false, { error, kind: "confirmation_required", code: "confirmation-required" })
    }

    if (!isGitRepo(bundleRoot)) {
      return finish(false, { error: "bundle is not a git repo", code: "not-a-repo" })
    }
    const remotes = listRemotes(bundleRoot)
    if (!remotes.includes(remote)) {
      return finish(false, { error: `remote "${remote}" not configured — run bundle_add_remote first`, code: "no-remote" })
    }
    if (!hasHead(bundleRoot)) {
      return finish(false, { error: "bundle has no commits — run bundle_do_first_commit first", code: "no-commits" })
    }

    // Directive D: first push to a remote requires the agent to have
    // previously called bundle_first_push_review and obtained a
    // confirmation token. This forces a PII-review gate between
    // "bundle built locally" and "bundle contents on the internet".
    const probe = await probeFirstPush(bundleRoot, remote, config.branch!)
    if (probe.kind === "unreachable") {
      return finish(false, { error: `I couldn't reach GitHub to check whether this would be my first push, so I didn't sync: ${probe.error}`, kind: "remote_unreachable", code: "remote-unreachable" })
    }
    const isFirstPush = probe.kind === "first"
    if (isFirstPush) {
      if (!confirmationToken) {
        return refuse(
          `${toolName} refused: first push requires confirmation token`,
          `refused: first push requires a confirmation token — call bundle_first_push_review, show the warning to the user, and pass the returned confirmationToken to ${toolName}`,
        )
      }
      pruneExpiredTokens(now())
      const entry = _confirmationTokens.get(confirmationToken)
      if (!entry) {
        return refuse(`${toolName} refused: confirmation token invalid or expired`, "refused: confirmation token invalid or expired — call bundle_first_push_review again")
      }
      if (entry.bundleRoot !== bundleRoot) {
        return refuse(`${toolName} refused: confirmation token bound to a different bundle`, "refused: confirmation token was issued for a different bundle")
      }
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.bundle_push_first_push_confirmed",
        message: "first push confirmed by valid token",
        meta: { bundleRoot },
      })
    }

    const agentName = path.basename(bundleRoot).replace(/\.ouro$/, "")
    // The valid token is the owner's recorded yes, which sync needs before a first push to an empty remote.
    const result = await syncNow(bundleRoot, config, agentName, BUNDLE_TOOL_SYNC_WAIT_MS, { firstPushApproved: isFirstPush })
    const where = { remote, branch: config.branch, firstPush: isFirstPush }
    if (result.paused) return finish(false, { ...where, paused: true, pausedUntil: result.pausedUntil, error: `sync paused until ${result.pausedUntil}`, code: "sync-paused" })
    if (result.busy) return finish(false, { ...where, busy: true, holderPid: result.holderPid, error: result.error, code: "sync-busy" })
    // One-shot: the token is spent once sync actually ran, not on a busy or paused refusal.
    if (confirmationToken !== undefined && isFirstPush) _confirmationTokens.delete(confirmationToken)
    if (!result.ok) {
      const failure = readPendingFailure(bundleRoot)
      return finish(false, {
        ...where,
        error: result.error, code: "sync-failed",
        ...(failure?.classification ? { kind: failure.classification } : {}),
        ...(failure?.conflictFiles && failure.conflictFiles.length > 0 ? { conflictFiles: failure.conflictFiles } : {}),
      })
    }
    return finish(true, where)
  }
}

/** The pending-sync record sync wrote for this failure, when readable. */
function readPendingFailure(bundleRoot: string): { classification?: string; conflictFiles?: string[] } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(bundleRoot, "state", "pending-sync.json"), "utf-8")) as { classification?: string; conflictFiles?: string[] }
  } catch {
    return null
  }
}

const pushHandler = makeSyncHandler("bundle_push")
const pullRebaseHandler = makeSyncHandler("bundle_pull_rebase")

// ─── registry ──────────────────────────────────────────────────────────

const notARepo = (tool: string): ToolErrorCard => ({ code: "not-a-repo", means: "My bundle has no .git directory yet.", fix: `Call bundle_init_git, then ${tool} again.` })
const gitFailed = (tool: string): ToolErrorCard => ({ code: "git-failed", means: "A git command failed; the error carries git's own words.", fix: `Fix what git names, or call bundle_check_sync_status to see the state, before ${tool} again.` })

/** The refusals bundle_push and bundle_pull_rebase share, since both run the same sync. */
function syncErrors(tool: string): ToolErrorCard[] {
  return [
    notARepo(tool),
    { code: "no-remote", means: "The bundle has no remote of that name.", fix: `Call bundle_add_remote with the owner's repository URL, then ${tool} again.` },
    { code: "no-commits", means: "The bundle has no commits to sync.", fix: `Call bundle_list_first_commit and bundle_do_first_commit, then ${tool} again.` },
    { code: "confirmation-required", means: "This would be the first push, and no valid confirmationToken came with it.", fix: `Call bundle_first_push_review, show the human its warning, and on their yes pass its token to ${tool}.` },
    { code: "remote-unreachable", means: "GitHub couldn't be reached to tell whether this is a first push, so nothing synced.", fix: `Call ${tool} again later; it changed nothing.` },
    { code: "sync-busy", means: "Another sync holds the bundle right now.", fix: `Wait a minute and call ${tool} again.` },
    { code: "sync-paused", means: "Syncing is paused by a pause marker; pausedUntil says until when, and nothing synced.", fix: `Tell the human sync is paused until pausedUntil; don't call ${tool} again before then.` },
    { code: "sync-failed", means: "The sync ran and failed; kind and conflictFiles say how.", fix: "Tell the human what kind and conflictFiles name; for conflicts, fix those files and sync again." },
  ]
}

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
    ax: {
      id: "tool:bundle_check_sync_status", group: "turn-bundle", effect: "read",
      when: "Pick this first whenever the turn packet flags a bundleState issue, to see which bundle_ fix comes next.",
      errors: [{ code: "tool-changed", means: "The tools for this turn changed before the check ran, so it read nothing.", fix: "Check the current tool list; call bundle_check_sync_status again only if it is still there." }],
    },
    handler: checkSyncStatusHandler,
    riskProfile: { mutates: "none", risk: "low" },
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
    ax: {
      id: "tool:bundle_init_git", group: "turn-bundle", effect: "write",
      when: "Pick this when bundle_check_sync_status says my bundle isn't a git repository yet; force only with the human's yes.",
      errors: [
        { code: "already-initialized", means: "The bundle already has a .git directory, so nothing changed.", fix: "Go on with bundle_add_remote; pass force: true only if the human asks to re-run git init." },
        gitFailed("bundle_init_git"),
      ],
    },
    handler: initGitHandler,
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "initializes bundle git state" },
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
    ax: {
      id: "tool:bundle_add_remote", group: "turn-bundle", effect: "write",
      when: "Pick this once my bundle is a repository and needs the owner's backup repository to sync with.",
      errors: [
        notARepo("bundle_add_remote"),
        { code: "invalid-remote-url", means: "url isn't an https:// or git@ address.", fix: "Ask the human for the repository's https or SSH URL and pass it exactly." },
        { code: "remote-exists", means: "A remote with that name already points somewhere else; previousUrl says where.", fix: "Show the human both URLs; pass force: true only if they say to replace it." },
        gitFailed("bundle_add_remote"),
      ],
    },
    handler: addRemoteHandler,
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "updates bundle git remote configuration" },
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
    ax: {
      id: "tool:bundle_list_first_commit", group: "turn-bundle", effect: "read",
      when: "Pick this before bundle_do_first_commit, to show the human exactly which files the very first commit would take.",
      errors: [
        notARepo("bundle_list_first_commit"),
        { code: "already-committed", means: "The bundle already has commits, so there is no first commit to plan.", fix: "Call bundle_check_sync_status; ordinary changes sync with bundle_push." },
        gitFailed("bundle_list_first_commit"),
      ],
    },
    handler: listFirstCommitHandler,
    riskProfile: { mutates: "none", risk: "low" },
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
    ax: {
      id: "tool:bundle_do_first_commit", group: "turn-bundle", effect: "write",
      when: "Pick this after the human has seen bundle_list_first_commit's list and agreed, to record the bundle's very first commit.",
      errors: [
        notARepo("bundle_do_first_commit"),
        { code: "already-committed", means: "The bundle already has a first commit.", fix: "Skip this step; go on with bundle_first_push_review and bundle_push." },
        { code: "invalid-files", means: "files is empty, isn't a list of path strings, or holds a bad entry.", fix: "Pass relative paths from bundle_list_first_commit, or omit files to stage that whole list." },
        { code: "outside-bundle", means: "A path in files leads outside the bundle, so nothing was staged.", fix: "Pass only paths inside the bundle, as bundle_list_first_commit shows them." },
        { code: "nothing-to-commit", means: "There are no files to commit.", fix: "Call bundle_list_first_commit to check; if it is empty, there is nothing to do." },
        gitFailed("bundle_do_first_commit"),
      ],
    },
    handler: doFirstCommitHandler,
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "creates a bundle git commit" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_first_push_review",
        description: "Review my bundle for PII exposure before the first push to a new remote. Enumerates PII-bearing directories (friends, Desk record, Arc, etc.) with per-directory counts, probes the remote URL for GitHub public/private visibility, and returns a first-person warning text I must show the human plus a confirmationToken I must pass to bundle_push or bundle_pull_rebase on first push. Required before the first push to any new remote.",
        parameters: { type: "object", properties: {} },
      },
    },
    ax: {
      id: "tool:bundle_first_push_review", group: "turn-bundle", effect: "write",
      when: "Pick this before the first sync to a new remote: it shows the human what private records would leave this machine.",
      errors: [
        notARepo("bundle_first_push_review"),
        { code: "no-remote", means: "The bundle has no remote yet, so there is nothing to review a push to.", fix: "Call bundle_add_remote with the owner's repository URL, then review again." },
        gitFailed("bundle_first_push_review"),
      ],
    },
    handler: firstPushReviewHandler,
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_push",
        description: "Sync my bundle with its remote now.",
        parameters: {
          type: "object",
          properties: {
            confirmation_token: { type: "string", description: "Opaque token from bundle_first_push_review. Required on the first push to a new remote; ignored on subsequent pushes." },
          },
        },
      },
    },
    ax: {
      id: "tool:bundle_push", group: "turn-bundle", effect: "write",
      when: "Pick this to send my bundle's new commits to its remote; it runs the same merge-only sync as bundle_pull_rebase.",
      errors: syncErrors("bundle_push"),
    },
    handler: pushHandler,
    riskProfile: { mutates: "external_side_effect", risk: "high", reason: "pushes bundle state to a remote" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "bundle_pull_rebase",
        description: "Sync my bundle with its remote now.",
        parameters: {
          type: "object",
          properties: {
            confirmation_token: { type: "string", description: "Opaque token from bundle_first_push_review. Required on the first push to a new remote; ignored on subsequent pushes." },
          },
        },
      },
    },
    ax: {
      id: "tool:bundle_pull_rebase", group: "turn-bundle", effect: "write",
      when: "Pick this to bring the remote's changes into my bundle; despite its name it merges, the same sync bundle_push runs.",
      errors: syncErrors("bundle_pull_rebase"),
    },
    handler: pullRebaseHandler,
    riskProfile: {
      mutates: ["durable_state_write", "external_side_effect"] as const,
      risk: "high",
      reason: "syncs bundle state with a remote",
    },
  },
]
