import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"

// @ts-expect-error - untyped hand-written module deployed verbatim
import { bundleMediaPaths } from "../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs"

const SOURCE = resolve("deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs")

describe("the media MCP finds its files in the bundle it runs from", () => {
  it.each(["sanctuary", "butler"])("a bundle mounted as %s.ouro resolves to its own folder", (name) => {
    const paths = bundleMediaPaths(`file:///home/ouro/AgentBundles/${name}.ouro/mcp/media-mcp.mjs`)
    expect(paths).toEqual({
      bundleRoot: `/home/ouro/AgentBundles/${name}.ouro`,
      credentials: `/home/ouro/AgentBundles/${name}.ouro/mcp/media-credentials.json`,
      progress: `/home/ouro/AgentBundles/${name}.ouro/state/media/download-progress.json`,
      qualityAudit: `/home/ouro/AgentBundles/${name}.ouro/state/media/quality-profile-audit.ndjson`,
    })
  })

  it("run from a butler.ouro bundle, the server looks for credentials there", () => {
    const bundle = join(realpathSync(mkdtempSync(join(tmpdir(), "media-mcp-butler-"))), "butler.ouro")
    mkdirSync(join(bundle, "mcp"), { recursive: true })
    const script = join(bundle, "mcp", "media-mcp.mjs")
    copyFileSync(SOURCE, script)
    const env = { ...process.env }
    delete env.SANCTUARY_MEDIA_CREDENTIALS
    const call = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "media_queue", arguments: {} } })}\n`
    const out = execFileSync(process.execPath, [script], { input: call, env, encoding: "utf8" })
    const text = JSON.parse(JSON.parse(out.trim()).result.content[0].text)
    expect(text.error).toBe("credentials_unavailable")
    expect(text.message).toContain(join(bundle, "mcp", "media-credentials.json"))
  })
})
