#!/usr/bin/env node

const { spawnSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const REGISTRY = "https://registry.npmjs.org"
const EXPECTED_REPOSITORY = "ourostack/ouroboros"
const EXPECTED_REPOSITORY_URL = "git+https://github.com/ourostack/ouroboros.git"
const EXPECTED_WORKFLOW = "coverage.yml"

const TRUSTED_PUBLISHER_PACKAGES = [
  {
    packageName: "@ouro.bot/cli",
    packageJsonPath: "package.json",
  },
  {
    packageName: "ouro.bot",
    packageJsonPath: path.join("packages", "ouro.bot", "package.json"),
  },
]

function readJson(filePath, readFileSyncImpl = fs.readFileSync) {
  return JSON.parse(readFileSyncImpl(filePath, "utf8"))
}

function validateTrustedPublisherLocalContract(options = {}) {
  const repoRoot = options.repoRoot ?? path.resolve(__dirname, "..")
  const readFileSyncImpl = options.readFileSyncImpl ?? fs.readFileSync
  const errors = []
  const messages = []

  for (const packageConfig of TRUSTED_PUBLISHER_PACKAGES) {
    const packageJson = readJson(path.join(repoRoot, packageConfig.packageJsonPath), readFileSyncImpl)
    if (packageJson.repository?.url !== EXPECTED_REPOSITORY_URL) {
      errors.push(
        `${packageConfig.packageName} repository.url must be ${EXPECTED_REPOSITORY_URL} for npm trusted publishing; got ${packageJson.repository?.url ?? "missing"}`,
      )
    }
  }

  const workflow = readFileSyncImpl(
    path.join(repoRoot, ".github", "workflows", EXPECTED_WORKFLOW),
    "utf8",
  )
  const requiredWorkflowFragments = [
    "publish:",
    "id-token: write",
    "contents: read",
    "node-version: 24",
    "registry-url: https://registry.npmjs.org",
    "package-manager-cache: false",
    "Verify npm trusted-publishing toolchain",
    'fallback = "11.6.4"',
    'npm publish --access public --tag "$TAG"',
    'npm publish --access public --tag "${{ steps.wrapper-publish-tag.outputs.tag }}"',
    "Verify selected npm dist-tags",
    "selected npm dist-tags verified",
  ]

  for (const fragment of requiredWorkflowFragments) {
    if (!workflow.includes(fragment)) {
      errors.push(`coverage publish workflow must include ${fragment}`)
    }
  }

  if (!workflow.includes("trusted publishing requires npm >=11.5.1 on Node >=22.14")) {
    errors.push("coverage publish workflow must document the npm trusted publishing runtime floor")
  }

  if (workflow.includes("npm install -g npm@latest")) {
    errors.push("coverage publish workflow must not self-mutate npm with npm@latest; use the bundled npm when it satisfies the floor and a pinned fallback otherwise")
  }

  if (workflow.includes("Verify supported npm dist-tags") || workflow.includes("supported npm dist-tags verified")) {
    errors.push("coverage publish workflow must verify selected npm dist-tags, not imply every legacy channel is supported")
  }

  if (errors.length === 0) {
    messages.push(
      `npm trusted-publisher local contract: ${EXPECTED_REPOSITORY} ${EXPECTED_WORKFLOW} for ${TRUSTED_PUBLISHER_PACKAGES.map((pkg) => pkg.packageName).join(", ")}`,
    )
  }

  return {
    ok: errors.length === 0,
    expectedRepository: EXPECTED_REPOSITORY,
    expectedWorkflow: EXPECTED_WORKFLOW,
    packages: TRUSTED_PUBLISHER_PACKAGES.map((pkg) => pkg.packageName),
    messages,
    errors,
  }
}

function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function trustListCommand(packageName) {
  return [
    "npx",
    "--yes",
    "npm@latest",
    "trust",
    "list",
    packageName,
    "--json",
    "--registry",
    REGISTRY,
  ]
}

function trustInteractiveAuthCommand(packageName) {
  return [
    "npx",
    "--yes",
    "npm@latest",
    "trust",
    "list",
    packageName,
    "--registry",
    REGISTRY,
  ]
}

function npmLoginCommand() {
  return [
    "npx",
    "--yes",
    "npm@latest",
    "login",
    "--registry",
    REGISTRY,
  ]
}

function trustCreateCommand(packageName) {
  return [
    "npx",
    "--yes",
    "npm@latest",
    "trust",
    "github",
    packageName,
    "--repo",
    EXPECTED_REPOSITORY,
    "--file",
    EXPECTED_WORKFLOW,
    "--allow-publish",
    "--yes",
    "--registry",
    REGISTRY,
  ]
}

function trustRevokeCommand(packageName, trustId) {
  return [
    "npx",
    "--yes",
    "npm@latest",
    "trust",
    "revoke",
    packageName,
    "--id",
    trustId,
    "--registry",
    REGISTRY,
  ]
}

function formatCommand(args) {
  return args.map(shellQuote).join(" ")
}

function buildRepairPlan() {
  const lines = [
    "npm trusted publisher repair plan",
    "",
    `Expected GitHub Actions publisher: ${EXPECTED_REPOSITORY} ${EXPECTED_WORKFLOW}`,
    "",
    "For each package:",
  ]

  for (const packageConfig of TRUSTED_PUBLISHER_PACKAGES) {
    const packageName = packageConfig.packageName
    lines.push(
      "",
      `# ${packageName}`,
      formatCommand(trustListCommand(packageName)),
      "# If the listed trusted publisher is not the expected repository/workflow, revoke the listed id:",
      formatCommand(trustRevokeCommand(packageName, "<trust-id>")),
      "# Then create the expected trusted publisher:",
      formatCommand(trustCreateCommand(packageName)),
    )
  }

  lines.push(
    "",
    "These commands require npm package write access and npm 2FA/proof-of-presence.",
    "They are intentionally not run by CI; CI uses OIDC only after this registry-side trust relationship exists.",
  )

  return lines.join("\n")
}

function collectTrustIds(value, ids = new Set()) {
  if (!value || typeof value !== "object") {
    return ids
  }

  for (const [key, child] of Object.entries(value)) {
    if ((key === "id" || key === "trustId" || key === "_id") && typeof child === "string") {
      ids.add(child)
      continue
    }
    if (child && typeof child === "object") {
      collectTrustIds(child, ids)
    }
  }

  return ids
}

function trustOutputMatchesExpected(value) {
  const serialized = JSON.stringify(value)
  return serialized.includes(EXPECTED_REPOSITORY) &&
    serialized.includes(EXPECTED_WORKFLOW) &&
    /allow(?:ed)?[-_ ]?publish|npm publish|publish/i.test(serialized)
}

function parseTrustListOutput(output) {
  try {
    return JSON.parse(output)
  } catch (error) {
    throw new Error(`npm trust list returned non-JSON output: ${output.trim() || error.message}`)
  }
}

function runCommand(args) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  }
}

function isAuthRequired(output) {
  return /EOTP|one-time password|auth\/cli|E401|ENEEDAUTH|must be logged in|not logged in/i.test(output)
}

function isLoginRequired(output) {
  return /E401|ENEEDAUTH|must be logged in|not logged in/i.test(output)
}

function formatAuthRequired(packageName, output) {
  return [
    `npm trust repair for ${packageName} requires human npm login/2FA/proof-of-presence.`,
    "Run this from an interactive terminal so npm can hold the login and browser proof flows open.",
    "On the npm page, enable the short 2FA skip window when offered; the repair may need multiple trust mutations.",
    "Then rerun:",
    `  npm run release:trust:repair`,
    "",
    output.trim(),
  ].filter(Boolean).join("\n")
}

function canUseInteractiveAuth(stdin = process.stdin, stdout = process.stdout) {
  return Boolean(stdin?.isTTY && stdout?.isTTY)
}

function runInteractiveAuthProbe(packageName, spawnSyncImpl = spawnSync) {
  console.log(`npm trust repair for ${packageName}: starting interactive npm auth proof`)
  const args = trustInteractiveAuthCommand(packageName)
  const result = spawnSyncImpl(args[0], args.slice(1), {
    stdio: "inherit",
  })
  return result.status ?? 1
}

function runInteractiveLogin(spawnSyncImpl = spawnSync) {
  console.log("npm trust repair: starting interactive npm login")
  const args = npmLoginCommand()
  const result = spawnSyncImpl(args[0], args.slice(1), {
    stdio: "inherit",
  })
  return result.status ?? 1
}

function runRepair(options = {}) {
  const runCommandImpl = options.runCommandImpl ?? runCommand
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync
  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const maxInteractiveAuthAttempts = options.maxInteractiveAuthAttempts ?? 3

  function runTrustedCommand(packageName, args) {
    let result = runCommandImpl(args)
    let authAttempts = 0

    while (
      result.status !== 0 &&
      isAuthRequired(result.output) &&
      canUseInteractiveAuth(stdin, stdout) &&
      authAttempts < maxInteractiveAuthAttempts
    ) {
      authAttempts += 1
      const needsLogin = isLoginRequired(result.output)
      const authStatus = needsLogin
        ? runInteractiveLogin(spawnSyncImpl)
        : runInteractiveAuthProbe(packageName, spawnSyncImpl)
      if (authStatus !== 0) {
        const output = needsLogin
          ? "npm error code E401\ninteractive npm login failed"
          : `npm error code EOTP\ninteractive npm auth proof failed for ${packageName}`
        result = {
          status: authStatus,
          stdout: "",
          stderr: output,
          output,
        }
        continue
      }

      result = runCommandImpl(args)
    }

    return result
  }

  for (const packageConfig of TRUSTED_PUBLISHER_PACKAGES) {
    const packageName = packageConfig.packageName
    console.log(`checking trusted publisher for ${packageName}`)
    const listResult = runTrustedCommand(packageName, trustListCommand(packageName))

    if (listResult.status !== 0) {
      if (isAuthRequired(listResult.output)) {
        throw new Error(formatAuthRequired(packageName, listResult.output))
      }
      throw new Error(`npm trust list failed for ${packageName}:\n${listResult.output.trim()}`)
    }

    const trustList = parseTrustListOutput(listResult.stdout)
    if (trustOutputMatchesExpected(trustList)) {
      console.log(`${packageName}: trusted publisher already matches ${EXPECTED_REPOSITORY} ${EXPECTED_WORKFLOW}`)
      continue
    }

    const trustIds = Array.from(collectTrustIds(trustList))
    for (const trustId of trustIds) {
      console.log(`${packageName}: revoking mismatched trusted publisher ${trustId}`)
      const revokeResult = runTrustedCommand(packageName, trustRevokeCommand(packageName, trustId))
      if (revokeResult.status !== 0) {
        if (isAuthRequired(revokeResult.output)) {
          throw new Error(formatAuthRequired(packageName, revokeResult.output))
        }
        throw new Error(`npm trust revoke failed for ${packageName} (${trustId}):\n${revokeResult.output.trim()}`)
      }
    }

    console.log(`${packageName}: creating trusted publisher ${EXPECTED_REPOSITORY} ${EXPECTED_WORKFLOW}`)
    const createResult = runTrustedCommand(packageName, trustCreateCommand(packageName))
    if (createResult.status !== 0) {
      if (isAuthRequired(createResult.output)) {
        throw new Error(formatAuthRequired(packageName, createResult.output))
      }
      throw new Error(`npm trust github failed for ${packageName}:\n${createResult.output.trim()}`)
    }
  }
}

function runCli(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "check"

  if (command === "check") {
    const result = validateTrustedPublisherLocalContract()
    for (const message of result.messages) {
      console.log(message)
    }
    if (!result.ok) {
      console.error("npm trusted-publisher local contract: FAIL")
      for (const error of result.errors) {
        console.error(error)
      }
      return 1
    }
    return 0
  }

  if (command === "repair-plan") {
    console.log(buildRepairPlan())
    return 0
  }

  if (command === "repair") {
    runRepair()
    console.log("npm trusted-publisher registry repair: pass")
    return 0
  }

  console.error(`unknown command: ${command}`)
  console.error("usage: node scripts/npm-trusted-publishers.cjs [check|repair-plan|repair]")
  return 1
}

if (require.main === module) {
  try {
    process.exitCode = runCli()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

module.exports = {
  EXPECTED_REPOSITORY,
  EXPECTED_REPOSITORY_URL,
  EXPECTED_WORKFLOW,
  REGISTRY,
  TRUSTED_PUBLISHER_PACKAGES,
  buildRepairPlan,
  collectTrustIds,
  formatCommand,
  isAuthRequired,
  isLoginRequired,
  npmLoginCommand,
  parseTrustListOutput,
  runRepair,
  trustCreateCommand,
  trustInteractiveAuthCommand,
  trustListCommand,
  trustOutputMatchesExpected,
  validateTrustedPublisherLocalContract,
}
