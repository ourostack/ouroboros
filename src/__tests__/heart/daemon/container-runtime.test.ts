import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import { hasManagedTelegramProcess, readContainerRuntimePolicy } from "../../../heart/daemon/container-runtime"

describe("container runtime policy", () => {
  it("accepts only the locked scheduler/update policy", () => {
    expect(readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "supercronic", updates: "disabled" }) })).toEqual({ scheduler: "supercronic", updates: "disabled" })
    expect(() => readContainerRuntimePolicy({ readFile: () => JSON.stringify({ scheduler: "cron", updates: "disabled" }) })).toThrow()
  })

  it("packages the process inspector required by fail-fast orphan cleanup", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")
    expect(dockerfile).toMatch(/apt-get install[^\n]*\bprocps\b/u)
  })

  it("ships a released-package Docker build context", () => {
    const dockerfile = fs.readFileSync("deploy/unraid/Dockerfile", "utf8")
    const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8")) as { files: string[] }

    expect(packageJson.files).toContain("deploy/unraid/")
    expect(packageJson.files).toContain("npm-shrinkwrap.json")
    expect(fs.existsSync("npm-shrinkwrap.json")).toBe(true)
    expect(dockerfile).toContain("COPY package.json npm-shrinkwrap.json ./")
    expect(dockerfile).toContain("npm ci --omit=dev")
    expect(dockerfile).not.toContain("npm install")
  })

  it("keeps Workbench and duplicate habit scheduling out of the dedicated bundle", () => {
    const agent = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/agent.json", "utf8")) as { senses: Record<string, unknown> }
    expect(agent.senses).not.toHaveProperty("workbench")
    expect(fs.existsSync("deploy/unraid/sanctuary.ouro/habits/sanctuary-health.md")).toBe(false)
  })

  it("requires exactly one matching managed Telegram process", () => {
    const telegram = "node /opt/ouro/dist/senses/telegram-entry.js --agent sanctuary"
    expect(hasManagedTelegramProcess(`node daemon-entry.js\n${telegram}\n`, "sanctuary")).toBe(true)
    expect(hasManagedTelegramProcess("node daemon-entry.js\n", "sanctuary")).toBe(false)
    expect(hasManagedTelegramProcess(`${telegram}\n${telegram}\n`, "sanctuary")).toBe(false)
    expect(hasManagedTelegramProcess("node /opt/ouro/dist/senses/telegram-entry.js --agent other\n", "sanctuary")).toBe(false)
  })
})
