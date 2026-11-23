import { expect, it } from "vitest"
import { DECLARED_GAPS } from "../../../eval/sandbox/declared-gaps"

// Each way a sandboxed turn differs from a real Butler turn that no projection gap already says. A report lists
// these, so a run is never read as a measure of the real turn where it isn't one.
it.each([
  ["the synthetic Sanctuary reads, install state and media optimisation among them", /synthetic Sanctuary.*install state.*media optimisation/],
  ["no MCP server, so no media tools", /no MCP server.*media_\*/],
  ["no route off the host, so no web tools", /internal network.*web_search.*fetch_url/],
  ["the generic house config", /house\/house\.json/],
  ["no root host binding", /sanctuary_host_execute/],
  ["the Telegram long poll skipped", /long poll/],
  ["no skills section in the prompt", /skills/],
  ["replies read back as text", /read back as text/],
])("declares %s", (_what, pattern) => {
  expect(DECLARED_GAPS.some((gap) => pattern.test(gap))).toBe(true)
})
