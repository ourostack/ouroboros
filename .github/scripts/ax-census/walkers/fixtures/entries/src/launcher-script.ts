// Not an entry point: process.argv is inside a script it writes out.
export const SCRIPT = `#!/usr/bin/env node
require("./entry")(process.argv.slice(2))
`
