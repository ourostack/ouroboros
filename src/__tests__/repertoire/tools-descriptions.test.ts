import { describe, expect, it } from "vitest"
import { baseToolDefinitions, ponderTool, settleTool } from "../../repertoire/tools-base"
import { codingToolDefinitions } from "../../repertoire/coding/tools"
import { adoSemanticToolDefinitions } from "../../repertoire/ado-semantic"

function getBaseDescription(toolName: string): string {
  const def = baseToolDefinitions.find((d) => d.tool.function.name === toolName)
  if (!def) throw new Error(`Tool '${toolName}' not found in baseToolDefinitions`)
  return def.tool.function.description ?? ""
}

function getCodingDescription(toolName: string): string {
  const def = codingToolDefinitions.find((d) => d.tool.function.name === toolName)
  if (!def) throw new Error(`Tool '${toolName}' not found in codingToolDefinitions`)
  return def.tool.function.description ?? ""
}

function getAdoDescription(toolName: string): string {
  const def = adoSemanticToolDefinitions.find((d) => d.tool.function.name === toolName)
  if (!def) throw new Error(`Tool '${toolName}' not found in adoSemanticToolDefinitions`)
  return def.tool.function.description ?? ""
}

describe("Phase 2: tool description enrichment", () => {
  describe("Unit 2.1 - file tool descriptions", () => {
    it("read_file description contains behavioral guidance", () => {
      const desc = getBaseDescription("read_file")
      expect(desc).toContain("Use offset/limit for large files")
      expect(desc).toContain("Use this tool before editing any file")
    })

    it("write_file description contains behavioral guidance", () => {
      const desc = getBaseDescription("write_file")
      expect(desc).toContain("You MUST read an existing file with read_file before overwriting")
      expect(desc).toContain("Prefer edit_file for modifying existing files")
      expect(desc).toContain("Do not create documentation files")
    })

    it("edit_file description contains behavioral guidance", () => {
      const desc = getBaseDescription("edit_file")
      expect(desc).toContain("old_string must match EXACTLY ONE location")
      expect(desc).toContain("Preserve exact indentation")
    })

    it("glob description contains behavioral guidance", () => {
      const desc = getBaseDescription("glob")
      expect(desc).toContain("Use this instead of shell commands like `find` or `ls`")
    })

    it("grep description contains behavioral guidance", () => {
      const desc = getBaseDescription("grep")
      expect(desc).toContain("Use this instead of shell commands like `grep` or `rg`")
    })
  })

  describe("Unit 2.2 - shell tool description", () => {
    it("shell description contains tool preference guidance", () => {
      const desc = getBaseDescription("shell")
      expect(desc).toContain("Use dedicated tools instead of shell when available")
      expect(desc).toContain("read_file instead of cat, edit_file instead of sed, glob instead of find, grep instead of grep/rg")
    })

    it("shell description contains reversibility warning", () => {
      const desc = getBaseDescription("shell")
      expect(desc).toContain("consider reversibility before running")
    })
  })

  describe("Unit 2.3 - memory tool descriptions", () => {
    it("recall description contains semantic similarity guidance", () => {
      const desc = getBaseDescription("recall")
      expect(desc).toContain("Uses semantic similarity -- phrasing matters")
      expect(desc).toContain("Check recall before asking the human something you might already know")
    })

    it("diary_write description contains behavioral guidance", () => {
      const desc = getBaseDescription("diary_write")
      expect(desc).toContain("Write for my future self")
      expect(desc).toContain("Don't duplicate what already belongs in friend notes")
    })
  })

  describe("Unit 2.4 - coding tool descriptions", () => {
    it("coding_spawn description contains delegation guidance", () => {
      const desc = getCodingDescription("coding_spawn")
      expect(desc).toContain("Give it a COMPLETE, SELF-CONTAINED task description")
      expect(desc).toContain("Never delegate understanding")
    })

    it("coding_status description contains progress check guidance", () => {
      const desc = getCodingDescription("coding_status")
      expect(desc).toContain("Use this to check progress before asking the human for a status update")
    })

    it("coding_tail description contains output reading guidance", () => {
      const desc = getCodingDescription("coding_tail")
      expect(desc).toContain("Read the actual output before reporting status -- don't guess")
    })
  })

  describe("Unit 2.5 - metacognitive + other tool descriptions", () => {
    it("ponder description contains usage guidance", () => {
      const desc = ponderTool.function.description ?? ""
      expect(desc).toContain("Don't ponder trivial questions")
      expect(desc).toContain("does not end the turn")
    })

    it("settle description contains substantive response guidance", () => {
      const desc = settleTool.function.description ?? ""
      expect(desc).toContain("If you're settling with 'I'll look into that,' you probably should be using a tool instead")
    })

    it("claude description contains second opinions guidance", () => {
      const desc = getBaseDescription("claude")
      expect(desc).toContain("second opinions")
    })

    it("ado_backlog_list description contains WIQL guidance", () => {
      const desc = getAdoDescription("ado_backlog_list")
      expect(desc).toContain("Use this instead of raw WIQL queries")
    })

    it("ado_create_epic description contains preview guidance", () => {
      const desc = getAdoDescription("ado_create_epic")
      expect(desc).toContain("Use ado_preview_changes first")
    })

    it("ado_create_issue description contains preview guidance", () => {
      const desc = getAdoDescription("ado_create_issue")
      expect(desc).toContain("Use ado_preview_changes first")
    })

    it("ado_move_items description contains preview guidance", () => {
      const desc = getAdoDescription("ado_move_items")
      expect(desc).toContain("Use ado_preview_changes first")
    })

    it("ado_restructure_backlog description contains preview guidance", () => {
      const desc = getAdoDescription("ado_restructure_backlog")
      expect(desc).toContain("Use ado_preview_changes first")
    })
  })
})
