const fs = require("fs")
const path = require("path")

const REQUIRED_PACKAGE_ASSET_PATHS = [
  "RepairGuide.ouro/agent.json",
  "RepairGuide.ouro/psyche/IDENTITY.md",
  "RepairGuide.ouro/psyche/SOUL.md",
  "RepairGuide.ouro/skills/diagnose-bootstrap-drift.md",
  "RepairGuide.ouro/skills/diagnose-broken-remote.md",
  "RepairGuide.ouro/skills/diagnose-stacked-typed-issues.md",
  "RepairGuide.ouro/skills/diagnose-sync-blocked.md",
  "RepairGuide.ouro/skills/diagnose-vault-expired.md",
]

const DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES = [
  "dist/mailbox-ui/dist/",
  "dist/outlook-ui/",
]

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
  const packageFiles = new Set(listPackageFiles(packageRoot, deps))
  const missing = REQUIRED_PACKAGE_ASSET_PATHS
    .filter((assetPath) => !packageFiles.has(assetPath))
    .sort()
  const disallowed = Array.from(packageFiles)
    .filter((assetPath) => DISALLOWED_PACKAGE_ASSET_PATH_PREFIXES.some((prefix) => assetPath.startsWith(prefix)))
    .sort()

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
  REQUIRED_PACKAGE_ASSET_PATHS,
  listPackageFiles,
  packageRootFromBinPath,
  validatePackageAssets,
}
