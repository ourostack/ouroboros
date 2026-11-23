// Which changed paths ship, shared by the pull request preflight and the release job on main, so the two never
// disagree about whether a change needs a change note or a new version.

const NOTES_DIR = "changes/"
const NOTES_README = "changes/README.md"

// Files the package or image ships outside the folders below (package.json's files, and the lockfile the image
// installs from), so a change to them alone, such as a lockfile-only security fix, still publishes.
const SHIPPED_FILES = new Set(["npm-shrinkwrap.json", "package-lock.json"])
const SHIPPED_DIRS = ["SerpentGuide.ouro/", "RepairGuide.ouro/", "assets/"]

// A change to any of these publishes a new version.
function versionBumpRequired(changedFiles) {
  return changedFiles.some(
    (file) => file === "package.json" ||
      SHIPPED_FILES.has(file) ||
      SHIPPED_DIRS.some((dir) => file.startsWith(dir)) ||
      file.startsWith("deploy/unraid/") ||
      file.startsWith("skills/") ||
      file.startsWith("scripts/") ||
      (file.startsWith("src/") && !file.startsWith("src/__tests__/")),
  )
}

function wrapperPackageChanged(changedFiles) {
  return changedFiles.some((file) => file.startsWith("packages/ouro.bot/"))
}

// A change to any of these needs a change note, because a person would notice it.
function pathRequiresChangelogFreshness(file) {
  return file.startsWith("deploy/unraid/") ||
    file.startsWith("scripts/") ||
    file.startsWith("skills/") ||
    (file.startsWith("src/") && !file.startsWith("src/__tests__/")) ||
    (file.startsWith("packages/ouro.bot/") && file !== "packages/ouro.bot/package.json")
}

// A change note is a Markdown file directly in changes/, other than the folder's README.
function isChangeNotePath(file) {
  return file.startsWith(NOTES_DIR) && file.endsWith(".md") && file !== NOTES_README &&
    !file.slice(NOTES_DIR.length).includes("/")
}

module.exports = {
  NOTES_DIR,
  NOTES_README,
  isChangeNotePath,
  pathRequiresChangelogFreshness,
  versionBumpRequired,
  wrapperPackageChanged,
}
