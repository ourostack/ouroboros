// A child whose walker never finishes.
import { runChild } from "../child.mts";

await runChild(process.argv[2]!, {
  fixture: () => {
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  },
});
