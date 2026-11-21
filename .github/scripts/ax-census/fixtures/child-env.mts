// A child whose walker reports the environment it runs in, as census errors, so the test can read them.
import { runChild } from "../child.mts";

await runChild(process.argv[2]!, {
  fixture: async () => ({
    doors: [],
    errors: [
      `HOME=${process.env.HOME}`,
      `TMPDIR=${process.env.TMPDIR}`,
      `CREDENTIALS=${Object.keys(process.env).filter((k) => /TOKEN|KEY|SECRET|PASSWORD/.test(k)).join(",")}`,
      `NAMES=${Object.keys(process.env).sort().join(",")}`,
    ],
  }),
});
