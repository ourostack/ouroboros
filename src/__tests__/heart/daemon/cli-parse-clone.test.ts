import { describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { parseOuroCommand, usage } from "../../../heart/daemon/cli-parse"
import { inferAgentNameFromRemote } from "../../../heart/daemon/cli-parse"

describe("ouro clone CLI parsing", () => {
  describe("parseOuroCommand clone", () => {
    it("parses 'clone <remote>' with HTTPS URL", () => {
      const cmd = parseOuroCommand(["clone", "https://github.com/user/agent.ouro.git"])
      expect(cmd).toEqual({
        kind: "clone",
        remote: "https://github.com/user/agent.ouro.git",
      })
    })

    it("parses 'clone <remote> --agent <name>'", () => {
      const cmd = parseOuroCommand(["clone", "https://github.com/user/agent.ouro.git", "--agent", "myagent"])
      expect(cmd).toEqual({
        kind: "clone",
        remote: "https://github.com/user/agent.ouro.git",
        agent: "myagent",
      })
    })

    it("throws when no remote is provided", () => {
      expect(() => parseOuroCommand(["clone"])).toThrow()
    })

    it("handles --agent flag before remote URL", () => {
      const cmd = parseOuroCommand(["clone", "--agent", "myagent", "https://github.com/user/agent.ouro.git"])
      expect(cmd).toEqual({
        kind: "clone",
        remote: "https://github.com/user/agent.ouro.git",
        agent: "myagent",
      })
    })

    it("treats --agent without value as the remote URL", () => {
      // --agent is the last arg with no value, so "clone --agent" => remote = "--agent"
      // This is technically a malformed invocation, but the parser treats --agent
      // as a positional when no value follows
      const cmd = parseOuroCommand(["clone", "--agent"])
      expect(cmd).toEqual({ kind: "clone", remote: "--agent" })
    })
  })

  describe("help clone", () => {
    it("'help clone' returns help command", () => {
      const cmd = parseOuroCommand(["help", "clone"])
      expect(cmd).toEqual({ kind: "help", command: "clone" })
    })

    it("'clone --help' returns help command", () => {
      const cmd = parseOuroCommand(["clone", "--help"])
      expect(cmd).toEqual({ kind: "help", command: "clone" })
    })
  })

  describe("usage", () => {
    it("usage() output includes 'clone'", () => {
      const text = usage()
      expect(text).toContain("clone")
    })
  })

  describe("inferAgentNameFromRemote", () => {
    it("strips .git and .ouro from HTTPS URL", () => {
      expect(inferAgentNameFromRemote("https://github.com/user/agent.ouro.git")).toBe("agent")
    })

    it("strips .git from HTTPS URL without .ouro", () => {
      expect(inferAgentNameFromRemote("https://github.com/user/mybot.git")).toBe("mybot")
    })

    it("strips .git and .ouro from SSH URL", () => {
      expect(inferAgentNameFromRemote("git@github.com:user/test.ouro.git")).toBe("test")
    })

    it("handles URL without .git suffix", () => {
      expect(inferAgentNameFromRemote("https://github.com/user/plain")).toBe("plain")
    })

    it("handles URL with trailing slash", () => {
      expect(inferAgentNameFromRemote("https://github.com/user/mybot.git/")).toBe("mybot")
    })

    it("handles SSH URL without .git suffix", () => {
      expect(inferAgentNameFromRemote("git@github.com:user/mybundle.ouro")).toBe("mybundle")
    })

    it("handles bare name with no slash or colon separator", () => {
      expect(inferAgentNameFromRemote("mybundle.ouro.git")).toBe("mybundle")
    })

    it("handles bare name with no suffix", () => {
      expect(inferAgentNameFromRemote("mybundle")).toBe("mybundle")
    })
  })

  describe("parseCloneCommand extra positional args", () => {
    it("ignores extra positional args after remote is set", () => {
      const cmd = parseOuroCommand(["clone", "https://github.com/user/agent.ouro.git", "extra-arg"])
      expect(cmd).toEqual({
        kind: "clone",
        remote: "https://github.com/user/agent.ouro.git",
      })
    })
  })
})
