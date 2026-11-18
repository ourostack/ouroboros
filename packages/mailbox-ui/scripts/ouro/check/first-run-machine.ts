import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { system, type System } from "./first-run-system.ts";

// First-run harness: the clean machine. A first run is only a first run on a Mac that has never seen the app: no app
// bundle, none of its data, no login item and no keychain item. On a fresh CI runner (a new VM per job) this proves it; on
// a reused Mac, `reset` makes it so for one app, and `leftovers` proves the reset. Generic: the app names its bundle and id.

export type App = {
  /** Where the app installs, as a person drags it: /Applications/<Name>.app. */
  bundle: string;
  /** Its bundle identifier, which names its data folders and its login item. */
  id: string;
  /**
   * The app's own keychain items still on this Mac, as the app reads them: a keychain call outside the app's own vault
   * is one a first run must not need, so the harness asks the app.
   */
  keychainItems?: () => string[];
  /** Takes the app's own keychain items off this Mac, as the app removes them. */
  forgetKeychain?: () => void;
  /** Other folders it keeps, beyond the bundle id's own. */
  extraPaths?: string[];
};

/** The folders a Mac keeps for an app under its bundle id, in the person's Library. */
export function dataPaths(app: App, home = os.homedir()): string[] {
  const lib = path.join(home, "Library");
  return [
    path.join(lib, "Application Support", app.id),
    path.join(lib, "Caches", app.id),
    path.join(lib, "WebKit", app.id),
    path.join(lib, "HTTPStorages", app.id),
    path.join(lib, "HTTPStorages", `${app.id}.binarycookies`),
    path.join(lib, "Cookies", `${app.id}.binarycookies`),
    path.join(lib, "Preferences", `${app.id}.plist`),
    path.join(lib, "Saved Application State", `${app.id}.savedState`),
    path.join(lib, "Containers", app.id),
    path.join(lib, "Logs", app.id),
    ...(app.extraPaths ?? []),
  ];
}

/** macOS's own login items (Background Task Management): the entries for this app that are turned on. null: unreadable. */
export function loginItemsOn(app: App, dump?: string | null, sys: System = system): string[] | null {
  const read = () => {
    const r = sys.run("sudo", ["-n", "sfltool", "dumpbtm"]);
    return r.status === 0 ? `${r.stdout}${r.stderr}` : null;
  };
  const text = dump === undefined ? read() : dump;
  if (text === null) return null;
  return text
    .split(/\n\s*#\d+:\s*\n/)
    .filter((b) => b.includes(app.id) && /Disposition:\s*\[[^\]]*\benabled\b/.test(b))
    .map((b) => /Name:\s*(.*)/.exec(b)?.[1]?.trim() ?? app.id);
}

/** What a Mac still holds of the app (its bundle, data, keychain items and a login item turned on), which a clean machine lacks. */
export function leftovers(app: App, o: { home?: string; btm?: string | null; sys?: System } = {}): string[] {
  const found: string[] = [];
  if (fs.existsSync(app.bundle)) found.push(`the app is installed at ${app.bundle}`);
  for (const p of dataPaths(app, o.home)) if (fs.existsSync(p)) found.push(`its data at ${p}`);
  for (const item of app.keychainItems?.() ?? []) found.push(`a keychain item: ${item}`);
  const login = loginItemsOn(app, o.btm, o.sys);
  if (login === null) found.push("sudo -n sfltool dumpbtm answered with an error (it needs passwordless sudo, as a CI runner has), so macOS's login items stayed unread and a login item isn't ruled out");
  else if (login.length) found.push(`a login item turned on: ${login.join(", ")}`);
  return found;
}

/** Takes the app and what it keeps off this Mac: quits it, and removes its bundle, data and keychain items. */
export function reset(app: App, o: { home?: string; sys?: System } = {}): void {
  const sys = o.sys ?? system;
  sys.run("pkill", ["-9", "-f", app.bundle]);
  fs.rmSync(app.bundle, { recursive: true, force: true });
  for (const p of dataPaths(app, o.home)) fs.rmSync(p, { recursive: true, force: true });
  app.forgetKeychain?.();
  sys.run("defaults", ["delete", app.id]);
}
