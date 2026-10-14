import { describe, expect, it } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { attentionSidebar, installAttentionSidebar } from "../../../senses/shepherd/attention-sidebar"

describe("native attention button", () => {
  it("opens a browser split without moving coding focus or sending a terminal command", () => {
    const url = `http://127.0.0.1:12345/#${"a".repeat(64)}`
    const source = attentionSidebar(url)
    expect(source).toContain('cmux("browser.open_split", focus: false')
    expect(source).toContain('workspace_id: w.id')
    expect(source).toContain("workspaces.filter { $0.selected }")
    expect(source).not.toContain("w.tabs")
    expect(source).not.toContain("send_text")
    expect(source).not.toContain("command")
    expect(() => attentionSidebar("https://example.com/#token")).toThrow("loopback")
  })

  it("writes a private agent-scoped Swift sidebar atomically and refuses an authored file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "attention-sidebar-test-"))
    const url = `http://127.0.0.1:12345/#${"b".repeat(64)}`
    const file = installAttentionSidebar(directory, url, "ouro")
    expect(file).toBe(path.join(directory, "ouro-attention-ouro.swift"))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(file, "utf8")).toContain(url)
    expect(installAttentionSidebar(directory, url)).toBe(file)
    expect(() => installAttentionSidebar(directory, url, "../escape")).toThrow("safe agent")
    fs.writeFileSync(file, "// written by the operator")
    expect(() => installAttentionSidebar(directory, url)).toThrow("not overwritten")
    expect(fs.readFileSync(file, "utf8")).toBe("// written by the operator")
  })
})
