/**
 * How each H arm departs from the harness as shipped, with the reason, for the report's `fidelity` (keyed
 * `H:<arm>`). Every setting an arm turns off is here: the codex arm's test checks each `false` or `disabled` in its
 * config against these notes by key name.
 */

/** Departures every H arm shares, and where the `ouro` arm still differs from the others. */
export const H_OURO_FIDELITY: readonly string[] = [
  "no provider retries, as in every arm: each error from the host's runtime is marked not retryable, so a retry is never a second metered call",
  "offers web_search and fetch_url, which fail in the sandbox (no route off the host); the other arms don't offer web search at all, since their hosted search tools can't reach the host's runtime",
  "the bundle sits at its production path, so the working folder the model sees differs from the other arms' neutral path",
  "skills aren't listed in the prompt: a skill reaches the model only when the agent reads its file, while the other arms list each skill's name and when-line",
]

export const H_CODEX_FIDELITY: readonly string[] = [
  "request_max_retries, stream_max_retries and unbounded_connection_retries are off: a retry would be a second metered call, and the H wire answers every failure with a 400 codex never retries",
  "view_image is off: its output is an image, which the H wire can't carry",
  "multi_agent (sub-agents) is off: its tools are a namespace, not functions, which the H wire can't carry",
  "web_search is disabled: it is a hosted tool the host's runtime can't run, and the sandbox has no route off the host",
  "plugins and apps are off, and with them tool suggestions: the sandbox has no route off the host",
  "bundled skills are off ([skills.bundled] enabled = false): they are about codex itself, not the household",
  "analytics, the otel exporters and check_for_update_on_startup are off: the sandbox has no route off the host; the model sees no difference",
  "codex doesn't know the model's name, so it runs as for any unknown model: its generic base prompt, no apply_patch tool, and output of each tool call cut at 10,000 bytes",
  "the brand words in codex's base prompt are replaced before the call reaches the model",
  "the shell can still show the brand: the CODEX_HOME variable's name, and codex's own helper folder at the front of PATH; neither is in the prompt",
  "codex runs from a neutral home under /tmp (the agent container is read-only elsewhere), with the bundle linked at /tmp/agent/AgentBundles/sanctuary.agent",
  "the whole conversation is killed at 540 seconds, inside the host's 600-second guest deadline",
  "built from source at the pinned commit for x86_64 gnu, not codex's released musl build, without the release's version stamp",
]
