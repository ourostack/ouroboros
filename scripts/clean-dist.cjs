const fs = require("fs")
const path = require("path")

const distPath = path.resolve(__dirname, "../dist")

fs.rmSync(distPath, { recursive: true, force: true })
console.log(`cleaned ${path.relative(process.cwd(), distPath) || distPath}`)
