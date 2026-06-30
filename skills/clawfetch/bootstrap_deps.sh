#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_PACKAGE="$SCRIPT_DIR/../../package.json"
FALLBACK_VERSION="0.1.7"

if [ -f "$PROJECT_PACKAGE" ] && command -v node >/dev/null 2>&1; then
  CLAWFETCH_VERSION=$(node -e "process.stdout.write(require(process.argv[1]).version)" "$PROJECT_PACKAGE")
else
  CLAWFETCH_VERSION="$FALLBACK_VERSION"
fi

cd "$SCRIPT_DIR"
npm install --no-save "clawfetch@$CLAWFETCH_VERSION"
