// The commit a pull request's census compares its baseline with: the base commit its merge ref was built on, which is
// the merge commit's first parent. The base branch's tip can be newer than that when the base moves after GitHub
// builds the merge ref, and an untouched baseline would then read as grown (ourostack/ouroboros#1590). The checkout is
// shallow, so the parent comes from the merge commit's own text rather than from history.
// Usage, from the checked-out merge ref: node base.mts  (prints the commit, or fails if HEAD isn't a merge commit)
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function pullRequestBase(cwd: string): string {
  const head = execFileSync("git", ["cat-file", "commit", "HEAD"], { cwd, encoding: "utf8" });
  const parents = [...head.split("\n\n")[0].matchAll(/^parent ([0-9a-f]+)$/gm)].map((m) => m[1]);
  if (parents.length !== 2) {
    throw new Error(`ax-census: HEAD has ${parents.length} parents, so it isn't a pull request's merge ref`);
  }
  return parents[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${pullRequestBase(process.cwd())}\n`);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}
