#!/usr/bin/env bash
set -euo pipefail
# Replace with probes exercising this PR's independently reviewed criteria.
node --test scripts/rev-evidence.test.mjs 2>&1 | tee .rev/observations.txt
