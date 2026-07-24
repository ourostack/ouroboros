const fs = require("fs")
const path = require("path")
const { execFileSync } = require("child_process")
const ts = require("typescript")

const DISPOSITIONS = new Set(["delete", "relocate", "modify-shared", "retain-generic"])

function violation(code, entryPath, detail) {
  return { code, path: entryPath, detail }
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function baselinePaths(root, commit) {
  return git(root, ["ls-tree", "-r", "--name-only", commit]).split("\n").filter(Boolean)
}

function pathPresent(paths, entryPath) {
  return paths.includes(entryPath) || paths.some((candidate) => candidate.startsWith(`${entryPath}/`))
}

function sourceSpecifiers(filePath) {
  const source = fs.readFileSync(filePath, "utf8")
  const parsed = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true)
  const specifiers = []
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require" &&
      node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      specifiers.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return specifiers
}

function inspectPersonalWorkflowOwnership(rootInput, manifestInput) {
  const root = path.resolve(rootInput)
  const manifest = manifestInput && typeof manifestInput === "object" ? manifestInput : {}
  const violations = []
  if (manifest.schemaVersion !== 1) violations.push(violation("manifest_schema", "tests/fixtures/personal-workflow-surface-ownership.v1.json", "schemaVersion must be 1"))
  if (typeof manifest.baseCommit !== "string" || !/^[0-9a-f]{40}$/.test(manifest.baseCommit)) {
    violations.push(violation("manifest_base_commit", "tests/fixtures/personal-workflow-surface-ownership.v1.json", "baseCommit must be a full Git object id"))
  }
  if (typeof manifest.baseTree !== "string" || !/^[0-9a-f]{40}$/.test(manifest.baseTree)) {
    violations.push(violation("manifest_base_tree", "tests/fixtures/personal-workflow-surface-ownership.v1.json", "baseTree must be a full Git tree id"))
  }
  if (!Array.isArray(manifest.entries)) {
    violations.push(violation("manifest_entries", "tests/fixtures/personal-workflow-surface-ownership.v1.json", "entries must be an array"))
    return { ok: false, violations }
  }

  let baseline = []
  try {
    const actualTree = git(root, ["rev-parse", `${manifest.baseCommit}^{tree}`])
    if (actualTree !== manifest.baseTree) violations.push(violation("baseline_tree", manifest.baseCommit, `expected ${manifest.baseTree}, got ${actualTree}`))
    baseline = baselinePaths(root, manifest.baseCommit)
  } catch (error) {
    violations.push(violation("baseline_unreadable", String(manifest.baseCommit ?? ""), error instanceof Error ? error.message : String(error)))
  }

  const seen = new Set()
  for (const entry of manifest.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string" || entry.path.length === 0) {
      violations.push(violation("entry_schema", "", "each entry requires a non-empty path"))
      continue
    }
    if (seen.has(entry.path)) violations.push(violation("duplicate_entry", entry.path, "path has more than one disposition"))
    seen.add(entry.path)
    if (!DISPOSITIONS.has(entry.disposition)) {
      violations.push(violation("entry_disposition", entry.path, `unknown disposition ${String(entry.disposition)}`))
      continue
    }
    if (entry.disposition === "relocate" && (typeof entry.target !== "string" || entry.target.length === 0)) {
      violations.push(violation("relocation_target", entry.path, "relocate entries require a target"))
    }
    if (baseline.length > 0 && !pathPresent(baseline, entry.path)) {
      violations.push(violation("baseline_path", entry.path, "manifest path was not present in the protected baseline"))
    }

    const absolute = path.join(root, entry.path)
    if (entry.disposition === "delete" && fs.existsSync(absolute)) {
      violations.push(violation("dedicated_surface_present", entry.path, "dedicated personal surface must be deleted"))
    }
    if (entry.disposition === "relocate") {
      if (fs.existsSync(absolute)) violations.push(violation("relocation_source_present", entry.path, "relocation source must be absent"))
      const target = path.join(root, entry.target)
      if (!fs.existsSync(target)) violations.push(violation("relocation_target_missing", entry.target, `relocation target for ${entry.path} is missing`))
    }
    if ((entry.disposition === "modify-shared" || entry.disposition === "retain-generic") && !fs.existsSync(absolute)) {
      violations.push(violation("owned_surface_missing", entry.path, `${entry.disposition} surface is missing`))
    }
  }

  if (baseline.length > 0) {
    const dedicatedBaseline = baseline.filter((entryPath) =>
      /(^|\/)rsvp(?:\/|[-.])/.test(entryPath) ||
      entryPath === "src/heart/daemon/bluebubbles-health-diagnostics.ts" ||
      entryPath === "src/__tests__/heart/daemon/bluebubbles-health-diagnostics.test.ts"
    )
    for (const entryPath of dedicatedBaseline) {
      if (!seen.has(entryPath) && !Array.from(seen).some((owned) => entryPath.startsWith(`${owned}/`))) {
        violations.push(violation("uninventoried_baseline_surface", entryPath, "dedicated baseline path has no disposition"))
      }
    }
  }

  for (const rule of Array.isArray(manifest.forbiddenImports) ? manifest.forbiddenImports : []) {
    if (!rule || typeof rule.path !== "string" || typeof rule.specifierPrefix !== "string") {
      violations.push(violation("import_rule_schema", "", "forbidden import rules require path and specifierPrefix"))
      continue
    }
    const filePath = path.join(root, rule.path)
    if (!fs.existsSync(filePath)) continue
    let specifiers
    try {
      specifiers = sourceSpecifiers(filePath)
    } catch (error) {
      violations.push(violation("import_parse", rule.path, error instanceof Error ? error.message : String(error)))
      continue
    }
    for (const specifier of specifiers.filter((candidate) => candidate.startsWith(rule.specifierPrefix))) {
      violations.push(violation("forbidden_import", rule.path, `imports dedicated personal module ${specifier}`))
    }
  }

  for (const rule of Array.isArray(manifest.forbiddenExactFragments) ? manifest.forbiddenExactFragments : []) {
    if (!rule || typeof rule.path !== "string" || typeof rule.fragment !== "string") {
      violations.push(violation("fragment_rule_schema", "", "forbidden fragment rules require path and fragment"))
      continue
    }
    const filePath = path.join(root, rule.path)
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(rule.fragment)) {
      violations.push(violation("forbidden_fragment", rule.path, `contains dedicated fragment ${JSON.stringify(rule.fragment)}`))
    }
  }

  violations.sort((left, right) => `${left.code}:${left.path}:${left.detail}`.localeCompare(`${right.code}:${right.path}:${right.detail}`))
  return { ok: violations.length === 0, violations }
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || process.cwd())
  const manifestPath = path.resolve(process.argv[3] || path.join(root, "tests", "fixtures", "personal-workflow-surface-ownership.v1.json"))
  const result = inspectPersonalWorkflowOwnership(root, JSON.parse(fs.readFileSync(manifestPath, "utf8")))
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exitCode = result.ok ? 0 : 1
}

module.exports = { inspectPersonalWorkflowOwnership }
