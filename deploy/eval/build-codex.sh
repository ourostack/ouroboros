#!/bin/sh
# Builds OpenAI Codex CLI from source at the commit pre-registration v2 pins (that commit has no release) for H's
# `codex` arm, and writes the binary to <out>/image/codex. Run it as root in a throwaway Debian bookworm container
# with <out> mounted, for example on the eval's own agent image:
#
#   docker run --rm --cpus 2 --user 0:0 -v <dir>:/build -v <this file>:/build-codex.sh:ro <agent image> sh /build-codex.sh /build
#
# then build deploy/eval/codex.Dockerfile with <dir>/image as its context. Everything it fetches (the toolchain, the
# sources and V8) stays under <out>. V8 comes as codex's own release builds it: the prebuilt rusty_v8 archive from
# codex's release, checked against the checksum manifest committed at the pinned commit.
set -eu
OUT="${1:?usage: build-codex.sh <out>}"
COMMIT=227fa4e805d44988b0888390f41afe1358e9d24d
JOBS="${JOBS:-2}"

apt-get update -qq
apt-get install -y -qq --no-install-recommends build-essential ca-certificates curl git libcap-dev libssl-dev pkg-config python3 >/dev/null

export RUSTUP_HOME="$OUT/rustup" CARGO_HOME="$OUT/cargo"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
  curl -fsSL https://sh.rustup.rs -o "$OUT/rustup-init.sh"
  sh "$OUT/rustup-init.sh" -y -q --no-modify-path --profile minimal --default-toolchain none
fi
export PATH="$CARGO_HOME/bin:$PATH"

if [ ! -d "$OUT/codex/.git" ]; then
  git init -q "$OUT/codex"
  git -C "$OUT/codex" remote add origin https://github.com/openai/codex.git
fi
git -C "$OUT/codex" fetch -q --depth 1 origin "$COMMIT"
git -C "$OUT/codex" checkout -q --force FETCH_HEAD
test "$(git -C "$OUT/codex" rev-parse HEAD)" = "$COMMIT"

target="$(uname -m)-unknown-linux-gnu"
version="$(python3 "$OUT/codex/.github/scripts/rusty_v8_bazel.py" resolved-v8-crate-version)"
base="https://github.com/openai/codex/releases/download/rusty-v8-v${version}"
profile=ptrcomp_sandbox_release
sums="rusty_v8_${profile}_${target}.sha256"
mkdir -p "$OUT/v8"
cd "$OUT/v8"
curl -fsSL "$base/$sums" -o "$sums"
expected="$(grep -F "  $sums" "$OUT/codex/third_party/v8/rusty_v8_$(echo "$version" | tr . _)_release_manifests.sha256" | cut -d ' ' -f 1)"
test -n "$expected"
echo "$expected  $sums" | sha256sum --check --quiet -
test "$(wc -l < "$sums")" -eq 2
curl -fsSL "$base/librusty_v8_${profile}_${target}.a.gz" -o "librusty_v8_${profile}_${target}.a.gz"
curl -fsSL "$base/src_binding_${profile}_${target}.rs" -o "src_binding_${profile}_${target}.rs"
sha256sum --check --quiet "$sums"

cd "$OUT/codex/codex-rs"
# The toolchain the commit's rust-toolchain.toml names.
rustup toolchain install "$(sed -n 's/^channel = "\(.*\)"/\1/p' rust-toolchain.toml)" --profile minimal
# The release profile as committed, without its debug line tables: the same code, a smaller build.
RUSTY_V8_ARCHIVE="$OUT/v8/librusty_v8_${profile}_${target}.a.gz" RUSTY_V8_SRC_BINDING_PATH="$OUT/v8/src_binding_${profile}_${target}.rs" \
  CARGO_PROFILE_RELEASE_DEBUG=none CARGO_TARGET_DIR="$OUT/target" \
  nice -n 19 cargo build --release --locked --jobs "$JOBS" --bin codex
mkdir -p "$OUT/image"
cp "$OUT/target/release/codex" "$OUT/image/codex"
"$OUT/image/codex" --version
