#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_PACKAGE="$SCRIPT_DIR/../../package.json"
# Fallback is used only when this wrapper is distributed without the project root.
# Keep it aligned with the current published clawfetch CLI version.
FALLBACK_VERSION="1.0.9"

if [ -f "$PROJECT_PACKAGE" ] && command -v node >/dev/null 2>&1; then
  CLAWFETCH_VERSION=$(node -e "process.stdout.write(require(process.argv[1]).version)" "$PROJECT_PACKAGE")
else
  CLAWFETCH_VERSION="$FALLBACK_VERSION"
fi

cd "$SCRIPT_DIR"
npm install --no-save "clawfetch@$CLAWFETCH_VERSION"
