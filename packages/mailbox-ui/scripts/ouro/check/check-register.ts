import { register } from "node:module";

// Registers the #ouro-ax/ resolver for this process: check.ts loads it before run.ts, which imports the kit by that name.
register("./ax-hooks.ts", import.meta.url);
