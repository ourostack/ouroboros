import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The #ouro-ax/ specifier is the package's imports entry for the Ouro AX kit. Without that entry, it resolves to the
// kit in the app's lib folder: the one components.json's lib alias names, through the tsconfig's paths (@/* to ./src/*).
const PREFIX = "#ouro-ax/";

interface Resolved {
  url: string;
  format?: string;
}
type NextResolve = (specifier: string, context: object) => Promise<Resolved>;

export async function resolve(specifier: string, context: object, nextResolve: NextResolve): Promise<Resolved> {
  if (!specifier.startsWith(PREFIX)) return nextResolve(specifier, context);
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if ((error as { code?: string }).code !== "ERR_PACKAGE_IMPORT_NOT_DEFINED") throw error;
    const file = join(libFolder() ?? missing(specifier), "ouro/ax", specifier.slice(PREFIX.length));
    return nextResolve(pathToFileURL(file).href, context);
  }
}

function missing(specifier: string): never {
  throw new Error(
    `[ouro-ui] Ouro check: ${specifier} is not in package.json "imports", and no components.json names the app's lib folder. Fix: add "imports": { "#ouro-ax/*": "./src/lib/ouro/ax/*" } to package.json, with src/lib replaced by your lib folder.`,
  );
}

/** The app's lib folder, from the nearest components.json above the working directory, or undefined if the tsconfig paths do not map it. */
function libFolder(): string | undefined {
  const app = findUp(process.cwd(), "components.json");
  if (!app) return undefined;
  const alias = (JSON.parse(readFileSync(join(app, "components.json"), "utf8")) as { aliases?: { lib?: string } }).aliases?.lib;
  if (!alias) return undefined;
  for (const name of ["tsconfig.json", "tsconfig.app.json"]) {
    const file = join(app, name);
    if (!existsSync(file)) continue;
    const paths = (readTsconfig(file) as { compilerOptions?: { paths?: Record<string, string[]> } }).compilerOptions?.paths ?? {};
    for (const [pattern, targets] of Object.entries(paths)) {
      const [target] = targets;
      if (!target) continue;
      if (pattern.endsWith("/*") && alias.startsWith(pattern.slice(0, -1))) return join(app, target.replace(/\*$/, alias.slice(pattern.length - 1)));
      if (pattern === alias) return join(app, target);
    }
  }
  return undefined;
}

function findUp(from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** A tsconfig is JSON with comments and trailing commas. */
function readTsconfig(file: string): unknown {
  const json = readFileSync(file, "utf8")
    .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match, string?: string) => string ?? "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(json);
}
