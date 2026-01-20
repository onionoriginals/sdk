#!/bin/bash
# Check Ralph status - run this to see progress
# Usage: ./ralph-status.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRD_FILE="$SCRIPT_DIR/prd.json"
LOCK_FILE="$SCRIPT_DIR/.ralph-lock"

echo "═══════════════════════════════════════════════════════"
echo "  Ralph Status"
echo "═══════════════════════════════════════════════════════"
echo ""

# Check lock
if [ -f "$LOCK_FILE" ]; then
  LOCK_TIME=$(cat "$LOCK_FILE")
  echo "🔒 LOCKED - Agent working since: $LOCK_TIME"
  echo "   (Delete $LOCK_FILE to force unlock)"
  echo ""
else
  echo "🔓 Unlocked - Ready for next agent"
  echo ""
fi

# Count stories
if [ -f "$PRD_FILE" ]; then
  TOTAL=$(jq '.userStories | length' "$PRD_FILE")
  COMPLETE=$(jq '[.userStories[] | select(.passes == true)] | length' "$PRD_FILE")
  REMAINING=$((TOTAL - COMPLETE))
  
  echo "📊 Progress: $COMPLETE / $TOTAL stories complete"
  echo ""
  
  if [ "$REMAINING" -gt 0 ]; then
    echo "📋 Next story:"
    jq -r '.userStories[] | select(.passes == false) | "   \(.id): \(.title)"' "$PRD_FILE" | head -1
    echo ""
    echo "🚀 To continue: Open Cursor, press Cmd+I, paste contents of ralph-agent.md"
  else
    echo "🎉 ALL STORIES COMPLETE!"
  fi
else
  echo "❌ No prd.json found"
fi

echo ""
echo "═══════════════════════════════════════════════════════"
