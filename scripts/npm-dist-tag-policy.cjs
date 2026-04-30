#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const semver = require("semver");

function resolvePublishTag(version) {
  const prerelease = semver.prerelease(version);
  return prerelease && prerelease.length > 0 ? String(prerelease[0]) : "latest";
}

function planLatestDistTagRepair({ publishTag, localVersion, latestVersion }) {
  if (!semver.valid(localVersion)) {
    return { action: "error", reason: `local version ${localVersion} is not valid semver` };
  }

  if (publishTag === "latest") {
    return { action: "skip", reason: "stable publish owns latest" };
  }

  const normalizedLatest = typeof latestVersion === "string" ? latestVersion.trim() : "";
  if (!normalizedLatest) {
    return { action: "repair", reason: "latest dist-tag is missing" };
  }

  if (!semver.valid(normalizedLatest)) {
    return { action: "error", reason: `latest dist-tag points at invalid version ${normalizedLatest}` };
  }

  if (!semver.prerelease(normalizedLatest)) {
    return { action: "skip", reason: `latest dist-tag points at stable ${normalizedLatest}` };
  }

  if (semver.eq(normalizedLatest, localVersion)) {
    return { action: "skip", reason: `latest dist-tag already points at ${localVersion}` };
  }

  return { action: "repair", reason: `latest dist-tag points at stale prerelease ${normalizedLatest}` };
}

function npmViewLatestVersion(packageName, deps = {}) {
  const execFileSyncImpl = deps.execFileSyncImpl ?? execFileSync;
  let rawDistTags;
  try {
    rawDistTags = execFileSyncImpl("npm", ["view", packageName, "dist-tags", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${packageName}: could not read npm dist-tags: ${reason}`);
  }

  let distTags;
  try {
    distTags = JSON.parse(rawDistTags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${packageName}: npm dist-tags response was not JSON: ${reason}`);
  }

  const latestVersion = distTags && typeof distTags.latest === "string" ? distTags.latest.trim() : "";
  return latestVersion;
}

function addLatestDistTag(packageName, localVersion, deps = {}) {
  const execFileSyncImpl = deps.execFileSyncImpl ?? execFileSync;
  execFileSyncImpl("npm", ["dist-tag", "add", `${packageName}@${localVersion}`, "latest"], {
    stdio: "inherit",
  });
}

function repairLatestDistTagIfNeeded(packageName, localVersion, publishTag, deps = {}) {
  const latestVersion = deps.latestVersion ?? npmViewLatestVersion(packageName, deps);
  const plan = planLatestDistTagRepair({ publishTag, localVersion, latestVersion });
  if (plan.action === "error") {
    throw new Error(`${packageName}: ${plan.reason}`);
  }

  if (plan.action === "repair") {
    addLatestDistTag(packageName, localVersion, deps);
    return { ...plan, latestVersion, repairedTo: localVersion };
  }

  return { ...plan, latestVersion };
}

function printUsageAndExit() {
  console.error("usage:");
  console.error("  node scripts/npm-dist-tag-policy.cjs publish-tag <version>");
  console.error("  node scripts/npm-dist-tag-policy.cjs repair-latest-if-prerelease <package> <version> <publish-tag>");
  process.exit(2);
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "publish-tag") {
      const [version] = args;
      if (!version) printUsageAndExit();
      console.log(resolvePublishTag(version));
    } else if (command === "repair-latest-if-prerelease") {
      const [packageName, localVersion, publishTag] = args;
      if (!packageName || !localVersion || !publishTag) printUsageAndExit();
      const result = repairLatestDistTagIfNeeded(packageName, localVersion, publishTag);
      console.log(`${packageName}: ${result.reason}`);
    } else {
      printUsageAndExit();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  planLatestDistTagRepair,
  repairLatestDistTagIfNeeded,
  resolvePublishTag,
};
