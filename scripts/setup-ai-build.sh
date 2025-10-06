#!/bin/bash

# Setup script for AI Agent Build Process
# This script creates branches and provides prompts for all tasks

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BOLD}${BLUE}🤖 Originals SDK - AI Agent Build Setup${NC}\n"

# Function to print section headers
print_header() {
    echo -e "\n${BOLD}${GREEN}▶ $1${NC}\n"
}

# Function to print info
print_info() {
    echo -e "${BLUE}  $1${NC}"
}

# Function to print warning
print_warning() {
    echo -e "${YELLOW}  ⚠ $1${NC}"
}

# Check if we're in a git repo
if ! git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    echo -e "${YELLOW}Error: Not in a git repository${NC}"
    exit 1
fi

# Check if on main branch
current_branch=$(git branch --show-current)
if [ "$current_branch" != "main" ]; then
    print_warning "Not on main branch (currently on: $current_branch)"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

print_header "Setup Options"
echo "1. Create all branches for parallel execution"
echo "2. Create branch for specific task"
echo "3. Show next recommended task"
echo "4. Generate GitHub issues"
echo "5. Show progress"
echo ""
read -p "Select option (1-5): " option

case $option in
    1)
        print_header "Creating all branches for Phase 1"
        
        branches=(
            "phase-1/task-1.1-event-system"
            "phase-1/task-1.2-validation-framework"
            "phase-1/task-1.3-logging-telemetry"
        )
        
        for branch in "${branches[@]}"; do
            if git show-ref --verify --quiet "refs/heads/$branch"; then
                print_info "Branch $branch already exists"
            else
                git branch "$branch"
                print_info "✓ Created branch: $branch"
            fi
        done
        
        echo ""
        print_info "All Phase 1 branches created!"
        print_info ""
        print_info "Start working on a task:"
        print_info "  git checkout phase-1/task-1.1-event-system"
        print_info ""
        print_info "Then see AI_AGENT_EXECUTION_GUIDE.md for the exact prompt"
        ;;
        
    2)
        print_header "Available Tasks"
        echo ""
        echo "Phase 1: Foundation"
        echo "  1.1 - Event System (no dependencies)"
        echo "  1.2 - Validation Framework (no dependencies)"
        echo "  1.3 - Logging and Telemetry (depends on 1.1)"
        echo ""
        echo "Phase 2: Core Features"
        echo "  2.1 - Batch Operations (depends on 1.1, 1.2)"
        echo "  2.2 - Resource Versioning (depends on 1.2)"
        echo "  2.3 - Provenance Query (no dependencies)"
        echo ""
        echo "Phase 3: Security"
        echo "  3.1 - Key Rotation (depends on 1.1)"
        echo "  3.2 - Fake Asset Detection (depends on 2.3)"
        echo "  3.3 - Front-Running Protection (no dependencies)"
        echo ""
        
        read -p "Enter task number (e.g., 1.1): " task_num
        
        case $task_num in
            "1.1")
                branch_name="phase-1/task-1.1-event-system"
                task_name="Event System"
                ;;
            "1.2")
                branch_name="phase-1/task-1.2-validation-framework"
                task_name="Validation Framework"
                ;;
            "1.3")
                branch_name="phase-1/task-1.3-logging-telemetry"
                task_name="Logging and Telemetry"
                ;;
            "2.1")
                branch_name="phase-2/task-2.1-batch-operations"
                task_name="Batch Operations"
                ;;
            "2.2")
                branch_name="phase-2/task-2.2-resource-versioning"
                task_name="Resource Versioning"
                ;;
            "2.3")
                branch_name="phase-2/task-2.3-provenance-query"
                task_name="Provenance Query"
                ;;
            "3.1")
                branch_name="phase-3/task-3.1-key-rotation"
                task_name="Key Rotation"
                ;;
            "3.2")
                branch_name="phase-3/task-3.2-fake-asset-detection"
                task_name="Fake Asset Detection"
                ;;
            "3.3")
                branch_name="phase-3/task-3.3-front-running-protection"
                task_name="Front-Running Protection"
                ;;
            *)
                print_warning "Invalid task number"
                exit 1
                ;;
        esac
        
        if git show-ref --verify --quiet "refs/heads/$branch_name"; then
            print_warning "Branch $branch_name already exists"
            read -p "Check it out anyway? (y/n) " -n 1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                git checkout "$branch_name"
            fi
        else
            git checkout -b "$branch_name"
            print_info "✓ Created and checked out branch: $branch_name"
        fi
        
        echo ""
        print_info "📋 Next steps for Task $task_num: $task_name"
        print_info ""
        print_info "1. Read AI_AGENT_EXECUTION_GUIDE.md → Task $task_num"
        print_info "2. Copy the exact prompt for this task"
        print_info "3. Provide the required context files to your AI agent"
        print_info "4. Let the agent implement"
        print_info "5. Validate with: bun test"
        print_info "6. Create PR when complete"
        ;;
        
    3)
        print_header "Next Recommended Task"
        
        # Check which branches exist to determine what's been done
        if ! git show-ref --verify --quiet "refs/heads/phase-1/task-1.1-event-system"; then
            echo ""
            print_info "👉 Start with Task 1.1: Event System"
            print_info ""
            print_info "Why: No dependencies, foundational feature, teaches the process"
            print_info ""
            print_info "To start:"
            print_info "  git checkout -b phase-1/task-1.1-event-system"
            print_info "  # Then see AI_AGENT_EXECUTION_GUIDE.md → Task 1.1"
        elif ! git show-ref --verify --quiet "refs/heads/phase-1/task-1.2-validation-framework"; then
            echo ""
            print_info "👉 Next: Task 1.2: Validation Framework"
            print_info ""
            print_info "Why: No dependencies, can run in parallel with 1.1 or after"
            print_info ""
            print_info "To start:"
            print_info "  git checkout -b phase-1/task-1.2-validation-framework"
            print_info "  # Then see AI_AGENT_EXECUTION_GUIDE.md → Task 1.2"
        elif ! git show-ref --verify --quiet "refs/heads/phase-1/task-1.3-logging-telemetry"; then
            echo ""
            print_info "👉 Next: Task 1.3: Logging and Telemetry"
            print_info ""
            print_info "Why: Completes Phase 1, depends on 1.1 which should be done"
            print_info ""
            print_info "To start:"
            print_info "  git checkout -b phase-1/task-1.3-logging-telemetry"
            print_info "  # Then see AI_AGENT_EXECUTION_GUIDE.md → Task 1.3"
        else
            echo ""
            print_info "👉 Phase 1 branches created! Time for Phase 2"
            print_info ""
            print_info "Recommended next tasks (can do in parallel):"
            print_info "  - Task 2.1: Batch Operations (HIGH VALUE)"
            print_info "  - Task 2.2: Resource Versioning"
            print_info "  - Task 2.3: Provenance Query"
            print_info ""
            print_info "To start Task 2.1:"
            print_info "  git checkout -b phase-2/task-2.1-batch-operations"
        fi
        ;;
        
    4)
        print_header "Generate GitHub Issues"
        
        cat > /tmp/github-issues.md << 'EOF'
# GitHub Issues for Asset Layer Build

## Phase 1: Foundation

### Issue: Task 1.1 - Event System Implementation
**Labels**: enhancement, phase-1, high-priority

**Description**:
Implement a type-safe event system for asset lifecycle operations.

**Requirements**:
- Create EventEmitter class
- Define event types for all lifecycle operations
- Integrate into OriginalsAsset and LifecycleManager
- Write comprehensive tests
- Document in EVENTS.md

**Success Criteria**:
- [ ] All tests pass
- [ ] Event emission overhead <1ms
- [ ] Type-safe event definitions
- [ ] Documentation complete

**Resources**:
- See `AI_AGENT_EXECUTION_GUIDE.md` → Task 1.1
- Branch: `phase-1/task-1.1-event-system`

---

### Issue: Task 1.2 - Validation Framework Enhancement
**Labels**: enhancement, phase-1, high-priority

**Description**:
Enhance validation framework with detailed feedback and dry-run capabilities.

**Requirements**:
- Create ValidationResult class
- Add detailed error reporting
- Implement dry-run methods
- Add cost estimation
- Document all error codes

**Success Criteria**:
- [ ] All tests pass
- [ ] No breaking changes
- [ ] Dry-run methods work
- [ ] Cost estimation accurate

**Resources**:
- See `AI_AGENT_EXECUTION_GUIDE.md` → Task 1.2
- Branch: `phase-1/task-1.2-validation-framework`

---

### Issue: Task 1.3 - Logging and Telemetry Enhancement
**Labels**: enhancement, phase-1, medium-priority

**Description**:
Enhance logging and telemetry for production observability.

**Requirements**:
- Create Logger class
- Create MetricsCollector
- Integrate with event system
- Add to OriginalsSDK

**Success Criteria**:
- [ ] Tests pass
- [ ] Performance overhead <1ms
- [ ] Metrics accurate
- [ ] Event integration works

**Dependencies**: Task 1.1 (Event System)

**Resources**:
- See `AI_AGENT_EXECUTION_GUIDE.md` → Task 1.3
- Branch: `phase-1/task-1.3-logging-telemetry`

---

## Phase 2: Core Features

### Issue: Task 2.1 - Batch Operations
**Labels**: enhancement, phase-2, high-priority, high-value

**Description**:
Implement batch operations for efficient processing of multiple assets.

**Requirements**:
- Create BatchOperationExecutor
- Add batch methods to LifecycleManager
- Implement single-transaction batch inscription
- Comprehensive error handling

**Success Criteria**:
- [ ] All tests pass
- [ ] Batch inscription saves 30%+ on fees
- [ ] Error handling works
- [ ] Documentation complete

**Dependencies**: Task 1.1, Task 1.2

**Resources**:
- See `AI_AGENT_EXECUTION_GUIDE.md` → Task 2.1
- Branch: `phase-2/task-2.1-batch-operations`

---

(Continue for all tasks...)

EOF
        
        print_info "GitHub issues template created at: /tmp/github-issues.md"
        print_info ""
        print_info "Copy issues from this file to GitHub:"
        print_info "  cat /tmp/github-issues.md"
        print_info ""
        print_info "Or create issues via GitHub CLI:"
        print_info "  gh issue create --title \"Task 1.1: Event System\" --body-file issue-1.1.md"
        ;;
        
    5)
        print_header "Build Progress"
        
        echo ""
        echo "Phase 1: Foundation"
        
        # Check branch status
        check_branch() {
            local branch=$1
            local task=$2
            if git show-ref --verify --quiet "refs/heads/$branch"; then
                # Check if merged to main
                if git branch --merged main | grep -q "$branch"; then
                    echo "  ✓ $task - Complete (merged)"
                else
                    echo "  ⧗ $task - In Progress"
                fi
            else
                echo "  ○ $task - Not Started"
            fi
        }
        
        check_branch "phase-1/task-1.1-event-system" "Task 1.1: Event System"
        check_branch "phase-1/task-1.2-validation-framework" "Task 1.2: Validation Framework"
        check_branch "phase-1/task-1.3-logging-telemetry" "Task 1.3: Logging and Telemetry"
        
        echo ""
        echo "Phase 2: Core Features"
        check_branch "phase-2/task-2.1-batch-operations" "Task 2.1: Batch Operations"
        check_branch "phase-2/task-2.2-resource-versioning" "Task 2.2: Resource Versioning"
        check_branch "phase-2/task-2.3-provenance-query" "Task 2.3: Provenance Query"
        
        echo ""
        echo "Phase 3: Security"
        check_branch "phase-3/task-3.1-key-rotation" "Task 3.1: Key Rotation"
        check_branch "phase-3/task-3.2-fake-asset-detection" "Task 3.2: Fake Asset Detection"
        check_branch "phase-3/task-3.3-front-running-protection" "Task 3.3: Front-Running Protection"
        
        echo ""
        print_info "Legend:"
        print_info "  ✓ Complete (merged to main)"
        print_info "  ⧗ In Progress (branch exists)"
        print_info "  ○ Not Started"
        ;;
        
    *)
        print_warning "Invalid option"
        exit 1
        ;;
esac

echo ""
print_header "Resources"
print_info "📖 AI_AGENT_BUILD_PLAN.md - Overall plan and task details"
print_info "🤖 AI_AGENT_EXECUTION_GUIDE.md - Exact prompts for each task"
print_info "🚀 AI_AGENT_QUICKSTART.md - Quick start guide"
print_info "📋 ASSET_LAYER_DISCUSSION.md - Context and architecture"
echo ""

print_info "${GREEN}Ready to build! 🚀${NC}"
