import { beforeEach, describe, expect, it } from "vitest"
import type OpenAI from "openai"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildToolCatalog, searchCatalog, type CatalogSource } from "../../repertoire/tool-catalog"
import { baseToolDefinitions, type ToolDefinition } from "../../repertoire/tools-base"
import { chatToolDefinitions } from "../../repertoire/tools-chat"
import { unraidToolDefinitions } from "../../repertoire/tools-unraid"
import { houseCareToolDefinitions } from "../../repertoire/tools-house-care"
import { bundleToolDefinitions } from "../../repertoire/tools-bundle"
import { mailToolDefinitions } from "../../repertoire/tools-mail"
import { shepherdToolDefinitions } from "../../repertoire/tools-shepherd"
import { appSessionsToolDefinitions } from "../../repertoire/tools-app-sessions"
import { githubToolDefinitions } from "../../repertoire/tools-github"
import { teamsToolDefinitions } from "../../repertoire/tools-teams"
import { adoSemanticToolDefinitions } from "../../repertoire/ado-semantic"
import { stewardPolicyToolDefinition } from "../../repertoire/tools-steward-policy"
import { mcpToolSchema } from "../../repertoire/mcp-tools"
import { emitNervesEvent } from "../../nerves/runtime"
// @ts-expect-error -- the Butler's media MCP server is plain JavaScript with no type declarations
import { TOOLS as MEDIA_TOOLS } from "../../../deploy/unraid/sanctuary.ouro/mcp/media-mcp.mjs"

/**
 * Proof that agents still find deferred doors: tasks phrased the way a model writes a `find_tools` query (what it
 * needs to do, in its own words, not the door's name), and the door that must come back in the first five `find_tools` results. The pool is every native door plus the Butler's media MCP
 * tools, a superset of any one agent's menu, so it is harder than a real turn. The trial search this replaced found 19 of
 * these 25 (measured in #1626), so the catalog's 25 is the bar to keep.
 */
const TABLE: ReadonlyArray<readonly [query: string, door: string]> = [
  ["restart the sonarr container", "unraid_restart_container"],
  ["check download queue progress", "media_queue"],
  ["is the array healthy, check the disks", "unraid_get_disks"],
  ["request a movie or series download", "media_request"],
  ["search the library for a show", "media_search"],
  ["fix a stuck download", "media_diagnose_and_fix"],
  ["search my email for the invoice", "mail_search"],
  ["send the drafted email", "mail_send"],
  ["start a coding agent on this repo", "coding_spawn"],
  ["book the flight offer", "flight_book"],
  ["weather forecast in Lisbon", "weather_lookup"],
  ["save the password for this login", "credential_store"],
  ["look at the photo they sent", "describe_image"],
  ["react to the message with a thumbs up", "react"],
  ["wait until the package arrives", "await_condition"],
  ["push the bundle to its remote", "bundle_push"],
  ["remember this about my friend", "save_friend_note"],
  ["file a bug in ouroboros", "file_ouroboros_bug"],
  ["change my settings", "update_config"],
  ["make a virtual card to pay", "stripe_create_card"],
  ["message the coding session in the Copilot app", "send_session_message"],
  ["what are the terminals' coding agents doing", "shepherd_overview"],
  ["query Azure DevOps work items", "ado_work_items"],
  ["revive the stuck telegram sense", "revive_sense"],
  ["show the household steward policy", "steward_policy_manage"],
]

function pool(): CatalogSource[] {
  const native: ToolDefinition[] = [
    ...baseToolDefinitions, ...chatToolDefinitions, ...unraidToolDefinitions, ...houseCareToolDefinitions, ...bundleToolDefinitions,
    ...mailToolDefinitions, ...shepherdToolDefinitions, ...appSessionsToolDefinitions, ...githubToolDefinitions, ...teamsToolDefinitions,
    ...adoSemanticToolDefinitions, stewardPolicyToolDefinition,
  ]
  const media = (MEDIA_TOOLS as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>)
    .map((entry) => ({ tool: mcpToolSchema({ server: "media" }, entry), mcpServer: "media" }))
  const seen = new Set<string>()
  return [...native, ...media].filter((source) => !seen.has(source.tool.function.name) && seen.add(source.tool.function.name))
}

const groups = (JSON.parse(readFileSync(path.join(__dirname, "../../../ax/census.config.json"), "utf8")) as { groups: Array<{ id: string; when: string }> }).groups

describe("finding deferred doors", () => {
  beforeEach(() => {
    emitNervesEvent({ component: "repertoire", event: "repertoire.test_run", message: "tool catalog finding test", meta: { test: true } })
  })

  const sources = pool()
  const catalog = buildToolCatalog(sources, groups)
  const candidates: OpenAI.ChatCompletionFunctionTool[] = sources.map((source) => source.tool)

  it.each(TABLE)("%s → %s", (query, door) => {
    expect(searchCatalog(catalog, candidates, query).slice(0, 5)).toContain(door)
  })
})
