import { describe, it, expect } from "vitest"
import { humanReadableToolDescription } from "../../heart/tool-description"

describe("humanReadableToolDescription", () => {
  describe("shell", () => {
    it("extracts the command basename from args.command", () => {
      expect(humanReadableToolDescription("shell", { command: "npm test" }))
        .toBe("running npm test...")
    })

    it("truncates long commands", () => {
      const longCmd = "a".repeat(100)
      const result = humanReadableToolDescription("shell", { command: longCmd })
      expect(result!.length).toBeLessThan(70)
      expect(result).toContain("running ")
      expect(result).toMatch(/\.\.\.$/)
    })

    it("handles multiline commands by keeping first line", () => {
      expect(humanReadableToolDescription("shell", { command: "npm test" }))
        .toBe("running npm test...")
    })

    it("falls back to generic when no command arg", () => {
      expect(humanReadableToolDescription("shell", {}))
        .toBe("running a command...")
    })
  })

  describe("read_file", () => {
    it("extracts filename from args.path (primary)", () => {
      expect(humanReadableToolDescription("read_file", { path: "/foo/bar/mcp-server.ts" }))
        .toBe("reading mcp-server.ts...")
    })

    it("extracts filename from args.file_path (fallback)", () => {
      expect(humanReadableToolDescription("read_file", { file_path: "/foo/bar/mcp-server.ts" }))
        .toBe("reading mcp-server.ts...")
    })

    it("handles bare filename (no path separators)", () => {
      expect(humanReadableToolDescription("read_file", { path: "package.json" }))
        .toBe("reading package.json...")
    })

    it("falls back to generic when no path arg", () => {
      expect(humanReadableToolDescription("read_file", {}))
        .toBe("reading a file...")
    })
  })

  describe("write_file", () => {
    it("extracts filename from args.file_path", () => {
      expect(humanReadableToolDescription("write_file", { file_path: "/some/path/config.json" }))
        .toBe("writing config.json...")
    })

    it("falls back to generic when no file_path arg", () => {
      expect(humanReadableToolDescription("write_file", {}))
        .toBe("writing a file...")
    })
  })

  describe("edit_file", () => {
    it("extracts filename from args.file_path", () => {
      expect(humanReadableToolDescription("edit_file", { file_path: "/src/spawner.ts" }))
        .toBe("editing spawner.ts...")
    })

    it("falls back to generic when no file_path arg", () => {
      expect(humanReadableToolDescription("edit_file", {}))
        .toBe("editing a file...")
    })
  })

  describe("recall", () => {
    it("extracts args.query", () => {
      expect(humanReadableToolDescription("recall", { query: "MCP" }))
        .toBe("searching memory for 'MCP'...")
    })

    it("falls back to generic when no query arg", () => {
      expect(humanReadableToolDescription("recall", {}))
        .toBe("searching memory...")
    })
  })

  describe("grep", () => {
    it("extracts pattern from args.pattern", () => {
      expect(humanReadableToolDescription("grep", { pattern: "heartbeat" }))
        .toBe("searching code for 'heartbeat'...")
    })

    it("falls back to generic when no pattern arg", () => {
      expect(humanReadableToolDescription("grep", {}))
        .toBe("searching code...")
    })
  })

  describe("glob", () => {
    it("extracts pattern from args.pattern", () => {
      expect(humanReadableToolDescription("glob", { pattern: "*.ts" }))
        .toBe("searching for *.ts...")
    })

    it("falls back to generic when no pattern arg", () => {
      expect(humanReadableToolDescription("glob", {}))
        .toBe("searching for files...")
    })
  })

  describe("query_session", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("query_session", {}))
        .toBe("checking session history...")
    })
  })

  describe("web_search", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("web_search", {}))
        .toBe("searching the web...")
    })
  })

  describe("coding_spawn", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("coding_spawn", {}))
        .toBe("starting coding session...")
    })
  })

  describe("ponder", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("ponder", {}))
        .toBe("thinking deeper...")
    })
  })

  describe("observe", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("observe", {}))
        .toBe("listening...")
    })
  })

  describe("diary_write", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("diary_write", {}))
        .toBe("noting something down...")
    })
  })

  describe("save_friend_note", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("save_friend_note", {}))
        .toBe("making a note...")
    })
  })

  describe("settle", () => {
    it("returns null (hidden)", () => {
      expect(humanReadableToolDescription("settle", {}))
        .toBeNull()
    })
  })

  describe("unknown tools", () => {
    it("returns fallback for unknown tool", () => {
      expect(humanReadableToolDescription("unknown_tool", {}))
        .toBe("using unknown_tool...")
    })

    it("returns fallback for MCP tools", () => {
      expect(humanReadableToolDescription("mcp__server__tool", {}))
        .toBe("using tool...")
    })
  })

  describe("rest", () => {
    it("returns null (hidden, like settle)", () => {
      expect(humanReadableToolDescription("rest", {}))
        .toBeNull()
    })
  })
})
