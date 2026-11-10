import type Database from "better-sqlite3"
import { emitNervesEvent } from "../nerves/runtime"

export type SqliteDatabase = Database.Database
export type SqliteOpenOptions = Database.Options

let Sqlite: typeof Database | null = null

/**
 * The one place the harness opens a SQLite database. The native driver loads
 * with the first database opened, not with every process that imports a store,
 * so the CLI and an idle daemon never load it. One seam also means a different
 * driver (such as `node:sqlite`) can replace it in one place.
 */
export function openDatabase(filename: string, options?: SqliteOpenOptions): SqliteDatabase {
  if (!Sqlite) {
    Sqlite = require("better-sqlite3") as typeof Database
    emitNervesEvent({ component: "engine", event: "engine.sqlite_driver_loaded", message: "sqlite driver loaded on first use", meta: {} })
  }
  return new Sqlite(filename, options)
}
