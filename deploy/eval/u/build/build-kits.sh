# Builds what the U image adds (pre-registration sections 2 and 4): /work/out/u-tools, the checking tools with their
# own dependencies, and /work/out/u-kits/k1..k3, one project template per arm, each kit installed as @kit/ui and
# brand-rewritten throughout. Then checks each template with the kit's reference solution and the tools' self-test.
# Runs in node:22-bookworm with /build (deploy/eval/u), /in (ouro-ui.tar) and /work, after mui-test.sh has left
# MUI's packed packages in /work/pkg/k3. Every report goes to /work/results.
set -eu
R=/work/results
mkdir -p "$R" /work/out
rm -f "$R/selftest-failed.txt"
pnpm_at() { version=$1; shift; npm exec --yes "pnpm@$version" -- "$@"; }

# The checking tools, from their lockfile.
rm -rf /work/out/u-tools
cp -r /build/tools /work/out/u-tools
cd /work/out/u-tools
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --loglevel=error; else npm install --no-audit --no-fund --loglevel=error; fi
cp package-lock.json "$R/u-tools-package-lock.json"
TOOLS=/work/out/u-tools/node_modules

# k1, the ouro arm: Ouro UI at 45b39c4a632b, from its own lockfile.
rm -rf /work/k1src /work/pkg/k1
mkdir -p /work/k1src /work/pkg/k1-tgz
tar -xf /in/ouro-ui.tar -C /work/k1src
cd /work/k1src
CI=1 pnpm_at 10.2.0 install --frozen-lockfile --ignore-scripts --reporter=silent
node /build/build/kit-config.mjs ouro /work/k1src /work/pkg/k1 "$R/k1-package.json" /work/k1-config.json
NODE_PATH=$TOOLS node /build/build/source-kit.mjs /work/k1-config.json
rm -f /work/pkg/k1-tgz/*.tgz
cd /work/pkg/k1 && npm pack --silent --pack-destination /work/pkg/k1-tgz

# k2, the shadcn arm: shadcn/ui at bfa64ff4d1cb, from its own lockfile.
rm -rf /work/k2src /work/pkg/k2
mkdir -p /work/k2src /work/pkg/k2-tgz
cd /work/k2src
git init -q
git remote add origin https://github.com/shadcn-ui/ui.git
git fetch -q --depth 1 origin bfa64ff4d1cb7317d2403ecb176df6826d4caffc
git checkout -q FETCH_HEAD
k2pnpm=$(node -p 'require("./package.json").packageManager.replace(/^pnpm@/, "").split("+")[0]')
CI=1 pnpm_at "$k2pnpm" install --frozen-lockfile --ignore-scripts --reporter=silent
node /build/build/kit-config.mjs shadcn /work/k2src /work/pkg/k2 "$R/k2-package.json" /work/k2-config.json
NODE_PATH=$TOOLS node /build/build/source-kit.mjs /work/k2-config.json
rm -f /work/pkg/k2-tgz/*.tgz
cd /work/pkg/k2 && npm pack --silent --pack-destination /work/pkg/k2-tgz

# The templates. MUI's styling engine is installed beside it, at the versions its own workspace tests with.
cd /work
node /build/build/template.mjs k1 /work/out/u-kits/k1 "$R" "@kit/ui=file:$(ls /work/pkg/k1-tgz/*.tgz)"
node /build/build/template.mjs k2 /work/out/u-kits/k2 "$R" "@kit/ui=file:$(ls /work/pkg/k2-tgz/*.tgz)"
k3=$(node -e '
const fs = require("fs")
const files = fs.readdirSync("/work/pkg/k3").filter((f) => f.endsWith(".tgz") && !/pigment/.test(f))
const main = files.find((f) => /^mui-material-\d/.test(f))
const name = (f) => "@mui/" + f.replace(/^mui-/, "").replace(/-\d.*$/, "")
// The exact versions the tests of @mui/material ran with: what its workspace installed for it (peers, from the catalog).
const installed = (p) => require(`/work/mui/packages/mui-material/node_modules/${p}/package.json`).version
const pairs = [main, ...files.filter((f) => f !== main)].map((f) => `${name(f)}=file:/work/pkg/k3/${f}`)
pairs.push(`@emotion/react=${installed("@emotion/react")}`, `@emotion/styled=${installed("@emotion/styled")}`)
console.log(pairs.join(" "))
')
# shellcheck disable=SC2086
node /build/build/template.mjs k3 /work/out/u-kits/k3 "$R" $k3

chmod -R a+rX,go-w /work/out

# Each template with its kit's reference solution: it must pass the full grade; and the tools' self-test.
for slot in k1 k2 k3; do
  rm -rf "/work/check-$slot"
  mkdir -p "/work/check-$slot/src"
  cp "/work/out/u-kits/$slot/package.json" "/work/out/u-kits/$slot/tsconfig.json" "/work/check-$slot/"
  ln -s "/work/out/u-kits/$slot/node_modules" "/work/check-$slot/node_modules"
  cp "/build/reference/$slot.tsx" "/work/check-$slot/src/RemoveCopy.tsx"
  node /work/out/u-tools/grade.mjs "/work/check-$slot" > "$R/$slot-reference-grade.json"
  # The same reference with one line the scan flags, so its grade takes the second run too: a correct component the
  # scan flags by accident must still pass in every arm.
  mkdir -p "/work/check-$slot-flagged/src"
  cp "/work/check-$slot/package.json" "/work/check-$slot/tsconfig.json" "/work/check-$slot-flagged/"
  ln -sfn "/work/out/u-kits/$slot/node_modules" "/work/check-$slot-flagged/node_modules"
  { echo '// flagged on purpose: process'; cat "/build/reference/$slot.tsx"; } > "/work/check-$slot-flagged/src/RemoveCopy.tsx"
  node /work/out/u-tools/grade.mjs "/work/check-$slot-flagged" > "$R/$slot-reference-flagged-grade.json"
  node /work/out/u-tools/selftest.mjs "/work/out/u-kits/$slot" > "$R/$slot-selftest.txt" 2>&1 || echo "$slot" >> "$R/selftest-failed.txt"
done
cat "$R"/k?-reference-grade.json
grep -c "^ok" "$R"/k?-selftest.txt
# Fails closed: a template whose reference doesn't pass the whole grade, or whose self-test fails, never ships.
node -e '
const fs = require("fs")
const R = process.argv[1]
const bad = ["k1", "k2", "k3"].filter((slot) => {
  const g = JSON.parse(fs.readFileSync(`${R}/${slot}-reference-grade.json`, "utf8"))
  const s = JSON.parse(fs.readFileSync(`${R}/${slot}-reference-flagged-grade.json`, "utf8"))
  const passes = (h) => h?.firstPressHeld && h.confirmedOnce187 && h.statusSaysDone
  return !(g.typecheck?.ok && g.axe?.ok && g.axe.violations === 0 && passes(g.hidden) && g.escape?.hits?.length === 0
    && s.escape?.hits?.length > 0 && passes(s.hidden) && passes(s.recheck))
})
if (fs.existsSync(`${R}/selftest-failed.txt`)) bad.push(...fs.readFileSync(`${R}/selftest-failed.txt`, "utf8").split("\n").filter(Boolean).map((slot) => `${slot} self-test`))
if (bad.length > 0) { console.error(`failed: ${bad.join(", ")}`); process.exit(1) }
console.log("every reference passes and every self-test passes")
' "$R"
