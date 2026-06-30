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

cat <<EOF

clawfetch npm CLI installed in:
  $SCRIPT_DIR/node_modules/clawfetch

NEXT:
  - Install the CLI-managed browser runtime:
      node node_modules/clawfetch/clawfetch.js runtime install
  - Verify readiness before fetching pages:
      node node_modules/clawfetch/clawfetch.js runtime check
  - Optional smoke test after runtime check succeeds:
      node node_modules/clawfetch/clawfetch.js https://example.com

EOF
