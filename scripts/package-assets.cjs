const fs = require("fs")
const path = require("path")

const REQUIRED_PACKAGE_ASSET_PATHS = [
  "assets/bluebubbles-host",
  "RepairGuide.ouro/agent.json",
  "RepairGuide.ouro/psyche/IDENTITY.md",
  "RepairGuide.ouro/psyche/SOUL.md",
  "RepairGuide.ouro/skills/diagnose-broken-remote.md",
  "RepairGuide.ouro/skills/diagnose-stacked-typed-issues.md",
  "RepairGuide.ouro/skills/diagnose-sync-blocked.md",
  "RepairGuide.ouro/skills/diagnose-vault-expired.md",
  "deploy/unraid/Dockerfile",
  "deploy/unraid/audit-container-spec.sh",
  "deploy/unraid/README.txt",
  "deploy/unraid/container-runtime.json",
  "deploy/unraid/sanctuary.xml",
  "deploy/unraid/sanctuary.ouro/agent.json",
  "deploy/unraid/sanctuary.ouro/bundle-meta.json",
  "deploy/unraid/sanctuary.ouro/tool-profiles.json",
  "deploy/unraid/sanctuary.ouro/arc/README.md",
  "deploy/unraid/sanctuary.ouro/habits/sanctuary-health.md",
]

const DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES = [
  "dist/mailbox-ui/dist/",
  "dist/outlook-ui/",
]

const PACKAGE_PAYLOAD_PATH_PREFIXES = [
  "assets/",
  "deploy/unraid/",
  "dist/",
  "RepairGuide.ouro/",
  "SerpentGuide.ouro/",
  "skills/",
]

const PACKAGE_PAYLOAD_FILE_PATHS = [
  "changelog.json",
  "npm-shrinkwrap.json",
  "package.json",
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
const removedBlueBubblesTimeoutNotice = [
  "live iMessage turn timed out",
  "I captured it for recovery instead of silently hanging",
].join("; ")

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
  { label: "removed BlueBubbles timeout notice", pattern: new RegExp(escapedRegExp(removedBlueBubblesTimeoutNotice)) },
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

function canContainPackagePayload(relativePath) {
  const directoryPrefix = `${toPackagePath(relativePath)}/`
  return PACKAGE_PAYLOAD_PATH_PREFIXES.some(
    (payloadPrefix) => payloadPrefix.startsWith(directoryPrefix) || directoryPrefix.startsWith(payloadPrefix),
  )
}

function isPackagePayloadFile(relativePath) {
  const packagePath = toPackagePath(relativePath)
  return PACKAGE_PAYLOAD_FILE_PATHS.includes(packagePath) || PACKAGE_PAYLOAD_PATH_PREFIXES.some(
    (payloadPrefix) => packagePath.startsWith(payloadPrefix),
  )
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
        if (!canContainPackagePayload(relativePath)) {
          continue
        }
        walk(absolutePath, relativePath)
      } else if (entry.isFile() && isPackagePayloadFile(relativePath)) {
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
    cwd: process.cwd,
    dirname: path.dirname,
    existsSync: fs.existsSync,
    join: path.join,
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    realpathSync: fs.realpathSync,
    resolve: path.resolve,
    statSync: fs.statSync,
    writeStderr: (text) => process.stderr.write(text),
    writeStdout: (text) => process.stdout.write(text),
  }
}

function runPackageAssetsCli(argv = process.argv.slice(2), deps = defaultDeps()) {
  const packageRoot = deps.resolve(argv[0] ?? deps.cwd())
  const result = validatePackageAssets(packageRoot, deps)
  if (result.ok) {
    deps.writeStdout(`${result.message}\n`)
    return 0
  }
  deps.writeStderr(`${result.message}\n`)
  return 1
}

if (require.main === module) {
  process.exitCode = runPackageAssetsCli()
}

module.exports = {
  DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES,
  DISALLOWED_PACKAGE_ASSET_TEXT_PATTERNS,
  IGNORED_LOCAL_PACKAGE_ASSET_PATH_PREFIXES,
  PACKAGE_PAYLOAD_FILE_PATHS,
  PACKAGE_PAYLOAD_PATH_PREFIXES,
  REQUIRED_PACKAGE_ASSET_PATHS,
  listPackageFiles,
  packageRootFromBinPath,
  runPackageAssetsCli,
  validatePackageAssets,
}
