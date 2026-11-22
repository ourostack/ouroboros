import { test } from "node:test";
import { equal, match, throws } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pullRequestBase } from "./base.mts";

const here = dirname(fileURLToPath(import.meta.url));

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim();
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", message);
  return git(cwd, "rev-parse", "HEAD");
}

// A pull request's merge ref, built on main as it was, then main moving on before the census reads it, as on
// ourostack/ouroboros#1590: the merge ref was built on #1585 and #1582 merged in the 85 seconds before the census
// fetched main's tip.
function racedPullRequest(): { dir: string; clone: string; builtOn: string; tip: string } {
  const dir = mkdtempSync(join(tmpdir(), "ax-census-base-"));
  const origin = join(dir, "origin");
  execFileSync("mkdir", [origin]);
  git(origin, "init", "-q");
  const builtOn = commit(origin, "baseline.json", "[\"a\",\"b\"]\n", "main with a and b on the baseline");
  git(origin, "checkout", "-qb", "update");
  commit(origin, "other.txt", "update\n", "an update that leaves the baseline alone");
  git(origin, "checkout", "-q", "main");
  git(origin, "checkout", "-q", "--detach");
  git(origin, "merge", "-q", "--no-ff", "-m", "Merge update into main", "update");
  git(origin, "update-ref", "refs/pull/1/merge", "HEAD");
  git(origin, "checkout", "-q", "main");
  const tip = commit(origin, "baseline.json", "[\"a\"]\n", "main shrinks the baseline");
  const clone = join(dir, "clone");
  git(dir, "clone", "-q", "--depth=1", `file://${origin}`, clone);
  git(clone, "fetch", "-q", "--depth=1", "origin", "+refs/pull/1/merge:refs/remotes/pull/1/merge");
  git(clone, "checkout", "-q", "refs/remotes/pull/1/merge");
  return { dir, clone, builtOn, tip };
}

test("a pull request's census base is the commit its merge ref was built on, not the base branch's later tip", () => {
  const { dir, clone, builtOn, tip } = racedPullRequest();
  try {
    equal(pullRequestBase(clone), builtOn);
    equal(builtOn === tip, false);
    const cli = spawnSync(process.execPath, [join(here, "base.mts")], { cwd: clone, encoding: "utf8" });
    equal(cli.status, 0, cli.stderr);
    equal(cli.stdout, `${builtOn}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a checkout that isn't a pull request's merge ref has no census base", () => {
  const { dir, clone } = racedPullRequest();
  try {
    git(clone, "checkout", "-q", "origin/main");
    throws(() => pullRequestBase(clone), /ax-census: HEAD has 1 parents, so it isn.t a pull request.s merge ref/);
    const cli = spawnSync(process.execPath, [join(here, "base.mts")], { cwd: clone, encoding: "utf8" });
    equal(cli.status, 1);
    match(cli.stderr, /isn't a pull request's merge ref/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
