The shelf-claim guard no longer puts "I haven't checked the library" in front of a reply that did check.

When an agent ran the books CLI through a shell variable that the same command sets, the guard didn't see the lookup. For example: `B=…/books; $B library find …`, `"$B"`, `${B}` or `export B=…`. So the guard added the hedge to a correct reply that a person reads.

Now the guard resolves each variable a command set earlier in itself before it looks for the books CLI.
- A variable the command doesn't set is still not counted.
- Neither is one set only after its use, an alias (the shell never uses one set in the same command), a variable that points at something other than the books CLI, or a run that only removed a copy.
- So a reply that never looked still gets the hedge.
