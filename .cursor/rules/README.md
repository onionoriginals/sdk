# 📚 Cursor Rules Reference

Quick guide to using the workspace rules effectively.

---

## 🎯 The Three Rule System

### 1️⃣ @create-prd - Start New Features
**Use when:** Beginning a new feature/project

**What it does:**
- Asks clarifying questions
- Creates detailed PRD
- Saves to `tasks/prd-[name].md`

**Example:**
```
User: "Add user authentication"
AI: [Asks 5-8 questions about auth requirements]
User: [Answers]
AI: [Creates tasks/prd-user-authentication.md]
```

---

### 2️⃣ @tasks - Track Implementation
**Use when:** Implementing a PRD

**What it does:**
- Creates task list with checkboxes
- Tracks completion per task
- Maintains "Relevant Files" section
- Pauses after each major task

**Example:**
```
User: "@tasks Create task list for authentication PRD"
AI: [Creates tasks/task-user-authentication.md with all subtasks]
AI: [Starts Task 1.1, completes, marks [x], pauses]
```

---

### 3️⃣ @continue - Resume Work
**Use when:** Picking up mid-project (new context window, new session)

**What it does:**
- Finds PRD and task list
- Assesses what's complete
- Verifies actual state (doesn't trust checkboxes)
- Identifies next task
- Asks for confirmation before continuing

**Example:**
```
User: "@continue"
AI: 
  📍 Project: Port Bitcoin Transactions
  ✅ Completed: Tasks 1.1-1.5 (verified)
  🎯 Current: Task 1.6 (Port Commit Transaction)
  └─ Next: Sub-task 1.6a - Copy source file
  
  Ready to continue?

User: "yes"
AI: [Resumes implementation from Task 1.6a]
```

---

## 🔄 Complete Workflow

### Starting Fresh
```
1. User: "Add batch import feature"
2. Tag @create-prd
3. AI asks questions → User answers → AI creates PRD
4. User: "@tasks Create task list"
5. AI creates detailed task list
6. AI starts Task 1.1, completes, pauses
7. User: "continue"
8. AI continues to Task 1.2
```

### Resuming After Break
```
1. User: "@continue" (in new session)
2. AI:
   - Reads tasks/task-batch-import.md
   - Sees Tasks 1.1-1.3 are [x]
   - Verifies files exist
   - Notes Task 1.4 is next
   - Asks for confirmation
3. User: "proceed"
4. AI continues from Task 1.4
```

---

## 📋 Rule Combinations

### Combo 1: Start → Implement → Handoff
```
Session 1:
  @create-prd → PRD created
  @tasks → Task list created
  [Implement Tasks 1.1-1.5]

Session 2 (new agent):
  @continue → Picks up at Task 1.6
  [Implement Tasks 1.6-2.0]
```

### Combo 2: Questions + Implementation
```
User: "@questions Add login button"
AI: [Asks questions about styling, behavior, etc.]
User: [Answers]
AI: [Implements with clarifications]
```

### Combo 3: Resume + Questions
```
User: "@continue but let me review each task"
AI: [Shows current state]
User: "@questions for Task 1.6"
AI: [Asks clarifying questions about Task 1.6]
User: [Answers]
AI: [Implements Task 1.6 with clarifications]
```

---

## 🎯 Quick Command Reference

| Goal | Command | What Happens |
|------|---------|--------------|
| Start new feature | `@create-prd [idea]` | Questions → PRD |
| Create tasks | `@tasks` | Task list with subtasks |
| Resume work | `@continue` | Assess state → continue |
| Need clarification | `@questions [task]` | Ask before coding |
| All three | `@create-prd @tasks @continue` | Full workflow |

---

## 📝 File Organization

```
tasks/
├── prd-feature-name.md          ← PRD (requirements)
├── task-feature-name.md         ← Task list (checkboxes)
└── results-feature-name.md      ← Results (when done)
```

**Naming convention:** Use same `[feature-name]` for all related files

---

## 💡 Pro Tips

### For Long Projects
1. Use @continue every new session
2. Update "Current Status" section in task list
3. Commit after each major task
4. Keep Notes section updated with decisions

### For Team Handoffs
1. Update task list before switching
2. Add note about what's in progress
3. Next person uses @continue
4. Seamless transition!

### For Complex Tasks
1. Use @questions before each major task
2. Clarify approach before implementing
3. Reduces rework

---

## 🔧 Troubleshooting

**Problem:** @continue can't find task list  
**Solution:** Ensure file is in `tasks/` directory with pattern `task-*.md`

**Problem:** @continue says state doesn't match checkboxes  
**Solution:** Review "Relevant Files" to see what actually exists

**Problem:** Task list not updating  
**Solution:** AI should update after each task - remind it of @tasks protocol

---

**Need Help?** Tag the relevant rule and ask for guidance! 🚀

