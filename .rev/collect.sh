#!/usr/bin/env bash
set -euo pipefail
export REV_BASE_SHA="${REV_BASE_SHA:-${GITHUB_BASE_SHA:-}}"
# The evidence job supplies the base through the event, before collector binding.
if [ -z "$REV_BASE_SHA" ]; then
  REV_BASE_SHA=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.GITHUB_EVENT_PATH)).pull_request.base.sha)')
  export REV_BASE_SHA
fi
{
  node .rev/release.mjs
  node --test scripts/release-workflow.test.mjs
} 2>&1 | tee .rev/observations.txt
