#!/bin/sh
# Creates the e2e fixture repo(s) the daemon lists as the workspace. Runs from
# the Playwright webServer command before the daemon boots. The repos live in
# projects/ (gitignored); only this script and flow.config.json are committed.
# Idempotent: an existing repo with a commit is left alone.
set -eu
DIR=$(cd "$(dirname "$0")" && pwd)
REPO="$DIR/projects/demo/alpha"

mkdir -p "$REPO"
if [ ! -d "$REPO/.git" ]; then
  git init -q "$REPO"
fi
if ! git -C "$REPO" rev-parse --verify -q HEAD >/dev/null 2>&1; then
  printf '# alpha\n\nFixture repo for the Flow e2e suite.\n' > "$REPO/README.md"
  git -C "$REPO" add README.md
  git -C "$REPO" -c user.name="Flow e2e" -c user.email="e2e@flow.invalid" \
    commit -q -m "Initial fixture commit"
fi
