#!/usr/bin/env node
"use strict";

// Publishes the package in the current directory, or proves the registry already holds
// the same bytes. npm forbids republishing a version, so "version already exists" is not
// enough: a different artifact under an old version is a real conflict.

const crypto = require("crypto");
const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

function runNpm(args, cwd) {
  const result = spawnSync("npm", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function lookupPublishedVersion(spec, npm = runNpm) {
  const result = npm(["view", spec, "version", "--json"], process.cwd());
  if (result.status === 0) {
    const output = result.stdout.trim();
    return output ? JSON.parse(output) : null;
  }
  // Only npm's own not-found answer means absence; any other failure is unknown, not absent.
  if (/\bE404\b/.test(`${result.stderr}${result.stdout}`)) return null;
  throw new Error(`could not read ${spec} from npm: ${result.stderr.trim() || `exit ${result.status}`}`);
}

function packLocal(cwd, destination, npm) {
  const result = npm(["pack", "--ignore-scripts", "--json", "--pack-destination", destination], cwd);
  if (result.status !== 0) throw new Error(`npm pack failed: ${result.stderr.trim()}`);
  const [{ filename }] = JSON.parse(result.stdout);
  return path.join(destination, filename);
}

function fetchPublished(spec, destination, npm) {
  const result = npm(["pack", spec, "--json", "--pack-destination", destination], process.cwd());
  if (result.status !== 0) throw new Error(`could not download ${spec} from npm: ${result.stderr.trim()}`);
  const [{ filename }] = JSON.parse(result.stdout);
  return path.join(destination, filename);
}

function digestTree(root) {
  const digests = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(root, absolute).split(path.sep).join("/");
        digests.set(relative, crypto.createHash("sha512").update(fs.readFileSync(absolute)).digest("base64"));
      }
    }
  };
  visit(root);
  return digests;
}

function packageDigests(tarballPath) {
  const extracted = fs.mkdtempSync(path.join(os.tmpdir(), "npm-tarball-"));
  try {
    execFileSync("tar", ["-xzf", tarballPath, "-C", extracted]);
    return digestTree(path.join(extracted, "package"));
  } finally {
    fs.rmSync(extracted, { recursive: true, force: true });
  }
}

// Compares every file's bytes, not the tarball's bytes: gzip and tar metadata can differ
// between packers while the package contents are identical.
function comparePackedTarballs(localTarball, publishedTarball) {
  const local = packageDigests(localTarball);
  const published = packageDigests(publishedTarball);
  const paths = [...new Set([...local.keys(), ...published.keys()])].sort();
  const differences = [];
  for (const file of paths) {
    if (!published.has(file)) differences.push(`only in local build: ${file}`);
    else if (!local.has(file)) differences.push(`only on npm: ${file}`);
    else if (local.get(file) !== published.get(file)) differences.push(`content differs: ${file}`);
  }
  return differences;
}

function readPackageIdentity(cwd) {
  const manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
  return { name: manifest.name, version: manifest.version };
}

function publishPackageIdempotently({ cwd, tag }, npm = runNpm) {
  const { name, version } = readPackageIdentity(cwd);
  const spec = `${name}@${version}`;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "npm-publish-"));
  try {
    const local = packLocal(cwd, workspace, npm);
    if (lookupPublishedVersion(spec, npm) === null) {
      const published = npm(["publish", "--access", "public", "--tag", tag], cwd);
      if (published.status === 0) return { outcome: "published", spec };
      if (lookupPublishedVersion(spec, npm) === null) {
        throw new Error(`npm publish ${spec} failed: ${published.stderr.trim()}`);
      }
      console.error(`npm publish ${spec} failed, but the registry now holds ${spec}; verifying its contents`);
    }

    const differences = comparePackedTarballs(local, fetchPublished(spec, workspace, npm));
    if (differences.length > 0) {
      throw new Error(
        `${spec} is already on npm with different contents: ${differences.join("; ")}. ` +
          "Bump the version before publishing this change.",
      );
    }
    return { outcome: "already-published", spec };
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [command, tag] = process.argv.slice(2);
  if (command !== "publish" || !tag) {
    console.error("usage: node scripts/npm-publish-idempotency.cjs publish <dist-tag>");
    process.exit(2);
  }
  try {
    const result = publishPackageIdempotently({ cwd: process.cwd(), tag });
    console.log(`${result.spec}: ${result.outcome}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  comparePackedTarballs,
  lookupPublishedVersion,
  publishPackageIdempotently,
};
