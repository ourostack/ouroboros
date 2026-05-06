const fs = require("fs")
const path = require("path")

const REQUIRED_PACKAGE_ASSET_PATHS = [
  "RepairGuide.ouro/agent.json",
  "RepairGuide.ouro/psyche/IDENTITY.md",
  "RepairGuide.ouro/psyche/SOUL.md",
  "RepairGuide.ouro/skills/diagnose-broken-remote.md",
  "RepairGuide.ouro/skills/diagnose-stacked-typed-issues.md",
  "RepairGuide.ouro/skills/diagnose-sync-blocked.md",
  "RepairGuide.ouro/skills/diagnose-vault-expired.md",
]

const DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES = [
  "dist/mailbox-ui/dist/",
  "dist/outlook-ui/",
]

const IGNORED_LOCAL_PACKAGE_ASSET_PATH_PREFIXES = [
  ".git/",
  "coverage/",
  "node_modules/",
]

function escapedRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const removedProviderSelectionFile = ["providers", "json"].join(".")
const removedProviderModule = ["provider", "state"].join("-")
const removedProviderCamel = ["provider", "State"].join("")
const removedProviderPascal = ["Provider", "State"].join("")
const removedDriftModule = ["drift", "detection"].join("-")

const DISALLOWED_PACKAGE_ASSET_TEXT_PATTERNS = [
  { label: "removed provider selection file", pattern: new RegExp(escapedRegExp(removedProviderSelectionFile)) },
  {
    label: "removed provider state module",
    pattern: new RegExp([
      escapedRegExp(removedProviderModule),
      escapedRegExp(removedProviderCamel),
      escapedRegExp(removedProviderPascal),
    ].join("|")),
  },
  { label: "removed drift module", pattern: new RegExp(escapedRegExp(removedDriftModule)) },
]

const TEXT_PACKAGE_ASSET_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".txt",
])

function toPackagePath(filePath) {
  return filePath.split(path.sep).join("/")
}

function listPackageFiles(packageRoot, deps = defaultDeps()) {
  if (!deps.existsSync(packageRoot)) return []

  const files = []
  function walk(currentDir, prefix = "") {
    const entries = deps.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      const absolutePath = deps.join(currentDir, entry.name)
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (IGNORED_LOCAL_PACKAGE_ASSET_PATH_PREFIXES.some((ignored) => `${relativePath}/`.startsWith(ignored))) {
          continue
        }
        walk(absolutePath, relativePath)
      } else if (entry.isFile()) {
        files.push(toPackagePath(relativePath))
      }
    }
  }

  walk(packageRoot)
  return files
}

function validatePackageAssets(packageRoot, deps = defaultDeps()) {
  const packageFiles = listPackageFiles(packageRoot, deps)
  const packageFileSet = new Set(packageFiles)
  const missing = REQUIRED_PACKAGE_ASSET_PATHS
    .filter((assetPath) => !packageFileSet.has(assetPath))
    .sort()
  const disallowedByPath = packageFiles
    .filter((assetPath) => DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES.some((prefix) => assetPath.startsWith(prefix)))
    .sort()
  const disallowedByText = packageFiles
    .flatMap((assetPath) => disallowedTextMatches(packageRoot, assetPath, deps))
    .sort()
  const disallowed = [...disallowedByPath, ...disallowedByText].sort()

  if (missing.length === 0 && disallowed.length === 0) {
    return {
      ok: true,
      packageRoot,
      missing,
      disallowed,
      message: "package assets verified",
    }
  }

  const parts = []
  if (missing.length > 0) {
    parts.push(`missing required package assets: ${missing.join(", ")}`)
  }
  if (disallowed.length > 0) {
    parts.push(`disallowed package assets: ${disallowed.join(", ")}`)
  }

  return {
    ok: false,
    packageRoot,
    missing,
    disallowed,
    message: parts.join("; "),
  }
}

function disallowedTextMatches(packageRoot, assetPath, deps) {
  if (!TEXT_PACKAGE_ASSET_EXTENSIONS.has(path.extname(assetPath))) return []
  const absolutePath = deps.join(packageRoot, assetPath)
  let content = ""
  try {
    content = deps.readFileSync(absolutePath, "utf8")
  } catch {
    return []
  }
  return DISALLOWED_PACKAGE_ASSET_TEXT_PATTERNS
    .filter(({ pattern }) => pattern.test(content))
    .map(({ label }) => `${assetPath} contains ${label}`)
}

function packageRootFromBinPath(binPath, packageName = "@ouro.bot/cli", deps = defaultDeps()) {
  const resolvedBinPath = deps.resolve(binPath)
  const candidates = []

  candidates.push(resolvedBinPath)
  candidates.push(deps.join(deps.dirname(deps.dirname(resolvedBinPath)), ...packageName.split("/")))

  try {
    candidates.push(deps.realpathSync(resolvedBinPath))
  } catch {
    // Plain npm shims are not always symlinks; path-derived candidates cover them.
  }

  let matchedPackageRoot = null
  for (const candidate of candidates) {
    const packageRoot = findPackageRoot(candidate, packageName, deps)
    if (matchedPackageRoot === null && packageRoot !== null) {
      matchedPackageRoot = packageRoot
    }
  }

  if (matchedPackageRoot !== null) return matchedPackageRoot
  throw new Error(`could not derive ${packageName} package root from ${binPath}`)
}

function findPackageRoot(startPath, packageName, deps) {
  let current = startPath
  try {
    if (!deps.statSync(current).isDirectory()) current = deps.dirname(current)
  } catch {
    current = deps.dirname(current)
  }

  let matchedPackageRoot = null
  while (current !== deps.dirname(current)) {
    const packageRoot = readMatchingPackageRoot(current, packageName, deps)
    if (matchedPackageRoot === null && packageRoot !== null) {
      matchedPackageRoot = packageRoot
    }
    current = deps.dirname(current)
  }

  return matchedPackageRoot ?? readMatchingPackageRoot(current, packageName, deps)
}

function readMatchingPackageRoot(current, packageName, deps) {
  const packageJsonPath = deps.join(current, "package.json")
  if (!deps.existsSync(packageJsonPath)) return null

  try {
    const packageJson = JSON.parse(deps.readFileSync(packageJsonPath, "utf-8"))
    return packageJson.name === packageName ? current : null
  } catch {
    return null
  }
}

function defaultDeps() {
  return {
    dirname: path.dirname,
    existsSync: fs.existsSync,
    join: path.join,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    realpathSync: fs.realpathSync,
    resolve: path.resolve,
    statSync: fs.statSync,
  }
}

module.exports = {
  DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES,
  DISALLOWED_PACKAGE_ASSET_TEXT_PATTERNS,
  IGNORED_LOCAL_PACKAGE_ASSET_PATH_PREFIXES,
  REQUIRED_PACKAGE_ASSET_PATHS,
  listPackageFiles,
  packageRootFromBinPath,
  validatePackageAssets,
}
