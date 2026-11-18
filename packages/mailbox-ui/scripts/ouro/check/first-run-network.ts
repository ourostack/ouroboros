import { system, type System } from "./first-run-system.ts";

// First-run harness: the network a first run meets. `offline` drops everything but this machine's own loopback, as a Mac
// with no network has; `unreachable` drops only the hosts and address ranges an app's sign-in needs, as a sign-in that
// lapses and can't be renewed meets. Both refuse at once (block return), so a load fails as it does with no network rather
// than hanging; `unreachable` can hang instead (block drop), as a network too slow to answer. All lift. pf, in an anchor of
// its own: macOS only, and only on a machine the harness owns (a CI runner).

/** A hold on the network: whether it holds (proved by its probe), what was read, and how to lift it. */
export type Block = { ok: boolean; evidence: string; lift: () => void };

/** The hosts and address ranges an app reaches, and an address it needs that proves a hold. */
export type Network = { hosts: string[]; ranges: string[]; probe: string };

const ANCHOR = "com.apple/ouro-first-run";

/**
 * Whether `url` answers now (any HTTP answer), within 6 s.
 * @claim "Whether `url` answers now" registry/ouro/check/first-run-network.ts verify:fileLine(registry/ouro/check/first-run-network.ts, /"-m", "6"/)
 */
export function reachable(url: string, sys: System = system): boolean {
  return sys.run("curl", ["-sS", "-o", "/dev/null", "-m", "6", url]).status === 0;
}

function load(rules: string, probe: string, what: string, sys: System): Block {
  const sudo = (args: string[], input?: string) => sys.run("sudo", ["-n", ...args], input === undefined ? {} : { input });
  const enable = sudo(["pfctl", "-E"]);
  const token = /Token : (\d+)/.exec(`${enable.stdout}${enable.stderr}`)?.[1] ?? "";
  let put = sudo(["pfctl", "-a", ANCHOR, "-f", "-"], rules);
  if (reachable(probe, sys)) {
    // The system's ruleset wasn't loaded, so nothing reads the com.apple anchors yet: load it, then the anchor again.
    sudo(["pfctl", "-f", "/etc/pf.conf"]);
    put = sudo(["pfctl", "-a", ANCHOR, "-f", "-"], rules);
  }
  const blocked = put.status === 0 && !reachable(probe, sys);
  const lift = () => {
    sudo(["pfctl", "-a", ANCHOR, "-F", "all"]);
    if (token) sudo(["pfctl", "-X", token]);
  };
  const held = put.status === 0 ? "took the rules" : `refused them (${put.stderr.trim().slice(0, 160)})`;
  return {
    ok: blocked,
    evidence: blocked
      ? `${what}: ${probe} can't be reached`
      : `${what} isn't held: pf ${held}, yet ${probe} still answered, so this run proves nothing about it; run it on a machine where sudo -n pfctl works, as a CI runner`,
    lift,
  };
}

/**
 * No network but loopback, until lifted. `probe` is an address the app needs, read to prove the block holds. Only on a
 * machine that doesn't need the network itself: a CI runner loses its own connection to its service.
 * @claim "No network but loopback, until lifted." registry/ouro/check/first-run-network.ts verify:fileLine(registry/ouro/check/first-run-network.ts, /pass out quick on lo0 all\\nblock return out quick all/)
 */
export function offline(probe: string, sys: System = system): Block {
  return load("pass out quick on lo0 all\nblock return out quick all\n", probe, "offline", sys);
}

/**
 * The network's hosts (as they resolve now) and its address ranges refused, until lifted. `refuse`: a load fails at
 * once, as with no network. `hang`: it waits, as on a network too slow to answer.
 * @claim "`refuse`: a load fails at once" registry/ouro/check/first-run-network.ts verify:fileLine(registry/ouro/check/first-run-network.ts, /mode === "hang" \? "block drop" : "block return"/)
 */
export function unreachable(o: Network, what = "the sign-in unreachable", mode: "refuse" | "hang" = "refuse", sys: System = system): Block {
  const resolved = o.hosts.flatMap((n) => [...sys.run("dscacheutil", ["-q", "host", "-a", "name", n]).stdout.matchAll(/^ipv?6?_address: (\S+)$/gm)].map((m) => m[1]!));
  const all = [...new Set([...o.ranges, ...resolved])];
  const v4 = all.filter((a) => !a.includes(":"));
  const v6 = all.filter((a) => a.includes(":"));
  const verb = mode === "hang" ? "block drop" : "block return";
  const rules = [v4.length ? `${verb} out quick inet proto { tcp udp } to { ${v4.join(", ")} }` : "", v6.length ? `${verb} out quick inet6 proto { tcp udp } to { ${v6.join(", ")} }` : ""].filter(Boolean).join("\n") + "\n";
  return load(rules, o.probe, `${what} (${all.length} address ranges refused)`, sys);
}
