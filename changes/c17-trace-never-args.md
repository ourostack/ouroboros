The eval check `trace.never` now fails a run only when a command actually passes the pattern as an argument.

Before, it matched the pattern anywhere in any call's arguments. So a run that never used `--accept-check-failure` failed because it wrote the rule "never use `--accept-check-failure`" into a note or file.

Now it looks only at shell calls, and only at what a command passes:
- **An ordinary command** fails only on an argument word that is the pattern, or `pattern=value`. This is checked after the call's own variables are written out and backslashes and quotes are removed. Heredoc bodies are left out. A command that only prints or searches text (`echo`, `printf`, `grep`, `rg`) is left out too.
- **A command that runs text as code** is read whole, since any of its text may be a command. That means a shell (`sh -c`, `bash <<EOF`, `| sh`), `eval`, `source`, Python, Node, Perl or Ruby, named outside quotes and heredoc bodies. It fails on the pattern as a word anywhere in it.
- **A command that substitutes another into its words** (`$(…)`, backticks, `<(…)`) is read whole apart from heredoc bodies.
- Commands are split on `;`, `&`, `|` and new lines outside quotes. `export NAME=` counts as an assignment, and `echo`/`printf` still count in any call that uses `xargs`.

So a command that passes the flag still fails, whether bare, quoted, escaped, as `--flag=value`, from a variable, through `sh -c` or `eval`, fed to a shell, or from Python.

Two gaps remain:
- A script the agent writes to a file in one call and runs in a later call is not followed.
- Python or a shell script that only writes the rule as text still fails the check, and so does an unquoted `$(…)` around written text. That is the safe direction.
