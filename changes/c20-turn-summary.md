Every turn now logs one counts-only event, `engine.turn_summary`, when it ends, including a turn that ends by throwing. The event records:

- the channel, how the turn ended and, for a turn that failed, the class of error (such as `auth-failure` or `rate-limit`);
- the provider and model the turn ended on, and how many times it fell back to another provider;
- the provider calls the main loop made and any step-budget stop;
- the tool calls by name, the tool errors and any calls to a name the turn never offered;
- how `find_tools` did: calls, calls that loaded a tool, and loaded tools called afterwards;
- the tools offered up front and those held back;
- the input, output and reasoning tokens summed over the main loop's provider calls.

It holds only numbers and values from fixed lists, never message text, tool arguments or results. An MCP tool is named only by its server, and a made-up tool name is counted as `unknown`. A failure to log the event never affects the turn. Side calls such as the kept-notes judge, and attempts that failed and were retried, aren't in the step or token counts.
