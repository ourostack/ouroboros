// A child that starts a long-lived process sharing its pipes, then never finishes.
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "inherit" });
setInterval(() => {}, 1000);
