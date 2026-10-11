import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { compareCliVersions } from "./ouro-version-manager"

/**
 * Where a published @ouro.bot/cli release can be found. Some networks block
 * registry.npmjs.org and route npm through a mirror that can lag for weeks,
 * so the updater asks every source and installs from whichever one serves
 * the newest version. CI attaches the same npm tarball to a GitHub release.
 */
export type ReleaseSourceName = "npmjs" | "npm-registry" | "github"

export const CLI_PACKAGE = "@ouro.bot/cli"
export const NPMJS_REGISTRY = "https://registry.npmjs.org/"
export const GITHUB_RELEASES_API = "https://api.github.com/repos/ourostack/ouroboros/releases?per_page=20"
const LOOKUP_TIMEOUT_MS = 15_000
const INSTALL_TIMEOUT_MS = 10 * 60_000

export interface ReleaseSourceDeps {
  fetchJson: (url: string, timeoutMs: number) => Promise<unknown>
  execFile: (command: string, args: string[], options: { timeoutMs: number }) => Promise<string>
}

export interface SourceAnswer {
  source: ReleaseSourceName
  version?: string
  tarballUrl?: string
  error?: string
}

export interface ReleaseLookup {
  latestVersion: string | null
  answers: SourceAnswer[]
}

export function githubTarballName(version: string): string {
  return `ouro.bot-cli-${version}.tgz`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function askNpmjs(deps: ReleaseSourceDeps): Promise<SourceAnswer> {
  const body = await deps.fetchJson(`${NPMJS_REGISTRY}${CLI_PACKAGE.replace("/", "%2f")}`, LOOKUP_TIMEOUT_MS) as { "dist-tags"?: Record<string, unknown> }
  const version = body?.["dist-tags"]?.latest
  if (typeof version !== "string") throw new Error("registry response has no latest dist-tag")
  return { source: "npmjs", version }
}

async function askConfiguredRegistry(deps: ReleaseSourceDeps): Promise<SourceAnswer> {
  const stdout = await deps.execFile("npm", ["view", CLI_PACKAGE, "dist-tags.latest", "--json"], { timeoutMs: LOOKUP_TIMEOUT_MS })
  const version = JSON.parse(stdout.trim()) as unknown
  if (typeof version !== "string") throw new Error("npm view returned no latest dist-tag")
  return { source: "npm-registry", version }
}

interface GithubRelease {
  tag_name?: unknown
  draft?: unknown
  assets?: Array<{ name?: unknown; browser_download_url?: unknown }>
}

async function askGithub(deps: ReleaseSourceDeps): Promise<SourceAnswer> {
  const releases = await deps.fetchJson(GITHUB_RELEASES_API, LOOKUP_TIMEOUT_MS)
  if (!Array.isArray(releases)) throw new Error("GitHub releases response is not a list")
  let best: SourceAnswer | null = null
  for (const release of releases as GithubRelease[]) {
    if (release.draft === true || typeof release.tag_name !== "string") continue
    const version = release.tag_name.replace(/^v/, "")
    const asset = (release.assets ?? []).find((entry) => entry.name === githubTarballName(version))
    if (!asset || typeof asset.browser_download_url !== "string") continue
    if (!best || compareCliVersions(version, best.version as string) > 0) {
      best = { source: "github", version, tarballUrl: asset.browser_download_url }
    }
  }
  if (!best) throw new Error("no GitHub release carries an npm tarball")
  return best
}

export async function lookupLatestRelease(deps: ReleaseSourceDeps): Promise<ReleaseLookup> {
  const asks: Array<[ReleaseSourceName, () => Promise<SourceAnswer>]> = [
    ["npmjs", () => askNpmjs(deps)],
    ["npm-registry", () => askConfiguredRegistry(deps)],
    ["github", () => askGithub(deps)],
  ]
  const answers = await Promise.all(asks.map(async ([source, ask]) => {
    try {
      return await ask()
    } catch (error) {
      return { source, error: message(error) } satisfies SourceAnswer
    }
  }))
  let latestVersion: string | null = null
  for (const answer of answers) {
    if (answer.version && (!latestVersion || compareCliVersions(answer.version, latestVersion) > 0)) {
      latestVersion = answer.version
    }
  }
  emitNervesEvent({
    component: "daemon",
    event: "daemon.self_update_lookup",
    message: "looked up the latest published CLI release",
    meta: {
      latestVersion,
      answers: answers.map((answer) => `${answer.source}=${answer.version ?? `error: ${answer.error}`}`).join("; "),
    },
  })
  return { latestVersion, answers }
}

/**
 * Install `version` into `~/.ouro-cli/versions/<version>`, trying each source
 * that can serve it. Returns the source that worked.
 */
export async function installRelease(
  version: string,
  lookup: ReleaseLookup,
  cliHome: string,
  deps: Pick<ReleaseSourceDeps, "execFile">,
): Promise<ReleaseSourceName> {
  const prefix = path.join(cliHome, "versions", version)
  const github = lookup.answers.find((answer) => answer.source === "github" && answer.version === version && answer.tarballUrl)
  const attempts: Array<[ReleaseSourceName, string[]]> = [
    ["npm-registry", ["install", "--prefix", prefix, `${CLI_PACKAGE}@${version}`]],
    ...(github ? [["github", ["install", "--prefix", prefix, github.tarballUrl as string]] as [ReleaseSourceName, string[]]] : []),
    ["npmjs", ["install", "--prefix", prefix, `${CLI_PACKAGE}@${version}`, "--registry", NPMJS_REGISTRY]],
  ]
  const failures: string[] = []
  for (const [source, args] of attempts) {
    try {
      await deps.execFile("npm", args, { timeoutMs: INSTALL_TIMEOUT_MS })
      emitNervesEvent({
        component: "daemon",
        event: "daemon.self_update_installed",
        message: "installed CLI release for self-update",
        meta: { version, source },
      })
      return source
    } catch (error) {
      failures.push(`${source}: ${message(error).split("\n")[0]}`)
    }
  }
  throw new Error(`could not install ${version} from any source (${failures.join("; ")})`)
}
