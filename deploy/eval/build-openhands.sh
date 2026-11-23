#!/bin/sh
# Installs the OpenHands Software Agent SDK (with its tools) at the commit pre-registration v2 pins, for H's
# `openhands` arm: a Python and a virtual environment under <sdk>, with the versions in the SDK's own uv.lock, and the
# arm's supervisor beside them. Run it as root in a throwaway Debian bookworm container, with <work> mounted for the
# sources and <sdk> mounted at /opt/agent-sdk, the path the arm's image keeps it at, for example on the eval's own
# agent image:
#
#   docker run --rm --cpus 1.5 --user 0:0 -v <dir>:/build -v <dir>/image/agent-sdk:/opt/agent-sdk \
#     -v <this folder>:/scripts:ro <agent image> sh /scripts/build-openhands.sh /build /opt/agent-sdk
#
# then build deploy/eval/openhands.Dockerfile with <dir>/image as its context.
set -eu
WORK="${1:?usage: build-openhands.sh <work> <sdk>}"
SDK="${2:?usage: build-openhands.sh <work> <sdk>}"
COMMIT=ecea9a91d8d0fbc05273246df0ac56d8b27156b3
HERE="$(cd "$(dirname "$0")" && pwd)"

apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl git >/dev/null

mkdir -p "$WORK/bin"
# The uv and the Python the SDK's own agent-server image uses at this commit (openhands-agent-server's Dockerfile):
# uv 0.13.7 and a uv-managed Python 3.13. `--frozen` installs exactly the locked versions.
UV_VERSION=0.13.7
if [ ! -x "$WORK/bin/uv" ] || ! "$WORK/bin/uv" --version | grep -q " $UV_VERSION"; then
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$(uname -m)-unknown-linux-gnu.tar.gz" -o "$WORK/uv.tar.gz"
  tar -xzf "$WORK/uv.tar.gz" -C "$WORK/bin" --strip-components 1
fi
"$WORK/bin/uv" --version

if [ ! -d "$WORK/sdk-src/.git" ]; then
  git init -q "$WORK/sdk-src"
  git -C "$WORK/sdk-src" remote add origin https://github.com/OpenHands/software-agent-sdk.git
fi
git -C "$WORK/sdk-src" fetch -q --depth 1 origin "$COMMIT"
git -C "$WORK/sdk-src" checkout -q --force FETCH_HEAD
test "$(git -C "$WORK/sdk-src" rev-parse HEAD)" = "$COMMIT"

# The Python and the environment live under <sdk>, at the path the image keeps them; the packages are installed into
# the environment, not linked to the sources, so the sources stay out of the image. Bytecode is compiled here, because
# the image is read-only when the arm runs and Python would otherwise recompile every module on each start.
export UV_PYTHON_INSTALL_DIR="$SDK/python" UV_PROJECT_ENVIRONMENT="$SDK/venv" UV_CACHE_DIR="$WORK/uv-cache" UV_LINK_MODE=copy
cd "$WORK/sdk-src"
nice -n 19 "$WORK/bin/uv" sync --frozen --no-dev --no-editable --compile-bytecode --managed-python --package openhands-tools --python 3.13
nice -n 19 "$SDK/venv/bin/python" -m compileall -q "$SDK/python" >/dev/null || true
cp "$HERE/openhands/supervise.py" "$SDK/supervise.py"
"$SDK/venv/bin/python" -c "import openhands.sdk, openhands.tools.terminal, openhands.tools.file_editor; print('openhands sdk ok')"
