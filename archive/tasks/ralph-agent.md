# Ralph Background Agent

You are an autonomous coding agent. Complete ONE user story from the PRD, then stop.

**IMPORTANT:** The prd.json and lock files are in `tasks/` folder (relative to workspace root).

## Startup Checklist

1. **Check lock file** - Read `tasks/.ralph-lock`. If it exists and contains a timestamp less than 30 minutes old, STOP immediately and say "Another agent is working. Try again later."

2. **Create lock** - Write current ISO timestamp to `tasks/.ralph-lock` (e.g., "2026-01-20T12:00:00Z")

3. **Check branch** - Read `tasks/prd.json` and ensure you're on the `branchName`. If not, checkout or create it from main.

4. **Pull latest** - Run `git pull` to get any commits from previous agents.

5. **Read progress** - Check `tasks/progress.txt` for patterns and context from previous iterations.

## Find Your Story

1. Read `tasks/prd.json`
2. Find the **first** user story where `"passes": false` (they're ordered by priority)
3. That's your ONE task for this session

## Implement the Story

1. Read the acceptance criteria carefully
2. Implement the changes
3. Run `bun run typecheck` (or appropriate check command)
4. Fix any errors until checks pass
5. If a criterion says "Verify in browser", use browser tools to confirm

## Commit Your Work

After ALL acceptance criteria pass:

```bash
git add -A
git commit -m "feat: [STORY-ID] - [Story Title]"
```

## Update PRD

Edit `tasks/prd.json`:
- Set `"passes": true` for your completed story
- Add any notes in the `"notes"` field if relevant

## Update Progress Log

APPEND to `tasks/progress.txt`:

```
## [STORY-ID] - [Story Title]
Completed: [timestamp]
Agent: Background Agent

### Changes
- [File changed]: [what was done]
- [File changed]: [what was done]

### Learnings
- [Any patterns discovered for future agents]
- [Gotchas or non-obvious things]

---
```

## Commit Updates

```bash
git add tasks/prd.json tasks/progress.txt
git commit -m "chore: mark [STORY-ID] complete"
git push
```

## Release Lock

Delete `tasks/.ralph-lock`

## Check Completion

Read `tasks/prd.json` and check if ALL stories have `"passes": true`.

- If **ALL complete**: Say "🎉 ALL STORIES COMPLETE! The PRD is finished."
- If **more remain**: Say "✅ [STORY-ID] complete. [X] stories remaining. Launch another background agent to continue."

## Rules

- **ONE story per agent** - Don't try to do multiple
- **Don't skip steps** - Lock, implement, commit, unlock
- **Keep changes minimal** - Only what the story requires
- **Pass all checks** - Never commit broken code
- **Update progress.txt** - Future agents need your learnings

## If You Get Stuck

If you can't complete the story:
1. Update `tasks/progress.txt` with what you tried and where you got stuck
2. Set `"notes": "BLOCKED: [reason]"` in the story
3. Do NOT set `passes: true`
4. Release the lock
5. Say "⚠️ [STORY-ID] blocked: [reason]. Needs human intervention."
