#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

function validDateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function validateIntentionalDebt(document, now = new Date()) {
  const errors = []
  if (!document || typeof document !== "object" || document.schemaVersion !== 1 || !Array.isArray(document.items)) {
    return {
      ok: false,
      errors: ["intentional debt document must have schemaVersion 1 and an items array"],
      message: "intentional debt gate: fail",
    }
  }

  const currentDate = now.toISOString().slice(0, 10)
  const seenIds = new Set()
  let openCount = 0
  document.items.forEach((item, index) => {
    const label = typeof item?.id === "string" && item.id ? item.id : `item ${index + 1}`
    if (!item || typeof item !== "object") {
      errors.push(`${label}: entry must be an object`)
      return
    }
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      errors.push(`${label}: id is required`)
    } else if (seenIds.has(item.id)) {
      errors.push(`${label}: id must be unique`)
    } else {
      seenIds.add(item.id)
    }
    if (item.status !== "open" && item.status !== "resolved") {
      errors.push(`${label}: status must be open or resolved`)
    }
    if (typeof item.owner !== "string" || item.owner.trim().length === 0) {
      errors.push(`${label}: owner is required`)
    }
    if (!validDateOnly(item.due)) {
      errors.push(`${label}: due must be a real YYYY-MM-DD date`)
    }
    if (typeof item.removalCriteria !== "string" || item.removalCriteria.trim().length === 0) {
      errors.push(`${label}: removalCriteria is required`)
    }
    if (item.status === "open") {
      openCount += 1
      if (validDateOnly(item.due) && currentDate >= item.due) {
        errors.push(`${label}: open intentional debt is due ${item.due}; resolve it before release`)
      }
    }
  })

  return {
    ok: errors.length === 0,
    errors,
    message: errors.length === 0
      ? `intentional debt gate: pass (${openCount} open item${openCount === 1 ? "" : "s"})`
      : `intentional debt gate: fail (${errors.length} error${errors.length === 1 ? "" : "s"})`,
  }
}

function validateIntentionalDebtFile(filePath, now = new Date()) {
  return validateIntentionalDebt(JSON.parse(fs.readFileSync(filePath, "utf8")), now)
}

function runCli(argv = process.argv.slice(2)) {
  const filePath = path.resolve(argv[0] ?? path.resolve(__dirname, "../docs/intentional-debt.json"))
  const result = validateIntentionalDebtFile(filePath)
  const writer = result.ok ? console.log : console.error
  writer(result.message)
  for (const error of result.errors) console.error(error)
  return result.ok ? 0 : 1
}

if (require.main === module) process.exitCode = runCli()

module.exports = {
  runCli,
  validateIntentionalDebt,
  validateIntentionalDebtFile,
  validDateOnly,
}
