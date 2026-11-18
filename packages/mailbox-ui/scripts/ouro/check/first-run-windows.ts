import fs from "node:fs";
import path from "node:path";
import { system, type System } from "./first-run-system.ts";

// First-run harness on Windows: a System that answers the harness's macOS commands the way Windows does, and the eyes
// built from first-run-uia-tree.cs, so the session, the detours, the machine and the network modules run unchanged on a
// fresh Windows runner. Generic: no app names; the app says how to start it and how to find its process.

const SOURCE = path.join(import.meta.dirname, "first-run-uia-tree.cs");
/** Windows Firewall's rules for a hold carry this name, so lifting it removes only the harness's own. */
const RULE = "ouro-first-run";
/**
 * Everything but loopback: what macOS's pf takes from "block return out quick all" after "pass out quick on lo0 all".
 * @claim "Everything but loopback" scripts/check/first-run-windows.test.mts verify:testExists(scripts/check/first-run-windows.test.mts::first-run harness on Windows > holds the network with Windows Firewall's outbound rules, turns the firewall on for the hold, and puts it back)
 */
const ALL_BUT_LOOPBACK = ["0.0.0.0-126.255.255.255", "128.0.0.0-255.255.255.255", "::2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"];

/**
 * Builds the eyes at `out` (a .exe) from first-run-uia-tree.cs with the .NET Framework's own csc, which every Windows has,
 * against UI Automation's assemblies. Pass the result to `new Eyes(exe, sys)` and to `windowsSystem({ eyes: exe })`.
 * @claim "Builds the eyes at `out` (a .exe)" scripts/check/first-run-windows.test.mts verify:testExists(scripts/check/first-run-windows.test.mts::first-run harness on Windows > builds the eyes with the .NET Framework's csc against UI Automation, and names the compiler when it fails)
 * @example
 * const exe = buildWindowsEyes(path.join(out, "uia-tree.exe"));
 */
export function buildWindowsEyes(out: string, sys: System = system): string {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const fw = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319");
  const refs = ["UIAutomationClient.dll", "UIAutomationTypes.dll", "WindowsBase.dll"].map((d) => `/r:${path.join(fw, "WPF", d)}`);
  const r = sys.run(path.join(fw, "csc.exe"), ["/nologo", "/optimize+", "/target:exe", `/out:${out}`, ...refs, "/r:System.Drawing.dll", "/r:System.Web.Extensions.dll", SOURCE], { timeout: 300_000 });
  if (r.status !== 0) throw new Error(`first-run-uia-tree.cs did not build with ${path.join(fw, "csc.exe")}: ${(r.stdout || r.stderr).slice(0, 600)}`);
  return out;
}

export type WindowsOptions = {
  /** The built eyes (buildWindowsEyes): they take the screenshots screencapture takes on a Mac. */
  eyes: string;
  /** Starts the app as a person does (macOS's `open` on the bundle); by default the shell opens `target`, a shortcut or a program. */
  open?: (target: string) => void;
  /** The app's process ids for `pgrep -x <name>`; by default the processes with that image name. */
  pgrep?: (name: string) => number[];
  /** Ends the app's processes for `pkill -9 -f <pattern>`; by default the processes whose command line holds the pattern. */
  pkill?: (pattern: string) => void;
};

type Result = ReturnType<System["run"]>;
const answer = (status: number | null, stdout = "", stderr = ""): Result => ({ status, stdout, stderr });
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * This Windows machine, as the harness asks a Mac. `screencapture` is the eyes' one-shot picture; `open` the app's own, else
 * the shell's `start`; `pgrep` and `pkill` the app's own, else Windows' processes; `curl` is curl.exe; `dscacheutil`
 * Resolve-DnsName; `sudo -n pfctl` Windows Firewall's outbound block rules, which refuse at once whether pf would refuse or
 * drop, with each profile that was off turned on for the hold and put back as it was; `sudo -n sfltool dumpbtm` the Run keys and the Startup folder, in its form; and `defaults` nothing. Any other
 * command runs as it is. The runner must be an administrator, as a GitHub-hosted Windows runner is, for the firewall.
 * @claim "This Windows machine, as the harness asks" scripts/check/first-run-windows.test.mts verify:testExists(scripts/check/first-run-windows.test.mts::first-run harness on Windows > answers screencapture, pgrep, pkill, curl, dscacheutil and defaults as Windows does)
 * @claim "`sudo -n pfctl` Windows Firewall's outbound block rules" scripts/check/first-run-windows.test.mts verify:testExists(scripts/check/first-run-windows.test.mts::first-run harness on Windows > holds the network with Windows Firewall's outbound rules, turns the firewall on for the hold, and puts it back)
 * @claim "`sudo -n sfltool dumpbtm` the Run keys" scripts/check/first-run-windows.test.mts verify:testExists(scripts/check/first-run-windows.test.mts::first-run harness on Windows > lists the Run keys and the Startup folder as login items, which leftovers reads)
 * @example
 * const sys = windowsSystem({ eyes: exe, pgrep: (name) => (name === "Example" ? examplePids() : []) });
 * const session = new FirstRunSession({ out, eyes: new Eyes(exe, sys), app, report, system: sys });
 */
export function windowsSystem(o: WindowsOptions, base: System = system): System {
  const ps = (command: string, timeout = 60_000) => base.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { timeout });
  /**
   * The profiles that were off when the hold began, each with its default actions, to put back as they were.
   * @claim "The profiles that were off when the" scripts/check/first-run-windows.test.mts verify:testExists(scripts/check/first-run-windows.test.mts::first-run harness on Windows > holds the network with Windows Firewall's outbound rules, turns the firewall on for the hold, and puts it back)
   */
  let wereOff: { name: string; inbound: string; outbound: string }[] = [];

  const pf = (args: string[], input = ""): Result => {
    if (args[0] === "-E") {
      // pf's enable: each profile that is off turned on for the hold, letting through what it would have; pfctl -X puts
      // those back, off and with their own default actions. A profile that was on is left alone.
      const read = ps("Get-NetFirewallProfile | Where-Object Enabled -eq $false | ForEach-Object { $_.Name + ':' + $_.DefaultInboundAction + ':' + $_.DefaultOutboundAction }").stdout;
      wereOff = [...read.matchAll(/^(\w+):(\w+):(\w+)\r?$/gm)].map((m) => ({ name: m[1]!, inbound: m[2]!, outbound: m[3]! }));
      if (wereOff.length) ps(`Set-NetFirewallProfile -Profile ${wereOff.map((p) => p.name).join(",")} -Enabled True -DefaultInboundAction Allow -DefaultOutboundAction Allow`);
      return answer(0, "Token : 1\n");
    }
    if (args[0] === "-X") {
      if (wereOff.length) ps(wereOff.map((p) => `Set-NetFirewallProfile -Profile ${p.name} -Enabled False -DefaultInboundAction ${p.inbound} -DefaultOutboundAction ${p.outbound}`).join("; "));
      wereOff = [];
      return answer(0);
    }
    if (args[0] === "-a" && args[2] === "-F") return ps(`Remove-NetFirewallRule -DisplayName ${quote(RULE)} -ErrorAction SilentlyContinue; exit 0`);
    if (args[0] === "-a" && args[2] === "-f") {
      const lines = input.split("\n").filter((l) => /^block /.test(l));
      const everything = lines.some((l) => /\bout quick all$/.test(l));
      const addresses = everything ? ALL_BUT_LOOPBACK : lines.flatMap((l) => (/\bto \{ ([^}]*) \}/.exec(l)?.[1] ?? "").split(",").map((a) => a.trim()).filter(Boolean));
      if (!addresses.length) return answer(1, "", "no addresses in the rules");
      return ps(`New-NetFirewallRule -DisplayName ${quote(RULE)} -Direction Outbound -Action Block -RemoteAddress ${addresses.map(quote).join(",")} | Out-Null`);
    }
    // The system ruleset (pfctl -f /etc/pf.conf): Windows Firewall has none to load.
    return answer(0);
  };

  /**
   * The Run keys and the Startup folder, as sfltool dumpbtm lists login items: a block each, enabled.
   * @claim "The Run keys and the Startup folder" scripts/check/first-run-windows.test.mts verify:testExists(scripts/check/first-run-windows.test.mts::first-run harness on Windows > lists the Run keys and the Startup folder as login items, which leftovers reads)
   */
  const loginItems = (): Result => {
    const keys = ["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"];
    const runs = keys.flatMap((k) => base.run("reg", ["query", k]).stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => /\sREG_\w+\s/.test(l)));
    const roaming = process.env.APPDATA;
    const startup = roaming && path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
    const links = startup && fs.existsSync(startup) ? fs.readdirSync(startup).map((f) => path.join(startup, f)) : [];
    return answer(0, [...runs, ...links].map((entry, i) => `\n #${i + 1}:\n Name: ${entry}\n Disposition: [enabled, allowed, visible]\n`).join(""));
  };

  const pids = (name: string) => (o.pgrep ? o.pgrep(name) : ps(`(Get-Process -Name ${quote(name)} -ErrorAction SilentlyContinue).Id -join ' '`).stdout.match(/\d+/g) ?? []).map(Number);

  return {
    run(cmd, args, opts = {}) {
      switch (cmd) {
        case "screencapture": {
          const file = args.at(-1)!;
          const at = args.indexOf("-R");
          const rect = at >= 0 ? args[at + 1]!.split(",") : [];
          return base.run(o.eyes, ["--shot", file, ...rect], { timeout: opts.timeout ?? 20_000 });
        }
        case "pgrep": {
          const found = pids(args.at(-1)!);
          return answer(found.length ? 0 : 1, found.join("\n"));
        }
        case "pkill": {
          const pattern = args.at(-1)!;
          if (o.pkill) o.pkill(pattern);
          else ps(`Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ${quote(`*${pattern}*`)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
          return answer(0);
        }
        case "curl":
          return base.run("curl.exe", args.map((a) => (a === "/dev/null" ? "NUL" : a)), opts);
        case "dscacheutil": {
          const name = args.at(-1)!;
          const ips = ps(`(Resolve-DnsName -Name ${quote(name)} -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress } | ForEach-Object IPAddress) -join ' '`, 30_000).stdout.match(/\S+/g) ?? [];
          return answer(0, ips.map((ip) => `${ip.includes(":") ? "ipv6_address" : "ip_address"}: ${ip}`).join("\n"));
        }
        case "defaults":
          return answer(0);
        case "sudo": {
          const [, tool, ...rest] = args;
          if (tool === "pfctl") return pf(rest, opts.input);
          if (tool === "sfltool") return loginItems();
          return base.run(tool!, rest, opts);
        }
        default:
          return base.run(cmd, args, opts);
      }
    },
    start(cmd, args) {
      if (cmd !== "open") return base.start(cmd, args);
      const target = args.at(-1)!;
      if (o.open) o.open(target);
      else base.start("cmd.exe", ["/c", "start", "", target]);
    },
    sleep: (ms) => base.sleep(ms),
  };
}

/**
 * What Windows keeps for an app beyond a Mac's Library: its local and roaming app data folders and its Start menu
 * shortcut. Pass them to `leftovers` as `extraPaths`.
 * @claim "What Windows keeps for an app beyond" scripts/check/first-run-windows.test.mts verify:testExists(scripts/check/first-run-windows.test.mts::first-run harness on Windows > names the app's local and roaming data folders and its Start menu shortcut)
 * @example
 * leftovers({ bundle: installDir, id: "Example", extraPaths: windowsDataPaths({ folder: "Vendor\\Example", shortcut: "Example" }) }, { sys });
 */
export function windowsDataPaths(o: { folder: string; shortcut?: string }): string[] {
  const local = process.env.LOCALAPPDATA ?? "";
  const roaming = process.env.APPDATA ?? "";
  return [path.join(local, o.folder), path.join(roaming, o.folder), ...(o.shortcut ? [path.join(roaming, "Microsoft", "Windows", "Start Menu", "Programs", `${o.shortcut}.lnk`)] : [])];
}
