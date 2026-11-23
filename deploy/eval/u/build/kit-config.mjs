// Writes source-kit.mjs's config for a source-distributed kit: every component's main file as an entry.
//
//   node kit-config.mjs ouro <kit-root> <out> <report> <config-file>
//   node kit-config.mjs shadcn <kit-root> <out> <report> <config-file>
import fs from "node:fs"
import path from "node:path"

const [kit, root, out, report, file] = process.argv.slice(2)
let config
if (kit === "ouro") {
  // registry/ouro/components/ouro/<folder>/<component>.tsx for each component its component.json names (dialog's
  // folder holds Dialog and ConfirmDialog), else the folder's own name.
  const dir = "registry/ouro/components/ouro"
  const entries = fs.readdirSync(path.join(root, dir)).sort().flatMap((folder) => {
    const manifest = path.join(root, dir, folder, "component.json")
    const names = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, "utf8")).components ?? [folder] : [folder]
    return names.map((name) => `${dir}/${folder}/${name}.tsx`)
  }).filter((entry) => fs.existsSync(path.join(root, entry)))
  config = { root, alias: { "@/": "" }, entries, packageJson: path.join(root, "package.json"), out, report }
} else if (kit === "shadcn") {
  // apps/v4/registry/new-york-v4/ui/<name>.tsx, the registry's components; `@/` is apps/v4.
  const dir = "apps/v4/registry/new-york-v4/ui"
  const entries = fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".tsx")).sort().map((name) => `${dir}/${name}`)
  config = { root, alias: { "@/": "apps/v4/" }, entries, packageJson: path.join(root, "apps/v4/package.json"), out, report, typesFrom: path.join(root, "apps/v4") }
} else {
  throw new Error(`no config for kit ${kit}`)
}
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
console.log(`${kit}: ${config.entries.length} entries`)
