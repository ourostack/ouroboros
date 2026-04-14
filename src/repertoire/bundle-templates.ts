/**
 * Templates for agent bundle scaffolding.
 *
 * ## .gitignore design philosophy
 *
 * The bundle .gitignore handles FUNCTIONAL "shouldn't track" cases only:
 *
 *   - Runtime state (sessions, logs, runtime files) — stale data with no
 *     value for review or history.
 *   - Credentials — real secrets live in the agent vault, but defense
 *     in depth in case anything leaks into the bundle.
 *   - Editor / OS noise (.DS_Store, .idea/, etc.).
 *   - Build artifacts (rare in bundles, but possible).
 *
 * It DOES NOT handle PII. The bundle is inherently full of PII — `friends/`,
 * `diary/`, `journal/`, `psyche/`, `arc/`, `facts/`, `family/`, `travel/`
 * etc. That's the point of the bundle; blocking those via .gitignore would
 * defeat the purpose.
 *
 * PII is handled at first-push time by `bundle_first_push_review`, which
 * enumerates PII-bearing directories, shows the agent counts, probes the
 * remote URL for GitHub visibility, and hard-pauses until the human
 * confirms. See Directive D in the planning doc.
 *
 * No content-pattern blocks (no `**\/sk-ant-*` or similar). Content-review
 * failures are a different safety layer — credential scanning at commit
 * time would be a follow-up feature.
 */

export const BUNDLE_GITIGNORE_TEMPLATE = `# Runtime state — sessions, logs, runtime files, never tracked
state/

# Credentials — never tracked. Real secrets live in the agent vault, but
# defense in depth in case anything leaks into the bundle.
.env
.env.*
secrets/
**/*.key
**/*.pem
**/*.credentials
**/*.pfx

# Editor and OS noise
.DS_Store
.idea/
.vscode/
*.swp
*.swo

# Build artifacts (rare in bundles, but possible if a workspace lands here)
node_modules/
dist/
`

/**
 * PII-sensitive top-level directories. Enumerated here so `bundle_first_push_review`
 * can categorize and count. Adding a new PII bucket to the bundle means adding
 * it here so the first-push warning includes it.
 */
export const PII_BUNDLE_DIRECTORIES: readonly string[] = [
  "friends",
  "diary",
  "journal",
  "psyche",
  "arc",
  "facts",
  "family",
  "travel",
  "notes",
  "sessions",
] as const
