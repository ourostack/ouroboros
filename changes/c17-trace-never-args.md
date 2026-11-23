The eval check `trace.never` now fails a run only when a command actually passes the pattern as an argument.

Before, it matched the pattern anywhere in any call's arguments. So a run that never used `--accept-check-failure` failed because it wrote the rule "never use `--accept-check-failure`" into a note or file.

Now it looks only at shell calls, and in those only at:
- the words passed as arguments (quotes removed, heredoc bodies left out);
- the list items of an inline Python script.

A command that passes the flag still fails, whether it is written bare, quoted, as `--flag=value`, through a variable, or from `python3 -c`.
