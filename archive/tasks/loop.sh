#!/bin/bash
# Usage: ./loop.sh [mode] [max_iterations]
#
# Modes:
#   both        - Run Ralph and Lisa in parallel (default)
#   ralph       - Builder agent only — implements functionality
#   lisa        - Planning agent only — creates plan, then steers ongoing work
#   restart     - Reset project state and run Lisa's interview again
#
# max_iterations defaults to 20. Pass 0 for unlimited.
#
# Examples:
#   ./loop.sh              # Both agents in parallel, max 20 iterations (default)
#   ./loop.sh both 10      # Both agents, max 10 iterations each
#   ./loop.sh ralph        # Ralph only, max 20 iterations (default)
#   ./loop.sh ralph 0      # Ralph only, unlimited
#   ./loop.sh lisa         # Lisa only, max 20 iterations (starts interview if new project)
#   ./loop.sh lisa 5       # Lisa only, max 5 iterations
#   ./loop.sh restart      # Reset and re-run Lisa's interview

set -e

CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || echo "main")

# Set up logging for web viewer
LOG_DIR="$(dirname "$0")/.logs"
LOG_FILE="$LOG_DIR/agent.log"
mkdir -p "$LOG_DIR"

# Output a JSON log line (for JSONL format)
log_json() {
    local type="$1"
    local agent="$2"
    local message="$3"
    # Escape special chars for JSON using perl
    local escaped=$(printf '%s' "$message" | perl -pe 's/\\/\\\\/g; s/"/\\"/g; s/\n/\\n/g; s/\r/\\r/g; s/\t/\\t/g')
    local json="{\"type\":\"$type\",\"agent\":\"$agent\",\"message\":\"$escaped\",\"ts\":$(date +%s)}"
    echo "$json" >> "$LOG_FILE"
    # Also echo readable version to terminal
    echo "$message"
}

# Echo to terminal and log as JSON
log_echo() {
    log_json "log" "system" "$*"
}

# Wrap Claude's JSON output with agent field and append to log
log_claude() {
    local agent="$1"
    local logfile="$LOG_FILE"
    perl -e '
        $|=1;  # unbuffered
        my $agent = shift;
        my $logfile = shift;
        open(my $log, ">>", $logfile) or die "Cannot open $logfile: $!";
        select($log); $|=1; select(STDOUT);  # unbuffer log file too
        while (<STDIN>) {
            s/^\{/{"agent":"$agent",/;
            print $log $_;
            print "[$agent] $_";
        }
        close($log);
    ' "$agent" "$logfile"
}

# Check if project needs initialization
needs_init() {
    # Check if IMPLEMENTATION_PLAN.md is missing or contains "NOT INITIALIZED"
    if [ ! -f "IMPLEMENTATION_PLAN.md" ]; then
        return 0  # needs init
    fi
    if grep -q "NOT INITIALIZED" "IMPLEMENTATION_PLAN.md" 2>/dev/null; then
        return 0  # needs init
    fi
    # Check if specs directory is empty or missing
    if [ ! -d "specs" ] || [ -z "$(ls -A specs 2>/dev/null)" ]; then
        return 0  # needs init
    fi
    return 1  # does not need init
}

# Check if project is complete and idle (no work to do)
is_project_complete() {
    # Must have IMPLEMENTATION_PLAN.md
    if [ ! -f "IMPLEMENTATION_PLAN.md" ]; then
        return 1  # not complete
    fi
    
    # Check for completion markers in IMPLEMENTATION_PLAN.md
    # Look for "All phases complete" or "No active task" patterns
    if grep -qi "all phases complete\|no active task" "IMPLEMENTATION_PLAN.md" 2>/dev/null; then
        # Also verify no [IN PROGRESS] markers
        if ! grep -q "\[IN PROGRESS\]\|\[LISA-WORKING\]" "IMPLEMENTATION_PLAN.md" 2>/dev/null; then
            # Check if NOTES.md has any new instructions (not just the template)
            if [ -f "NOTES.md" ]; then
                # Check if Latest section has actual content (not just "<!-- No new notes -->")
                local notes_content=$(sed -n '/## Latest/,/## Archive/p' "NOTES.md" 2>/dev/null | grep -v "^#\|^$\|^---\|<!-- No new notes -->\|<!--.*-->" | tr -d '[:space:]')
                if [ -z "$notes_content" ]; then
                    return 0  # project is complete and idle
                fi
            else
                return 0  # no NOTES.md means no instructions, project complete
            fi
        fi
    fi
    
    return 1  # not complete or has active work
}

# Run Lisa in interactive mode (for new project interview)
run_lisa_interactive() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  📚 Lisa: New Project Setup"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Lisa will interview you to understand what you want to build."
    echo "After the interview, she'll create specs and an implementation plan."
    echo ""
    echo "Press Ctrl+C to exit at any time."
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    
    # Run Claude in interactive mode (no -p flag)
    claude \
        --dangerously-skip-permissions \
        --model opus \
        --verbose \
        "$(cat PROMPT_lisa.md)"
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅ Setup complete!"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "You can now run:"
    echo "  ./loop.sh ralph   - Start building"
    echo "  ./loop.sh both    - Run both agents"
    echo ""
}

# Agent runner function (pipe mode for autonomous loops)
run_agent() {
    local AGENT_NAME=$1
    local PROMPT_FILE=$2
    local MAX_ITERATIONS=$3
    local LOG_PREFIX=$4
    local ITERATION=0
    local IDLE_COUNT=0
    local MAX_IDLE=3  # Exit after 3 consecutive idle loops

    log_echo "[$LOG_PREFIX] Starting $AGENT_NAME agent..."
    
    # Verify prompt file exists
    if [ ! -f "$PROMPT_FILE" ]; then
        echo "[$LOG_PREFIX] Error: $PROMPT_FILE not found"
        return 1
    fi

    while true; do
        if [ $MAX_ITERATIONS -gt 0 ] && [ $ITERATION -ge $MAX_ITERATIONS ]; then
            log_echo "[$LOG_PREFIX] Reached max iterations: $MAX_ITERATIONS"
            break
        fi

        ITERATION=$((ITERATION + 1))
        log_echo ""
        log_echo "[$LOG_PREFIX] ═══════════════ LOOP $ITERATION ═══════════════"
        log_echo ""

        # Check if project is complete BEFORE running (to catch idle state)
        local was_complete_before=false
        if is_project_complete; then
            was_complete_before=true
        fi

        # Run agent iteration
        cat "$PROMPT_FILE" | claude -p \
            --dangerously-skip-permissions \
            --output-format=stream-json \
            --model opus \
            --verbose 2>&1 | log_claude "$LOG_PREFIX"

        # Push changes after each iteration
        git push origin "$CURRENT_BRANCH" 2>/dev/null || {
            echo "[$LOG_PREFIX] Creating remote branch..."
            git push -u origin "$CURRENT_BRANCH" 2>/dev/null || true
        }

        # Check if project is complete AFTER the iteration
        if is_project_complete; then
            if [ "$was_complete_before" = true ]; then
                # Project was complete before AND after — this was an idle loop
                IDLE_COUNT=$((IDLE_COUNT + 1))
                log_echo "[$LOG_PREFIX] ⏸️  Project complete, no new work (idle count: $IDLE_COUNT/$MAX_IDLE)"
                
                if [ $IDLE_COUNT -ge $MAX_IDLE ]; then
                    log_echo ""
                    log_echo "[$LOG_PREFIX] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                    log_echo "[$LOG_PREFIX] ✅ Project complete! Exiting after $MAX_IDLE idle loops."
                    log_echo "[$LOG_PREFIX] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                    log_echo "[$LOG_PREFIX] To continue development, add instructions to NOTES.md"
                    log_echo "[$LOG_PREFIX] then run: ./loop.sh"
                    log_echo ""
                    break
                fi
            else
                # Project just became complete this iteration
                IDLE_COUNT=1
                log_echo "[$LOG_PREFIX] 🎉 Project marked complete! Will exit after $((MAX_IDLE - IDLE_COUNT)) more idle loops."
            fi
        else
            # Project has active work, reset idle counter
            IDLE_COUNT=0
        fi

        # Lisa runs less frequently — pause between planning passes
        if [ "$AGENT_NAME" = "Lisa" ]; then
            log_echo "[$LOG_PREFIX] Sleeping 60s before next planning pass..."
            sleep 60
        fi
    done
}

# Parse arguments
MODE="${1:-both}"
MAX_ITERATIONS="${2:-20}"

# Handle numeric first argument (legacy: ./loop.sh 20)
if [[ "$1" =~ ^[0-9]+$ ]]; then
    MODE="both"
    MAX_ITERATIONS=$1
fi

# Clear log file on new run
> "$LOG_FILE"

log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_echo "  🎬 The Simpsons Agentic Loop"
log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_echo "  Mode:   $MODE"
log_echo "  Branch: $CURRENT_BRANCH"
[ $MAX_ITERATIONS -gt 0 ] && log_echo "  Max:    $MAX_ITERATIONS iterations"
log_echo "  Viewer: http://localhost:3333"
log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

case "$MODE" in
    restart)
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "  🔄 Restarting Project"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "This will reset the project for a fresh interview."
        echo ""
        read -p "Archive existing specs and plan? [y/N] " -n 1 -r
        echo ""
        
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            # Archive existing files
            ARCHIVE_DIR=".archive/$(date +%Y%m%d_%H%M%S)"
            mkdir -p "$ARCHIVE_DIR"
            
            if [ -f "IMPLEMENTATION_PLAN.md" ]; then
                cp "IMPLEMENTATION_PLAN.md" "$ARCHIVE_DIR/"
                echo "  📦 Archived IMPLEMENTATION_PLAN.md"
            fi
            
            if [ -d "specs" ] && [ -n "$(ls -A specs 2>/dev/null)" ]; then
                cp -r "specs" "$ARCHIVE_DIR/"
                echo "  📦 Archived specs/"
            fi
            
            echo ""
            echo "Archives saved to: $ARCHIVE_DIR"
        fi
        
        # Reset to uninitialized state
        echo ""
        echo "Resetting project state..."
        
        # Mark plan as uninitialized
        echo "# Implementation Plan

> **NOT INITIALIZED** — Run \`./loop.sh lisa\` to start the interview.
" > IMPLEMENTATION_PLAN.md
        echo "  ✓ Reset IMPLEMENTATION_PLAN.md"
        
        # Clear specs directory
        rm -rf specs
        mkdir -p specs
        echo "  ✓ Cleared specs/"
        
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "  ✅ Reset complete! Starting Lisa's interview..."
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        
        # Immediately start Lisa's interview
        run_lisa_interactive
        ;;
    ralph|build)
        # Check if initialized
        if needs_init; then
            echo ""
            echo "⚠️  Project not initialized!"
            echo ""
            echo "Ralph can't build without specs and a plan."
            echo "Run './loop.sh lisa' first to set up the project."
            echo ""
            exit 1
        fi
        log_echo "🔨 Ralph: \"Me fail English? That's unpossible!\""
        run_agent "Ralph" "PROMPT_ralph.md" "$MAX_ITERATIONS" "RALPH"
        ;;
    lisa|plan)
        # Run interactively if new project, otherwise autonomous loop
        if needs_init; then
            echo "📚 Lisa: \"I see this is a new project. Let's set it up!\""
            run_lisa_interactive
        else
            log_echo "📚 Lisa: \"A well-organized plan is the foundation of success.\""
            run_agent "Lisa" "PROMPT_lisa.md" "$MAX_ITERATIONS" "LISA"
        fi
        ;;
    both|parallel)
        # Check if initialized
        if needs_init; then
            echo ""
            echo "⚠️  Project not initialized!"
            echo ""
            echo "Run './loop.sh lisa' first to set up the project."
            echo ""
            exit 1
        fi
        
        log_echo "📚 Lisa: \"First, we need a plan.\""
        log_echo "🔨 Ralph: \"I'm helping!\""
        log_echo ""
        
        # Trap to kill both processes on exit
        trap 'log_echo ""; log_echo "Shutting down agents..."; kill $(jobs -p) 2>/dev/null; exit' INT TERM
        
        # PHASE 1: Lisa creates/updates the initial plan (synchronous)
        log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        log_echo "  Phase 1: Lisa creates the plan..."
        log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        
        cat "PROMPT_lisa.md" | claude -p \
            --dangerously-skip-permissions \
            --output-format=stream-json \
            --model opus \
            --verbose 2>&1 | log_claude "LISA"
        
        git push origin "$CURRENT_BRANCH" 2>/dev/null || git push -u origin "$CURRENT_BRANCH" 2>/dev/null || true
        
        # Check if project is already complete after initial planning
        if is_project_complete; then
            log_echo ""
            log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            log_echo "  ✅ Project is complete! No active work to do."
            log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            log_echo ""
            log_echo "To continue development, add instructions to NOTES.md"
            log_echo "then run: ./loop.sh"
            log_echo ""
            exit 0
        fi
        
        # PHASE 2: Both agents loop in parallel
        log_echo ""
        log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        log_echo "  Phase 2: Ralph builds while Lisa steers..."
        log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        log_echo ""
        
        run_agent "Ralph" "PROMPT_ralph.md" "$MAX_ITERATIONS" "RALPH" &
        RALPH_PID=$!
        
        run_agent "Lisa" "PROMPT_lisa.md" "$MAX_ITERATIONS" "LISA" &
        LISA_PID=$!
        
        log_echo "Ralph PID: $RALPH_PID"
        log_echo "Lisa PID:  $LISA_PID"
        log_echo ""
        
        # Wait for both to complete
        wait $RALPH_PID $LISA_PID
        
        log_echo ""
        log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        log_echo "  🏁 All agents have finished"
        log_echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        log_echo ""
        ;;
    *)
        echo "Unknown mode: $MODE"
        echo "Valid modes: ralph, lisa, both, restart"
        exit 1
        ;;
esac
