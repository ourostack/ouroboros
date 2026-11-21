// A child whose walker throws.
import { runChild } from "../child.mts";

await runChild(process.argv[2]!, {
  fixture: async () => {
    throw new Error("the fixture walker exploded");
  },
});
