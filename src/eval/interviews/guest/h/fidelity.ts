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
  "multi_agent (sub-agents) is off, through both the deprecated [features] multi_agent and [agents] enabled = false: its tools are a namespace, not functions, which the H wire can't carry",
  "the goal tools (get_goal, create_goal, update_goal) stay on: codex's goals feature is stable and on by default at this commit",
  "request_user_input is offered, as stock codex offers it, though its description says it works only in Plan mode, which the arm never uses",
  "web_search is disabled: it is a hosted tool the host's runtime can't run, and the sandbox has no route off the host",
  "plugins and apps are off, and with them tool suggestions: the sandbox has no route off the host",
  "bundled skills are off ([skills.bundled] enabled = false): they are about codex itself, not the household",
  "analytics, the otel exporters (exporter, trace_exporter and metrics_exporter) and check_for_update_on_startup are off:the sandbox has no route off the host; the model sees no difference",
  "the request's own settings (tool_choice, parallel_tool_calls, reasoning, include, store, prompt_cache_key and the like) are not passed on: the host's runtime sets the model's settings, as it does for the ouro arm",
  "codex's leading developer messages become one system message, joined with a blank line, and a message's text parts are joined with a newline, since the harness's messages carry one string each",
  "codex doesn't know the model's name, so it runs as for any unknown model: its generic base prompt, no apply_patch tool, and output of each tool call cut at 10,000 bytes",
  "the brand words in codex's base prompt are replaced before the call reaches the model",
  "the shell can still show the brand through the names of the variables codex sets (CODEX_HOME, CODEX_THREAD_ID, CODEX_SESSION_ID, CODEX_CI), none of which is in the prompt; codex adds no helper folder to PATH, since it refuses to create one under /tmp",
  "codex runs from a neutral home under /tmp (the agent container is read-only elsewhere), with the bundle linked at /tmp/agent/AgentBundles/sanctuary.agent",
  "codex is killed at 540 seconds, inside the host's 600-second guest deadline, and the turn reports that it exited 137; commands it started stop when the host removes the container at the guest's end",
  "built from source at the pinned commit for x86_64 gnu (on the x86_64 sandbox host, which runs every session), not codex's released musl build, without the release's version stamp",
]
