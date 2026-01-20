#!/bin/bash
# Ralph Loop - Automated Background Agent launcher for Cursor
# Usage: ./ralph-loop.sh [max_iterations]
#
# REQUIRES: Accessibility permissions for Terminal
#   System Preferences → Security & Privacy → Privacy → Accessibility → Add Terminal ✅

set -e

MAX_ITERATIONS=${1:-30}
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PRD_FILE="$SCRIPT_DIR/prd.json"
LOCK_FILE="$SCRIPT_DIR/.ralph-lock"
AGENT_PROMPT="$SCRIPT_DIR/ralph-agent.md"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

echo "═══════════════════════════════════════════════════════"
echo "  Ralph Loop - Cursor Background Agent"
echo "═══════════════════════════════════════════════════════"
echo ""

# Check files exist
[ ! -f "$PRD_FILE" ] && echo -e "${RED}Error: prd.json not found${NC}" && exit 1
[ ! -f "$AGENT_PROMPT" ] && echo -e "${RED}Error: ralph-agent.md not found${NC}" && exit 1

# Functions
all_complete() {
  [ "$(jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE")" -eq 0 ]
}

get_next_story() {
  jq -r '.userStories[] | select(.passes == false) | "\(.id): \(.title)"' "$PRD_FILE" | head -1
}

count_remaining() {
  jq '[.userStories[] | select(.passes == false)] | length' "$PRD_FILE"
}

wait_for_unlock() {
  local timeout=1800  # 30 min
  local waited=0
  while [ -f "$LOCK_FILE" ] && [ $waited -lt $timeout ]; do
    [ $((waited % 60)) -eq 0 ] && echo -e "${YELLOW}⏳ Agent working... (${waited}s)${NC}"
    sleep 10
    waited=$((waited + 10))
  done
  [ ! -f "$LOCK_FILE" ]
}

launch_agent() {
  # Copy prompt to clipboard
  cat "$AGENT_PROMPT" | pbcopy
  
  # AppleScript to open Composer, paste, submit
  osascript <<'APPLESCRIPT'
tell application "Cursor"
    activate
    delay 0.5
end tell

tell application "System Events"
    tell process "Cursor"
        keystroke "i" using command down
        delay 1.5
        keystroke "v" using command down
        delay 0.5
        keystroke return using command down
    end tell
end tell
APPLESCRIPT
}

# Main loop
for i in $(seq 1 $MAX_ITERATIONS); do
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo -e "  ${CYAN}Iteration $i / $MAX_ITERATIONS${NC}"
  echo "═══════════════════════════════════════════════════════"
  
  if all_complete; then
    echo -e "${GREEN}🎉 ALL STORIES COMPLETE!${NC}"
    exit 0
  fi
  
  REMAINING=$(count_remaining)
  NEXT=$(get_next_story)
  echo -e "${GREEN}📋 $NEXT${NC}"
  echo -e "   ${CYAN}($REMAINING remaining)${NC}"
  
  # Check lock
  if [ -f "$LOCK_FILE" ]; then
    echo -e "${YELLOW}🔒 Waiting for previous agent...${NC}"
    wait_for_unlock || { echo -e "${RED}Timeout${NC}"; exit 1; }
  fi
  
  # Pull latest
  echo "📥 Pulling latest..."
  git pull --rebase 2>/dev/null || true
  
  if all_complete; then
    echo -e "${GREEN}🎉 ALL COMPLETE!${NC}"
    exit 0
  fi
  
  # Launch
  echo "🚀 Launching Cursor agent..."
  launch_agent
  
  # Wait for start
  echo "⏳ Waiting for agent to start..."
  sleep 10
  
  if [ -f "$LOCK_FILE" ]; then
    echo -e "${GREEN}✓ Agent started${NC}"
    wait_for_unlock || { echo -e "${RED}Agent timeout${NC}"; exit 1; }
    echo -e "${GREEN}✅ Done${NC}"
  else
    echo -e "${YELLOW}⚠️  No lock - agent may not have started${NC}"
    echo "   Check Cursor. Retrying in 10s..."
    sleep 10
  fi
  
  sleep 2
done

echo -e "${YELLOW}Max iterations reached${NC}"
exit 1
