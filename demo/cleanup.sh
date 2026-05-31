#!/usr/bin/env bash
# Remove generated demo artifacts (GIFs, casts). Source scripts are kept.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
rm -f "$SCRIPT_DIR"/*.gif "$SCRIPT_DIR"/*.gif.opt "$SCRIPT_DIR"/*.cast 2>/dev/null || true
echo "Cleaned demo artifacts in $SCRIPT_DIR"
