/**
 * Shared JSON file store helpers for arc/ modules.
 *
 * obligations.ts, cares.ts, and intentions.ts all use the same pattern:
 * individual JSON files in a directory, with read-all / read-one / write-one
 * operations. This module extracts those patterns.
 */

import * as fs from "fs"
import * as path from "path"
import { trackSyncWrite } from "../heart/sync"

/**
 * Generate a timestamped random ID.
 * @param prefix Optional prefix (e.g. "care", "int"). Omit for plain timestamp IDs.
 */
export function generateTimestampId(prefix?: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 10)
  return prefix ? `${prefix}-${timestamp}-${random}` : `${timestamp}-${random}`
}

/**
 * Read all JSON files from a directory, parse each, and return an array.
 * Silently skips malformed files. Returns empty array if directory is missing.
 */
export function readJsonDir<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    /* v8 ignore next -- defensive: readdirSync race after existsSync @preserve */
    return []
  }

  const jsonFiles = entries.filter((entry) => entry.endsWith(".json")).sort()
  const records: T[] = []

  for (const file of jsonFiles) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), "utf-8")
      records.push(JSON.parse(raw) as T)
    } catch {
      // Skip malformed JSON files
    }
  }

  return records
}

/**
 * Read a single JSON file by ID from a directory.
 * Returns null if the file doesn't exist or is unparseable.
 */
export function readJsonFile<T>(dir: string, id: string): T | null {
  try {
    const raw = fs.readFileSync(path.join(dir, `${id}.json`), "utf-8")
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/**
 * Read a single JSON file by ID, throwing if not found.
 */
export function readJsonFileOrThrow<T>(dir: string, id: string, label: string): T {
  const filePath = path.join(dir, `${id}.json`)
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} not found: ${id}`)
  }
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
}

/**
 * Write a record to a JSON file, creating the directory if needed.
 * Automatically calls trackSyncWrite.
 */
export function writeJsonFile<T>(dir: string, id: string, record: T): void {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, `${id}.json`)
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2), "utf-8")
  trackSyncWrite(filePath)
}

