/**
 * What the sandbox fakes or leaves out of a real Butler turn, beside what the bundle projection leaves out. Every
 * sandboxed run returns these with its projection gaps, so each report lists them.
 */
export const DECLARED_GAPS: readonly string[] = [
  "synthetic Sanctuary: the Unraid, service, install state, download-queue, media optimisation and media-catalog reads return fixed data; a container restart and a download-queue resume are not simulated",
  "no MCP server starts, so the media MCP tools (media_*) are not in the turn's tool list",
  "the agent container is on an internal network with no route off the host, so web_search and fetch_url fail",
  "house/house.json is not projected: the turn runs with the generic house config (no owner name, no public endpoints, no books container)",
  "no root host binding, so sanctuary_host_execute is not offered",
  "the owner's message goes straight to the Telegram sense's message handler, skipping the long poll's update parsing, its user and chat filter and the inbox",
  "the owner's prompt does not list skills/: a skill file reaches the model only when the agent reads it with a tool",
  "replies are read back as text: Telegram's HTML is decoded, a message's buttons are not part of the answer, and a send_file shows only as the tool call",
]
