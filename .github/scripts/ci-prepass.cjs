// Fast CI pre-pass that the coverage gate waits on.
//
// The full coverage gate takes 20+ minutes, and a syntax error in one test file
// used to surface only at its end. This pass fails in a minute or two instead:
//   1. syntax-parse every tracked src/**/*.ts(x), tests included;
//   2. `node --check` every tracked deploy/**/*.mjs (the release gate lives there);
//   3. `tsc --noEmit` for the main project;
//   4. on PRs (--base-ref), run only the test files the PR adds or changes.
const { spawnSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const TEST_FILE = /^src\/__tests__\/.+\.test\.tsx?$/

function parseArgs(argv) {
  const index = argv.indexOf("--base-ref")
  return { baseRef: index >= 0 ? argv[index + 1] : undefined }
}

function gitLines(repoRoot, args) {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout.split("\n").filter(Boolean)
}

function syntaxErrors(ts, files, readFile) {
  const errors = []
  for (const file of files) {
    const { diagnostics } = ts.transpileModule(readFile(file), {
      fileName: file,
      reportDiagnostics: true,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    })
    for (const diagnostic of diagnostics ?? []) {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      const where = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : undefined
      errors.push(where ? `${file}:${where.line + 1}:${where.character + 1} ${message}` : `${file} ${message}`)
    }
  }
  return errors
}

function changedTestFiles(changedPaths, exists) {
  return changedPaths.filter((file) => TEST_FILE.test(file) && exists(file))
}

function step(label, fn) {
  const started = Date.now()
  const ok = fn()
  console.log(`prepass: ${ok ? "pass" : "FAIL"} ${label} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  return ok
}

function main() {
  const repoRoot = path.resolve(__dirname, "..", "..")
  const { baseRef } = parseArgs(process.argv.slice(2))
  const ts = require("typescript")
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf-8")

  const sourceFiles = gitLines(repoRoot, ["ls-files", "src/*.ts", "src/*.tsx"])
  const syntaxOk = step(`syntax of ${sourceFiles.length} src files`, () => {
    const errors = syntaxErrors(ts, sourceFiles, read)
    for (const error of errors) console.error(error)
    return errors.length === 0
  })

  const deployModules = gitLines(repoRoot, ["ls-files", "deploy/*.mjs"])
  const deployOk = step(`node --check of ${deployModules.length} deploy modules`, () =>
    deployModules.every((file) => spawnSync(process.execPath, ["--check", file], { cwd: repoRoot, stdio: "inherit" }).status === 0))

  const typesOk = step("tsc --noEmit", () =>
    spawnSync(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit", "-p", "tsconfig.json"], { cwd: repoRoot, stdio: "inherit" }).status === 0)

  let testsOk = true
  if (baseRef) {
    const changed = gitLines(repoRoot, ["diff", "--name-only", "--diff-filter=ACMR", `${baseRef}...HEAD`])
    const tests = changedTestFiles(changed, (file) => fs.existsSync(path.join(repoRoot, file)))
    testsOk = tests.length === 0
      ? step("changed test files (none)", () => true)
      : step(`${tests.length} changed test files`, () =>
        spawnSync(path.join(repoRoot, "node_modules", ".bin", "vitest"), ["run", "--passWithNoTests", ...tests], { cwd: repoRoot, stdio: "inherit" }).status === 0)
  }

  if (!(syntaxOk && deployOk && typesOk && testsOk)) process.exitCode = 1
}

if (require.main === module) main()

module.exports = { parseArgs, syntaxErrors, changedTestFiles }
