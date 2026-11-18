import { spawn, spawnSync } from "node:child_process";

/**
 * What the first-run harness asks of the machine: run a command and read what it said, start one and leave it running,
 * and wait. The harness modules take it, so a test drives them with a made-up machine and its own clock.
 */
export interface System {
  /** Runs a command to its end; `status` is null when it could not start or was stopped. */
  run(cmd: string, args: string[], o?: { input?: string; timeout?: number }): { status: number | null; stdout: string; stderr: string };
  /** Starts a command and leaves it running, as `open` a person's double-click is. */
  start(cmd: string, args: string[]): void;
  /** Waits `ms`. */
  sleep(ms: number): Promise<void>;
}

/** This machine. */
export const system: System = {
  run(cmd, args, o = {}) {
    const r = spawnSync(cmd, args, { encoding: "utf8", input: o.input, timeout: o.timeout ?? 60_000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  start(cmd, args) {
    spawn(cmd, args, { stdio: "ignore" })
      .on("error", () => {})
      .unref();
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
