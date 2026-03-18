import * as fs from "fs"
import * as path from "path"
import { getAgentRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

const SKILL_MANAGEMENT_URL =
  "https://raw.githubusercontent.com/ouroborosbot/ouroboros-skills/main/skills/skill-management/SKILL.md"

export async function ensureSkillManagement(): Promise<void> {
  const skillsDir = path.join(getAgentRoot(), "skills")
  const targetPath = path.join(skillsDir, "skill-management.md")

  if (fs.existsSync(targetPath)) {
    return
  }

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
    fs.mkdirSync(skillsDir, { recursive: true })
    fs.writeFileSync(targetPath, content, "utf-8")
    // eslint-disable-next-line no-console -- terminal UX: visible install status
    console.log("✓ installed skill-management")
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
