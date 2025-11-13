#!/bin/bash
# Install script for originals-explorer
# This ensures bun install runs from the monorepo root to properly resolve workspace dependencies

set -e

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Navigate to the monorepo root (two levels up from apps/originals-explorer)
ROOT_DIR="$( cd "$SCRIPT_DIR/../.." && pwd )"

echo "Installing dependencies from monorepo root: $ROOT_DIR"
cd "$ROOT_DIR"
bun install

echo "Installation complete!"

