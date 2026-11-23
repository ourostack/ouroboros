#!/usr/bin/env node

// For a branch made while pull requests still bumped the version: moves the branch's changelog.json lines into a
// change note under changes/, puts every release file's version back to where the branch started, commits that, and
// merges main. The release job on main sets the version now (scripts/release-version.cjs), so a branch that still
// carries a bump conflicts with every other merge.
//
//   npm run release:drop-bump                      (then git push)
//   npm run release:drop-bump -- --no-merge        (skip merging main)
//   npm run release:drop-bump -- --base-ref origin/main

const { execFileSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const { CHANGED_FILES, prepareReleaseVersion } = require("./release-bump.cjs")

function parseArgs(argv) {
  const options = { baseRef: "origin/main", merge: true }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--no-merge") {
      options.merge = false
      continue
    }
    if (arg === "--base-ref") {
      const next = argv[index + 1]
      if (!next) throw new Error("--base-ref requires a value")
      options.baseRef = next
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "change"
}

// The changelog lines this branch added since `baseChangelog`: whole entries for versions the base lacks, and lines
// added to an entry the base has.
function addedChangelogLines(baseChangelog, headChangelog) {
  const baseEntries = new Map((baseChangelog.versions ?? []).map((entry) => [entry?.version, entry?.changes ?? []]))
  const lines = []
  for (const entry of [...(headChangelog.versions ?? [])].reverse()) {
    const before = baseEntries.get(entry?.version) ?? []
    for (const change of entry?.changes ?? []) {
      if (!before.includes(change) && !lines.includes(change)) lines.push(change)
    }
  }
  return lines
}

function freeNotePath(root, slug) {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = `changes/${slug}${suffix === 1 ? "" : `-${suffix}`}.md`
    if (!fs.existsSync(path.join(root, candidate))) return candidate
  }
}

function dropBump(options, deps) {
  const { root, git, say } = deps
  const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim()
  if (branch === "main" || branch === "HEAD") {
    throw new Error("refusing to run on main or a detached HEAD; check out your pull request's branch first")
  }
  if (git("status", "--porcelain").trim()) {
    throw new Error("the working tree has uncommitted changes; commit or stash them first")
  }

  const [remote] = options.baseRef.split("/")
  if (options.baseRef.includes("/") && git("remote").split("\n").includes(remote)) {
    say(`fetching ${remote}`)
    git("fetch", "-q", remote)
  }
  const mergeBase = git("merge-base", options.baseRef, "HEAD").trim()
  const baseVersion = JSON.parse(git("show", `${mergeBase}:package.json`)).version
  const baseChangelogText = git("show", `${mergeBase}:changelog.json`)
  const headVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
  const lines = addedChangelogLines(JSON.parse(baseChangelogText), JSON.parse(fs.readFileSync(path.join(root, "changelog.json"), "utf8")))

  if (headVersion === baseVersion && lines.length === 0) {
    say(`no version bump to drop: this branch keeps ${baseVersion} and adds no changelog.json lines`)
    return 0
  }

  const notePath = lines.length > 0 ? freeNotePath(root, slugify(branch)) : null
  const writeVersion = prepareReleaseVersion({ root, version: baseVersion })
  writeVersion()
  fs.writeFileSync(path.join(root, "changelog.json"), baseChangelogText)
  if (notePath) {
    fs.mkdirSync(path.join(root, "changes"), { recursive: true })
    fs.writeFileSync(path.join(root, notePath), `${lines.join("\n\n")}\n`)
  }
  git("add", "--", ...CHANGED_FILES, ...(notePath ? [notePath] : []))
  git("commit", "-q", "-m", notePath
    ? `Move this branch's release note into ${notePath} and leave the version to the release job`
    : "Leave the version to the release job")
  say(notePath
    ? `moved ${lines.length} changelog line(s) into ${notePath} and put the release files back to ${baseVersion}`
    : `put the release files back to ${baseVersion}`)

  if (options.merge) {
    say(`merging ${options.baseRef}`)
    try {
      git("merge", "--no-edit", "-q", options.baseRef)
    } catch {
      const conflicts = git("diff", "--name-only", "--diff-filter=U").trim()
      throw new Error(`merging ${options.baseRef} left conflicts outside the release files; resolve them, commit, then git push:\n${conflicts}`)
    }
  }
  say("done; now git push")
  return 0
}

function runDropBumpCli(argv = process.argv.slice(2), deps = {}) {
  const root = deps.root ?? process.cwd()
  const say = deps.say ?? ((line) => console.log(`[release:drop-bump] ${line}`))
  const fail = deps.fail ?? ((line) => console.error(`[release:drop-bump] ${line}`))
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  try {
    return dropBump(parseArgs(argv), { root, git, say })
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (require.main === module) {
  process.exitCode = runDropBumpCli()
}

module.exports = {
  addedChangelogLines,
  parseArgs,
  runDropBumpCli,
  slugify,
}
