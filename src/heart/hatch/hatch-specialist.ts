import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"

export interface SyncSpecialistIdentitiesInput {
  sourceDir: string
  targetDir: string
}

export interface PickRandomSpecialistIdentityInput {
  identitiesDir: string
  random?: () => number
}

export interface SpecialistIdentityPick {
  fileName: string
  content: string
}

export function getSpecialistIdentitySourceDir(): string {
  // Layer 3: in-repo is the only source. The previous `~/AgentBundles/`
  // override branch was removed because there's no scenario where an
  // operator should be editing identities outside the repo — they should
  // edit the in-repo copy and let the daemon read from there.
  return path.join(__dirname, "..", "..", "..", "SerpentGuide.ouro", "psyche", "identities")
}

export function getRepoSpecialistIdentitiesDir(): string {
  return path.join(process.cwd(), "SerpentGuide.ouro", "psyche", "identities")
}

function listMarkdownIdentityFiles(dir: string): string[] {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.endsWith(".md"))
    .sort((left, right) => left.localeCompare(right))
}

export function syncSpecialistIdentities(input: SyncSpecialistIdentitiesInput): string[] {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.hatch_identity_sync_start",
    message: "syncing specialist identity files",
    meta: { sourceDir: input.sourceDir, targetDir: input.targetDir },
  })

  const files = listMarkdownIdentityFiles(input.sourceDir)
  fs.mkdirSync(input.targetDir, { recursive: true })

  for (const fileName of files) {
    const sourcePath = path.join(input.sourceDir, fileName)
    const targetPath = path.join(input.targetDir, fileName)
    fs.copyFileSync(sourcePath, targetPath)
  }

  emitNervesEvent({
    component: "daemon",
    event: "daemon.hatch_identity_sync_end",
    message: "synced specialist identity files",
    meta: { copiedCount: files.length },
  })

  return files
}

export function pickRandomSpecialistIdentity(input: PickRandomSpecialistIdentityInput): SpecialistIdentityPick {
  const files = listMarkdownIdentityFiles(input.identitiesDir)
  if (files.length === 0) {
    emitNervesEvent({
      level: "error",
      component: "daemon",
      event: "daemon.hatch_identity_pick_error",
      message: "no specialist identities were found",
      meta: { identitiesDir: input.identitiesDir },
    })
    throw new Error(`No specialist identities found in ${input.identitiesDir}`)
  }

  const random = input.random ?? Math.random
  const index = Math.min(files.length - 1, Math.floor(random() * files.length))
  const fileName = files[index]
  const content = fs.readFileSync(path.join(input.identitiesDir, fileName), "utf-8")

  emitNervesEvent({
    component: "daemon",
    event: "daemon.hatch_identity_pick",
    message: "picked specialist identity",
    meta: { fileName },
  })

  return { fileName, content }
}
