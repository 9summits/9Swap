#!/usr/bin/env bash
# Build the public redistributable binaries, then publish them (with their
# .sha256 manifests) to the Vercel Blob store.
set -euo pipefail

cd "$(dirname "$0")"

SWAP_PUBLIC_BUILD=1 ./build-all
./scripts/publish-cli.sh
