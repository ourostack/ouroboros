import { describe, it, expect } from "vitest"
import { humanReadableToolDescription } from "../../heart/tool-description"

describe("humanReadableToolDescription", () => {
  describe("shell", () => {
    it("extracts the command basename from args.command", () => {
      expect(humanReadableToolDescription("shell", { command: "npm test" }))
        .toBe("running npm test...")
    })

    it("truncates long commands at word boundary", () => {
      // truncate(cmd, 50) — slice(0, 49) then find last space
      // "npm run build && npm run lint && npm run test && echo done" (58 chars)
      // slice(0,49) = "npm run build && npm run lint && npm run test && "
      // lastSpace = 48 (after "&&"), so cuts to "npm run build && npm run lint && npm run test &&"
      const longCmd = "npm run build && npm run lint && npm run test && echo done"
      const result = humanReadableToolDescription("shell", { command: longCmd })
      expect(result).toBe("running npm run build && npm run lint && npm run test &&\u2026...")
    })

    it("hard truncates single long word with no spaces", () => {
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

  describe("search_notes", () => {
    it("extracts args.query", () => {
      expect(humanReadableToolDescription("search_notes", { query: "MCP" }))
        .toBe("searching notes for 'MCP'...")
    })

    it("falls back to generic when no query arg", () => {
      expect(humanReadableToolDescription("search_notes", {}))
        .toBe("searching notes...")
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
    it("returns fallback without query", () => {
      expect(humanReadableToolDescription("web_search", {}))
        .toBe("searching the web...")
    })
    it("includes query when provided", () => {
      expect(humanReadableToolDescription("web_search", { query: "ouroboros agent" }))
        .toBe("searching the web for 'ouroboros agent'...")
    })
  })

  describe("coding_spawn", () => {
    it("returns fallback without runner", () => {
      expect(humanReadableToolDescription("coding_spawn", {}))
        .toBe("starting coding session...")
    })
    it("includes runner when provided", () => {
      expect(humanReadableToolDescription("coding_spawn", { runner: "codex" }))
        .toBe("starting codex coding session...")
    })
  })

  describe("ponder", () => {
    it("returns fallback without thought", () => {
      expect(humanReadableToolDescription("ponder", {}))
        .toBe("bookmarking deeper work...")
    })
    it("includes thought when provided", () => {
      expect(humanReadableToolDescription("ponder", { thought: "the auth approach" }))
        .toBe("bookmarking the auth approach...")
    })
    it("prefers objective when provided", () => {
      expect(humanReadableToolDescription("ponder", { objective: "bulletproof screenshot recovery" }))
        .toBe("bookmarking bulletproof screenshot recovery...")
    })
  })

  describe("observe", () => {
    it("returns null (hidden, like settle)", () => {
      expect(humanReadableToolDescription("observe", {}))
        .toBeNull()
    })
  })

  describe("diary_write", () => {
    it("returns fallback without about", () => {
      expect(humanReadableToolDescription("diary_write", {}))
        .toBe("noting something down...")
    })
    it("includes about when provided", () => {
      expect(humanReadableToolDescription("diary_write", { about: "MCP bridge" }))
        .toBe("noting something about MCP bridge...")
    })
  })

  describe("save_friend_note", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("save_friend_note", {}))
        .toBe("making a note about you...")
    })
  })

  describe("get_friend_note", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("get_friend_note", {}))
        .toBe("checking my notes...")
    })
  })

  describe("load_skill", () => {
    it("includes skill name when provided", () => {
      expect(humanReadableToolDescription("load_skill", { name: "coding" }))
        .toBe("loading coding skill...")
    })

    it("falls back to generic when no name arg", () => {
      expect(humanReadableToolDescription("load_skill", {}))
        .toBe("loading a skill...")
    })
  })

  describe("coding_status", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("coding_status", {}))
        .toBe("checking coding sessions...")
    })
  })

  describe("coding_tail", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("coding_tail", {}))
        .toBe("reading coding output...")
    })
  })

  describe("coding_kill", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("coding_kill", {}))
        .toBe("stopping coding session...")
    })
  })

  describe("bridge_manage", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("bridge_manage", {}))
        .toBe("managing conversation bridge...")
    })
  })

  describe("send_message", () => {
    it("includes recipient when provided", () => {
      expect(humanReadableToolDescription("send_message", { to: "Jordan" }))
        .toBe("sending a message to Jordan...")
    })

    it("falls back to generic when no to arg", () => {
      expect(humanReadableToolDescription("send_message", {}))
        .toBe("sending a message...")
    })
  })

  describe("surface", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("surface", {}))
        .toBe("sharing a thought...")
    })
  })

  describe("claude", () => {
    it("returns static description", () => {
      expect(humanReadableToolDescription("claude", {}))
        .toBe("reasoning...")
    })
  })

  describe("set_reasoning_effort", () => {
    it("includes level when provided", () => {
      expect(humanReadableToolDescription("set_reasoning_effort", { level: "high" }))
        .toBe("setting thinking depth to high...")
    })

    it("falls back to generic when no level arg", () => {
      expect(humanReadableToolDescription("set_reasoning_effort", {}))
        .toBe("adjusting thinking depth...")
    })
  })

  describe("descend", () => {
    it("returns null (hidden)", () => {
      expect(humanReadableToolDescription("descend", {}))
        .toBeNull()
    })
  })

  describe("speak", () => {
    it("returns null (hidden — visible output is the message itself via onTextChunk/flushNow)", () => {
      expect(humanReadableToolDescription("speak", { message: "hi friend" }))
        .toBeNull()
    })
  })

  describe("query_session modes", () => {
    it("returns search text when mode is search", () => {
      expect(humanReadableToolDescription("query_session", { mode: "search", query: "MCP" }))
        .toBe("searching session for 'MCP'...")
    })

    it("returns search text with empty query fallback", () => {
      expect(humanReadableToolDescription("query_session", { mode: "search" }))
        .toBe("searching session for ''...")
    })

    it("returns status text when mode is status", () => {
      expect(humanReadableToolDescription("query_session", { mode: "status" }))
        .toBe("checking inner session status...")
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
