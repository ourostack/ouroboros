import { serve, type Serve } from "./first-run-sso.ts";

// The SSO extension's stand-in as a process of its own (first-run-sso.ts ssoExtension starts it): its settings are the
// one argument, as JSON, and each line it writes is one event.

await serve(JSON.parse(process.argv[2]!) as Serve, (e) => process.stdout.write(`${JSON.stringify(e)}\n`));
