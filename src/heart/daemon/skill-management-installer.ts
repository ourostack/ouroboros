import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentBundlesRoot } from "../identity"

const SKILL_MANAGEMENT_URL =
  "https://raw.githubusercontent.com/ouroborosbot/ouroboros-skills/main/skills/skill-management/SKILL.md"

export async function ensureSkillManagement(): Promise<void> {
  const bundlesRoot = getAgentBundlesRoot()
  if (!fs.existsSync(bundlesRoot)) return

  // Find all agent bundles
  const entries = fs.readdirSync(bundlesRoot).filter(e => e.endsWith(".ouro"))
  if (entries.length === 0) return

  // Check if ANY bundle is missing the skill
  const missing = entries.filter(e => {
    const targetPath = path.join(bundlesRoot, e, "skills", "skill-management.md")
    return !fs.existsSync(targetPath)
  })

  if (missing.length === 0) return

  // eslint-disable-next-line no-console -- terminal UX: visible install status
  console.log("installing skill-management from ouroboros-skills...")

  try {
    const response = await fetch(SKILL_MANAGEMENT_URL)
    if (!response.ok) {
      // eslint-disable-next-line no-console -- terminal UX: visible install status
      console.error(`✗ failed to fetch skill-management (HTTP ${response.status})`)
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.skill_management_install_error",
        message: "failed to fetch skill-management from GitHub",
        meta: { status: response.status, url: SKILL_MANAGEMENT_URL },
      })
      return
    }

    const content = await response.text()

    for (const bundle of missing) {
      const skillsDir = path.join(bundlesRoot, bundle, "skills")
      const targetPath = path.join(skillsDir, "skill-management.md")
      fs.mkdirSync(skillsDir, { recursive: true })
      fs.writeFileSync(targetPath, content, "utf-8")
    }

    // eslint-disable-next-line no-console -- terminal UX: visible install status
    console.log(`✓ installed skill-management (${missing.length} agent${missing.length > 1 ? "s" : ""})`)
  } catch (error) {
    // eslint-disable-next-line no-console -- terminal UX: visible install status
    console.error(`✗ failed to install skill-management: ${error instanceof Error ? error.message : String(error)}`)
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.skill_management_install_error",
      message: "failed to install skill-management skill",
      meta: { error: error instanceof Error ? error.message : String(error) },
    })
  }
}
