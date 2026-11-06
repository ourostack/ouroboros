#!/usr/bin/env node
"use strict";

const { execFileSync } = require("child_process");
const semver = require("semver");

function prereleaseChannel(version) {
  const prerelease = semver.prerelease(version);
  return prerelease && prerelease.length > 0 ? String(prerelease[0]) : "latest";
}

function planPublishTag({ localVersion, latestVersion }) {
  if (!semver.valid(localVersion)) {
    return { action: "error", reason: `local version ${localVersion} is not valid semver` };
  }

  const channel = prereleaseChannel(localVersion);
  if (channel === "latest") {
    return { action: "publish", tag: "latest", reason: "stable publish owns latest" };
  }

  const normalizedLatest = typeof latestVersion === "string" ? latestVersion.trim() : "";
  if (!normalizedLatest) {
    return {
      action: "publish",
      tag: "latest",
      reason: "latest dist-tag is missing; prerelease is the current supported default channel",
    };
  }

  if (!semver.valid(normalizedLatest)) {
    return { action: "error", reason: `latest dist-tag points at invalid version ${normalizedLatest}` };
  }

  if (!semver.prerelease(normalizedLatest)) {
    return {
      action: "publish",
      tag: channel,
      reason: `latest dist-tag points at stable ${normalizedLatest}; publishing prerelease on ${channel}`,
    };
  }

  return {
    action: "publish",
    tag: "latest",
    reason: `latest dist-tag points at prerelease ${normalizedLatest}; keeping prerelease as the supported default channel`,
  };
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

function resolvePublishTag(packageName, localVersion, deps = {}) {
  const latestVersion = deps.latestVersion ?? npmViewLatestVersion(packageName, deps);
  const plan = planPublishTag({ localVersion, latestVersion });
  if (plan.action === "error") {
    throw new Error(`${packageName}: ${plan.reason}`);
  }

  return { ...plan, latestVersion };
}

function printUsageAndExit() {
  console.error("usage:");
  console.error("  node scripts/npm-dist-tag-policy.cjs publish-tag <package> <version>");
  process.exit(2);
}

if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "publish-tag") {
      const [packageName, localVersion] = args;
      if (!packageName || !localVersion) printUsageAndExit();
      const result = resolvePublishTag(packageName, localVersion);
      console.error(`${packageName}: ${result.reason}`);
      console.log(result.tag);
    } else {
      printUsageAndExit();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

module.exports = {
  planPublishTag,
  resolvePublishTag,
};
