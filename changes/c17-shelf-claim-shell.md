The shelf-claim guard no longer puts "I haven't checked the library" in front of a reply that did check.

When an agent ran the books CLI through a shell variable or alias that the same command sets, the guard didn't see the lookup. For example: `B=…/books; $B library find …`, `"$B"`, `${B}`, `export B=…`, or `alias bk=./books; bk library find …`. So the guard added the hedge to a correct reply that a person reads.

Now the guard resolves the names a command sets for itself before it looks for the books CLI.
- A variable the command doesn't set is still not counted.
- Neither is a variable or alias that points at something other than the books CLI, or a run that only removed a copy.
- So a reply that never looked still gets the hedge.
