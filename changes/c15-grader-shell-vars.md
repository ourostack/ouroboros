The eval's read-before-send check now follows a shell call's own variables, its folder and its wildcards. A run that wrote `B=/…/books; F=/…/copy.epub; $B check "$F" && $B send "$F"`, or checked every download with `for f in $W/…-get*/*.epub; do $B check "$f"; done`, had read the book before sending it, but the check found no send and failed the run.

- Variables are written out only within the shell call that sets them. A loop variable is written out once for each of its words, so a loop credits every file it checked. In a call that runs an inline Python script, the files the script opens count, and so do those of any command around it that reads on its own, such as a `books check`; a file that is only copied or listed does not.
- Every file a command names, written out or as a wildcard, is resolved against the call's folder: the shell tool's `cwd`, then each plain `cd`. It counts only if it covers the created file's whole path, so a check of a same-named copy in another folder no longer counts.
- A wildcard read counts only if no `books get`, `books series`, `curl` or `wget` ran between it and the send.
- A send that nothing read first still fails.

Re-grading the stored book-eval reports read-only changes five runs from fail to pass (three in this step's Opus replay, two in round B) and no pass to a fail. One more run's read-before-send check now passes, but that run still fails on another check.
