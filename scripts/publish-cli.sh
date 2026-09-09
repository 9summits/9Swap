#!/usr/bin/env bash
# Publish redistributable swap binaries already in dist/ to the public
# Vercel Blob store. Does not build — run SWAP_PUBLIC_BUILD=1 ./build-all
# (or ./deploy.sh, which builds then calls this) first.
#
# Prerequisites:
#   - vercel CLI
#   - BLOB_READ_WRITE_TOKEN (or: vercel env pull .env.blob --environment production)
#   - project linked (.vercel/project.json)
#   - dist/swap-{darwin,linux}-{arm64,x64} and dist/swap-windows-x64.exe
#
# Usage:
#   ./scripts/publish-cli.sh
#   ./scripts/publish-cli.sh --upload-only   # accepted, ignored (historical alias)
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "${1:-}" = "--upload-only" ]; then
  shift
fi
if [ $# -gt 0 ]; then
  echo "error: unexpected args: $*" >&2
  echo "usage: ./scripts/publish-cli.sh [--upload-only]" >&2
  exit 1
fi

if [ -z "${BLOB_READ_WRITE_TOKEN:-}" ]; then
  if [ -f .env.blob ]; then
    # shellcheck disable=SC1091
    eval "$(grep '^BLOB_READ_WRITE_TOKEN=' .env.blob | sed 's/\r$//')"
  fi
fi
if [ -z "${BLOB_READ_WRITE_TOKEN:-}" ]; then
  echo "error: BLOB_READ_WRITE_TOKEN unset. Run:" >&2
  echo "  vercel env pull .env.blob --environment production" >&2
  echo "  eval \"\$(grep '^BLOB_READ_WRITE_TOKEN=' .env.blob)\"" >&2
  exit 1
fi
export BLOB_READ_WRITE_TOKEN

ASSETS=(
  swap-darwin-arm64
  swap-darwin-x64
  swap-linux-arm64
  swap-linux-x64
  swap-windows-x64.exe
)

for name in "${ASSETS[@]}"; do
  f="dist/$name"
  if [ ! -f "$f" ]; then
    echo "error: missing $f — run SWAP_PUBLIC_BUILD=1 ./build-all first" >&2
    exit 1
  fi
  digest="$(openssl dgst -sha256 "$f" | awk '{print $NF}')"
  if ! [[ "$digest" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "error: could not SHA-256 $f (got ${digest:-empty})" >&2
    exit 1
  fi
  printf '%s\n' "$digest" > "dist/${name}.sha256"
  echo "→ uploading cli/$name" >&2
  vercel blob put "$f" \
    --access public \
    --pathname "cli/$name" \
    --allow-overwrite true \
    --content-type application/octet-stream \
    --multipart true \
    --rw-token "$BLOB_READ_WRITE_TOKEN"
  echo "→ uploading cli/${name}.sha256" >&2
  vercel blob put "dist/${name}.sha256" \
    --access public \
    --pathname "cli/${name}.sha256" \
    --allow-overwrite true \
    --content-type text/plain \
    --rw-token "$BLOB_READ_WRITE_TOKEN"
done

echo
echo "published. install with:"
echo "  curl -fsSL https://swap.9summits.io/install.sh | bash"
echo
echo "public asset base:"
echo "  https://swap.9summits.io/cli/"
