import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"
import { execFileSync } from "child_process"
import { MAILBOX_CLI_WORDS } from "../heart/daemon/cli-parse"

// The old Ouro Mailbox (an agent-inspector page on a fixed loopback port) was removed so a fresh Mailbox can be built
// in its place. This guard keeps its code, build steps, commands and names from coming back in tracked files, and
// keeps the literal paths of the old data it left in agent bundles (state/mailbox/, state/mailbox-prefs.json,
// state/outlook-prefs.json) out of the code. It matches text, so a path assembled from parts would get past it.

const REPO_ROOT = path.resolve(__dirname, "../..")
const THIS_FILE = path.relative(REPO_ROOT, __filename)

const SCANNED_ROOTS = ["src", "scripts", ".github", "packages", "skills", "docs", "deploy", "tests"]
const SCANNED_FILES = ["package.json", "vitest.config.ts", ".gitignore", "README.md", "AGENTS.md", "ARCHITECTURE.md"]

// Historical records stay as written: dated planning docs, and the changelog the release job builds.
const HISTORICAL_PREFIXES = ["docs/doing/", "docs/superpowers/", "docs/planning/"]

// Files that name the old page on purpose, each with the reason.
const ALLOWED_FILES: Record<string, string> = {
  "scripts/package-assets.cjs": "refuses to pack stale old-page output left in a local dist/",
  "src/__tests__/scripts/package-assets.test.ts": "proves that refusal",
  ".gitignore": "keeps a pre-removal checkout's leftover old-page build output out of git status",
  "src/__tests__/docs/agent-mail-setup.contract.test.ts": "asserts the mail guide no longer names the old page",
  // The Unraid acceptance contract still allows (does not require) a loopback listener on the old port; tightening it
  // is a separate change to the Sanctuary deployment.
  "deploy/unraid/README.txt": "documents the still-allowed loopback port",
  "deploy/unraid/sanctuary-acceptance-contract.json": "still allows the loopback port",
  "deploy/unraid/sanctuary-deployment-target.mjs": "still allows the loopback port",
  "src/__tests__/scripts/sanctuary-deployment-target.test.ts": "tests that allowance",
}

// The generated group's words: those an agent runs, and the person-only ones every agent door refuses.
const PERSON_ONLY_WORDS = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, "../../actions/generated/mailbox/commands.json"), "utf8")).personOnly).map((name) => name.replace(/^mailbox /, ""))
const NEW_MAILBOX_WORDS = [...[...Object.keys(MAILBOX_CLI_WORDS), ...PERSON_ONLY_WORDS, "handle set"].flatMap((word) => [`${word}\\b`, `<${word}\\b`]), "<word>", "\\$\\{(sub|MAILBOX_USAGE_WORDS)\\}"].join("|")
const OLD_COMMAND = new RegExp(`ouro outlook\\b|ouro mailbox\\b(?! (${NEW_MAILBOX_WORDS}))`)

const PATTERNS: { id: string; regex: RegExp }[] = [
  { id: "old server module", regex: /heart\/mailbox\b/ },
  { id: "old UI package", regex: /mailbox-ui\b/ },
  { id: "old daemon factory", regex: /mailboxServerFactory/ },
  { id: "old port constant", regex: /MAILBOX_DEFAULT_PORT/ },
  { id: "old prefs file", regex: /(mailbox|outlook)-prefs\.json/ },
  { id: "old state folder", regex: /state\/mailbox\b/ },
  { id: "old Outlook name", regex: /outlook-ui|heart\/outlook\b/ },
  { id: "old page name", regex: /Ouro Mailbox/ },
  // `ouro outlook` is gone for good. `ouro mailbox` is allowed again only before a word the new, generated mailbox group
  // declares (or the placeholder or template that stands for one); the old command took none.
  { id: "old command", regex: OLD_COMMAND },
  { id: "old status field", regex: /mailboxUrl|outlookUrl/ },
  { id: "old port", regex: /\b6876\b/ },
]

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs", ".mts", ".json", ".md", ".yml", ".yaml", ".css", ".html", ".txt", ".sh"])

function trackedFiles(): string[] {
  const output = execFileSync("git", ["ls-files", "-z", "--", ...SCANNED_ROOTS, ...SCANNED_FILES], { cwd: REPO_ROOT, encoding: "utf8" })
  return output.split("\0").filter((file) => file !== "" && (TEXT_EXTENSIONS.has(path.extname(file)) || file === ".gitignore"))
}

function scannedFiles(): string[] {
  return trackedFiles()
    .filter((file) => fs.existsSync(path.join(REPO_ROOT, file)))
    .filter((file) => file !== THIS_FILE && !(file in ALLOWED_FILES) && !HISTORICAL_PREFIXES.some((prefix) => file.startsWith(prefix)))
}

describe("the old Ouro Mailbox is gone", () => {
  it("leaves no code, build step, doc or data path that names it", () => {
    const findings: string[] = []
    for (const file of scannedFiles()) {
      const lines = fs.readFileSync(path.join(REPO_ROOT, file), "utf8").split("\n")
      lines.forEach((text, index) => {
        for (const pattern of PATTERNS) {
          if (pattern.regex.test(text)) findings.push(`${file}:${index + 1} (${pattern.id}): ${text.trim().slice(0, 120)}`)
        }
      })
    }
    expect(findings).toEqual([])
  })

  it("still catches the old commands, and lets the new mailbox group's words through", () => {
    for (const old of ["ouro outlook", "ouro outlook --open", "ouro mailbox", "ouro mailbox --agent slugger", "run `ouro mailbox`.", "ouro mailbox open", "ouro mailbox listing", "ouro mailbox ${url}"]) {
      expect(OLD_COMMAND.test(old), old).toBe(true)
    }
    for (const fresh of ["ouro mailbox list [--json]", "`ouro mailbox <word>`: each word", "ouro mailbox ${sub} takes"]) {
      expect(OLD_COMMAND.test(fresh), fresh).toBe(false)
    }
  })

  it("tracks no file in the old UI package or server folder", () => {
    const tracked = execFileSync("git", ["ls-files", "--", "packages/mailbox-ui", "src/heart/mailbox"], { cwd: REPO_ROOT, encoding: "utf8" })
    expect(tracked).toBe("")
  })
})
