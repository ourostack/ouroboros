The blind-interview runner has optional hooks for products that aren't scored on the books household, so the component-kit product and the harness product can plug in without changing the runner again:

- A product kit can supply its own job (`job`), its own verdict on a run (`grade`) and its own fidelity notes (`fidelity`).
- A tool answer can end the user turn (`ends`), as a `finish` tool does, without an extra model call.
- The guest picks each product's arms from a map of builders.
- A guest's own grade comes back through the sandbox unchanged.

X works as before, and a regression test checks that.
