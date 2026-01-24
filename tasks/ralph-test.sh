#!/bin/bash
# Test the Ralph automation setup
# This will try to open Cursor Composer and paste text

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "═══════════════════════════════════════════════════════"
echo "  Ralph Setup Test"
echo "═══════════════════════════════════════════════════════"
echo ""

# Test 1: Check jq
echo -n "1. jq installed: "
if command -v jq &> /dev/null; then
  echo "✅"
else
  echo "❌ (install with: brew install jq)"
  exit 1
fi

# Test 2: Check prd.json
echo -n "2. prd.json exists: "
if [ -f "$SCRIPT_DIR/prd.json" ]; then
  STORIES=$(jq '.userStories | length' "$SCRIPT_DIR/prd.json")
  echo "✅ ($STORIES stories)"
else
  echo "❌"
  exit 1
fi

# Test 3: Check ralph-agent.md
echo -n "3. ralph-agent.md exists: "
if [ -f "$SCRIPT_DIR/ralph-agent.md" ]; then
  echo "✅"
else
  echo "❌"
  exit 1
fi

# Test 4: Check Cursor is running
echo -n "4. Cursor is running: "
if pgrep -f "Cursor" > /dev/null || pgrep -f "cursor" > /dev/null; then
  echo "✅"
else
  echo "⚠️  (couldn't detect - may still work)"
fi

# Test 5: Check accessibility permissions
echo ""
echo "5. Testing automation (Cursor will activate)..."
echo "   If this fails, grant Terminal/iTerm accessibility permissions:"
echo "   System Preferences → Security & Privacy → Privacy → Accessibility"
echo ""

# Simple test - just activate Cursor
osascript <<'EOF' 2>&1
tell application "Cursor"
    activate
end tell
delay 0.5
return "OK"
EOF

if [ $? -eq 0 ]; then
  echo "   ✅ Basic automation works"
else
  echo "   ❌ Automation failed - check accessibility permissions"
  exit 1
fi

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ All tests passed!"
echo ""
echo "  To run Ralph loop:"
echo "    ./ralph-loop.sh"
echo ""
echo "  To run a single iteration:"
echo "    ./ralph-loop.sh 1"
echo "═══════════════════════════════════════════════════════"
