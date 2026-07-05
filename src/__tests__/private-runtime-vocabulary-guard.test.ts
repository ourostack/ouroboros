import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as path from "path"

type OldVocabularyPattern = {
  id: string
  regex: RegExp
}

type Finding = {
  file: string
  line: number
  pattern: string
  text: string
}

type AllowedFinding = {
  pathPrefix?: string
  path?: string
  patternIds?: string[]
  textIncludes?: string[]
  classification: "compat-alias" | "persisted-history" | "provider-lane-out-of-scope" | "safety-guard"
  reason: string
}

const OLD_VOCABULARY: OldVocabularyPattern[] = [
  { id: "private runtimeue", regex: /private runtimeue/gi },
  { id: "private-runtimeue", regex: /private-runtimeue/gi },
  { id: "inner-dialog", regex: /inner-dialog/gi },
  { id: "inner_dialog", regex: /inner_dialog/gi },
  { id: "inner dialog", regex: /inner dialog/gi },
  { id: "inner dialogue", regex: /inner dialogue/gi },
  { id: "innerDialog", regex: /innerDialog/g },
  { id: "InnerDialog", regex: /InnerDialog/g },
  { id: "inner work", regex: /inner work/gi },
  { id: "inner-lane scratch", regex: /inner-lane scratch/gi },
  { id: "inner session", regex: /inner session/gi },
  { id: "inner-lane turn", regex: /inner-lane turns?/gi },
  { id: "inner turn", regex: /inner turn/gi },
  { id: "inner terminal move", regex: /inner terminal move/gi },
  { id: "self/inner progress", regex: /self\/inner progress/gi },
  { id: "inner return obligations", regex: /inner return obligations/gi },
  { id: "private thinking", regex: /private thinking/gi },
  { id: "queued to inner/dialog", regex: /queued to inner\/dialog/gi },
  { id: "inner pass", regex: /inner pass/gi },
  { id: "self/inner context", regex: /self\/inner context/gi },
  { id: "self/inner checks", regex: /self\/inner checks/gi },
  { id: "inner thought marker", regex: /\[inner thought/gi },
  { id: "inner attention", regex: /inner attention/gi },
  { id: "inner wake", regex: /inner wake/gi },
  { id: "old inner transcript", regex: /old inner transcript/gi },
  { id: "my inner life", regex: /# my inner life/gi },
  { id: "channel inner label", regex: /["'`]channel: inner/gi },
  { id: "current sense inner label", regex: /["'`]current sense: inner/gi },
  { id: "ouro inner command", regex: /ouro inner/gi },
]

const ALLOWED_FINDINGS: AllowedFinding[] = [
  {
    path: "src/__tests__/private-runtime-vocabulary-guard.test.ts",
    classification: "safety-guard",
    reason: "the guard names old vocabulary patterns so it can classify them",
  },
  {
    path: "src/__tests__/docs/private-runtime-docs.contract.test.ts",
    classification: "safety-guard",
    reason: "the docs contract names stale documentation patterns so it can reject them",
  },
  {
    path: "src/senses/inner-dialog.ts",
    classification: "compat-alias",
    reason: "legacy module shim delegating to canonical private-runtime exports",
  },
  {
    path: "src/senses/inner-dialog-worker.ts",
    classification: "compat-alias",
    reason: "legacy worker shim delegating to canonical private-runtime worker",
  },
  {
    path: "src/__tests__/senses/inner-dialog-compat.test.ts",
    classification: "compat-alias",
    reason: "explicit compatibility-shim test fixture",
  },
  {
    path: "src/heart/daemon/agent-discovery.ts",
    textIncludes: ["innerDialog", "InnerDialog"],
    classification: "compat-alias",
    reason: "legacy agent.json migration input for privateRuntime",
  },
  {
    path: "src/__tests__/heart/daemon/agent-discovery.test.ts",
    textIncludes: ["innerDialog", "InnerDialog"],
    classification: "compat-alias",
    reason: "tests legacy agent.json migration input for privateRuntime",
  },
  {
    path: "src/__tests__/heart/agent-entry.test.ts",
    textIncludes: ["inner-dialog-worker", "startInnerDialogWorker"],
    classification: "compat-alias",
    reason: "ensures the current agent entrypoint does not import the legacy worker shim",
  },
  {
    path: "src/mind/pending.ts",
    textIncludes: ["INNER_DIALOG_PENDING", "getInnerDialogPendingDir"],
    classification: "persisted-history",
    reason: "legacy alias for the durable self/inner/dialog pending path",
  },
  {
    path: "src/__tests__/senses/bluebubbles/callbacks.test.ts",
    textIncludes: ["[surfaced from inner dialog]"],
    classification: "safety-guard",
    reason: "verifies legacy internal meta markers are still stripped from outward BlueBubbles sends",
  },
  {
    path: "src/__tests__/senses/bluebubbles/index.test.ts",
    textIncludes: ["[surfaced from inner dialog]"],
    classification: "safety-guard",
    reason: "verifies legacy internal meta markers are still stripped from outward BlueBubbles sends",
  },
  {
    path: "packages/mailbox-ui/src/components/tabs/live-refresh.test.tsx",
    textIncludes: ["not.toContain(\"Inner work\")", "not.toContain(\"Pending inner work queued.\")"],
    classification: "safety-guard",
    reason: "verifies old Mailbox UI copy stays absent from current private-runtime UI",
  },
  {
    path: "src/__tests__/mind/prompt.test.ts",
    textIncludes: ["not.toContain(\"channel: inner\")", "not.toContain(\"current sense: inner\")"],
    classification: "safety-guard",
    reason: "verifies private-runtime prompt metadata does not render inner as current channel/sense vocabulary",
  },
  {
    path: "src/__tests__/mind/prompt.test.ts",
    textIncludes: ["not.toContain(\"ouro inner --agent testagent\")"],
    classification: "safety-guard",
    reason: "verifies the system prompt renders canonical private-runtime CLI commands instead of the legacy alias",
  },
  {
    path: "src/heart/daemon/cli-help.ts",
    textIncludes: ["Legacy alias for `ouro private status`", "ouro inner"],
    classification: "compat-alias",
    reason: "explicitly documented legacy CLI alias for canonical private status command",
  },
  {
    path: "src/__tests__/heart/daemon/inner-status.test.ts",
    textIncludes: ["legacy 'inner' command", "legacy alias"],
    classification: "compat-alias",
    reason: "tests legacy CLI alias parsing",
  },
  {
    path: "src/__tests__/heart/daemon/agent-service.test.ts",
    textIncludes: ["not.toContain(\"Inner dialog\")"],
    classification: "safety-guard",
    reason: "verifies MCP catchup output does not regress to the old private-runtime label",
  },
  {
    path: "src/__tests__/heart/daemon/daemon-cli.test.ts",
    textIncludes: [
      "legacy inner status as an alias",
      "keeps the legacy inner alias out of generic usage",
      "legacy alias: use `ouro private status",
    ],
    classification: "compat-alias",
    reason: "tests legacy CLI alias execution points users to canonical private status",
  },
  {
    path: "src/__tests__/heart/daemon/daemon-cli.test.ts",
    textIncludes: ["not.toContain(\"ouro inner\")"],
    classification: "safety-guard",
    reason: "verifies generic CLI usage does not advertise the legacy alias",
  },
  {
    path: "src/__tests__/heart/daemon/cli-help.test.ts",
    textIncludes: ["documents the inner command only as a private-status legacy alias", "ouro inner"],
    classification: "compat-alias",
    reason: "tests direct legacy CLI help stays explicit about the canonical private status command",
  },
  {
    path: "src/__tests__/senses/surface-tool.test.ts",
    textIncludes: ["[surfaced from inner dialog]"],
    classification: "safety-guard",
    reason: "verifies legacy internal meta markers are not treated as deliverable outward content",
  },
  {
    path: "src/heart/core.ts",
    textIncludes: ["inner dialog completes"],
    classification: "safety-guard",
    reason: "keeps old acknowledgement wording fail-closed so legacy private-return claims cannot bypass ponder packet creation",
  },
  {
    path: "src/senses/proactive-content-guard.ts",
    classification: "safety-guard",
    reason: "blocks leaked old private markers from outward proactive content",
  },
  {
    path: "src/__tests__/senses/proactive-content-guard.test.ts",
    classification: "safety-guard",
    reason: "tests leaked old private marker blocking",
  },
  {
    path: "src/senses/bluebubbles-meta-guard.ts",
    classification: "safety-guard",
    reason: "blocks leaked old private markers in BlueBubbles output",
  },
  {
    path: "src/__tests__/senses/bluebubbles-meta-guard.test.ts",
    classification: "safety-guard",
    reason: "tests leaked old private marker blocking",
  },
]

const SCAN_ROOTS = [
  "src",
  "packages",
  "docs",
  "README.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "package.json",
]

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".md", ".json"])

function toRepoPath(absolutePath: string): string {
  return path.relative(process.cwd(), absolutePath).split(path.sep).join("/")
}

function shouldSkipDirectory(name: string): boolean {
  return name === "node_modules" || name === "dist" || name === ".git" || name === "coverage"
}

function shouldScanFile(repoPath: string): boolean {
  if (repoPath.startsWith("docs/doing/")) return false
  if (repoPath.startsWith("packages/") && repoPath.includes("/dist/")) return false
  if (repoPath.startsWith("packages/") && repoPath.includes("/node_modules/")) return false
  if (repoPath.startsWith("src/") || repoPath.startsWith("packages/") || repoPath.startsWith("docs/")) {
    return SOURCE_EXTENSIONS.has(path.extname(repoPath))
  }
  if (repoPath === "README.md" || repoPath === "ARCHITECTURE.md" || repoPath === "package.json") return true
  return /^packages\/[^/]+\/package\.json$/.test(repoPath)
}

function walkFiles(entry: string): string[] {
  const absolutePath = path.join(process.cwd(), entry)
  if (!fs.existsSync(absolutePath)) return []
  const stat = fs.statSync(absolutePath)
  if (stat.isFile()) return shouldScanFile(entry) ? [absolutePath] : []
  if (!stat.isDirectory()) return []

  const files: string[] = []
  const stack = [absolutePath]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const dirent of fs.readdirSync(current, { withFileTypes: true })) {
      if (dirent.isDirectory()) {
        if (!shouldSkipDirectory(dirent.name)) stack.push(path.join(current, dirent.name))
        continue
      }
      if (!dirent.isFile()) continue
      const candidate = path.join(current, dirent.name)
      if (shouldScanFile(toRepoPath(candidate))) files.push(candidate)
    }
  }
  return files.sort()
}

function findOldVocabulary(): Finding[] {
  const findings: Finding[] = []
  for (const filePath of SCAN_ROOTS.flatMap(walkFiles)) {
    const repoPath = toRepoPath(filePath)
    const lines = fs.readFileSync(filePath, "utf-8").split("\n")
    for (const [index, line] of lines.entries()) {
      for (const pattern of OLD_VOCABULARY) {
        pattern.regex.lastIndex = 0
        if (pattern.regex.test(line)) {
          findings.push({
            file: repoPath,
            line: index + 1,
            pattern: pattern.id,
            text: line.trim(),
          })
        }
      }
    }
  }
  return findings
}

function isAllowed(finding: Finding): boolean {
  return ALLOWED_FINDINGS.some((allowed) => {
    if (allowed.path && finding.file !== allowed.path) return false
    if (allowed.pathPrefix && !finding.file.startsWith(allowed.pathPrefix)) return false
    if (allowed.patternIds && !allowed.patternIds.includes(finding.pattern)) return false
    if (allowed.textIncludes && !allowed.textIncludes.some((text) => finding.text.includes(text))) return false
    return true
  })
}

function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line} [${finding.pattern}] ${finding.text}`
}

describe("private-runtime vocabulary guard", () => {
  it("classifies every remaining old private-runtime vocabulary occurrence", () => {
    const unclassified = findOldVocabulary().filter((finding) => !isAllowed(finding))
    expect(
      unclassified.slice(0, 80).map(formatFinding).join("\n"),
      `${unclassified.length} unclassified old private-runtime vocabulary occurrences remain`,
    ).toBe("")
  })
})
