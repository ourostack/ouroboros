import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

// The old Ouro Mailbox (an agent-inspector page on port 6876) was removed so a fresh Mailbox can be built in its
// place. This guard keeps its code, build steps and data paths from coming back, and proves nothing reads, moves or
// deletes the old data it left in agent bundles (state/mailbox/, state/mailbox-prefs.json, state/outlook-prefs.json).

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
}

const PATTERNS: { id: string; regex: RegExp }[] = [
  { id: "old server module", regex: /heart\/mailbox\b/ },
  { id: "old UI package", regex: /mailbox-ui\b/ },
  { id: "old daemon factory", regex: /mailboxServerFactory/ },
  { id: "old port constant", regex: /MAILBOX_DEFAULT_PORT/ },
  { id: "old prefs file", regex: /(mailbox|outlook)-prefs\.json/ },
  { id: "old state folder", regex: /state\/mailbox\b/ },
  { id: "old Outlook name", regex: /outlook-ui|heart\/outlook\b/ },
]

const TEXT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs", ".mts", ".json", ".md", ".yml", ".yaml", ".css", ".html", ".txt", ".sh"])

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name))) out.push(full)
  }
}

function scannedFiles(): string[] {
  const files: string[] = []
  for (const root of SCANNED_ROOTS) {
    const full = path.join(REPO_ROOT, root)
    if (fs.existsSync(full)) walk(full, files)
  }
  for (const file of SCANNED_FILES) files.push(path.join(REPO_ROOT, file))
  return files
    .map((file) => path.relative(REPO_ROOT, file))
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

  it("has no old UI package or server folder on disk", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "packages/mailbox-ui"))).toBe(false)
    expect(fs.existsSync(path.join(REPO_ROOT, "src/heart/mailbox"))).toBe(false)
  })
})
