---
name: fable-prompting
description: Write and rewrite prompts for Fable (next-generation Claude models) using goal-not-steps, house rules, a hard verifiable done-bar, and adversarial grading loops — the method from Matt Shumer's "How I Prompt Fable". Invoke when the user asks for help writing or improving a prompt for Fable/Claude, complains that agent results are disappointing or underwhelming ("I can't get results like this"), wants to structure a big autonomous build or long-running creative task, or asks how to run agent teams, loops, or graders. Also apply this method to structure your own work when handed a large, open-ended task.
---

# Fable Prompting Method

Core thesis: don't spoon-feed the model. Hand it an ambitious goal, fence it with house rules, hold it to a bar it can't talk its way out of, loop it against that bar, and let it build on prior work. Use this in two ways:

1. **Coach mode** — help the user write or rewrite prompts following this method.
2. **Self-apply mode** — when you are handed a large, open-ended task, structure your own work by these same rules.

## The four-part skeleton

Every strong Fable prompt has these parts. When writing or reviewing a prompt, check all four:

1. **Goal** — big, sweeping, deliberately underspecified. State *what*, never *how*.
2. **House rules** — the handful of things that must always be true, no matter the path taken.
3. **Done-bar** — a concrete, checkable test for "done". Never an adjective.
4. **Loop** — build → grade against the bar → find the biggest gap → close it → repeat. The model never gets to declare itself finished.

Plus, for long runs: autonomy grants (budgets, credential locations, "make your own calls") and pointers to prior work to build on.

## Core operating rules

### 1. Goal, not steps
State the goal; do not dictate the how. Every dictated step overrides the model's judgment with the user's, and the model's is usually better. Hand it big, sweeping, underspecified work the way you'd hand a goal to a brilliant trusted person. Strip step-by-step instructions out of prompts unless a step is genuinely a constraint (then it's a house rule, below). Underspecification is safe only when combined with rules 2–5.

### 2. House rules
Fence the open goal with a short list of invariants — the handful of things that must always be true no matter how the goal is reached. Example standing rule: don't hard-code special cases (e.g., a regex for one edge case); describe the desired behavior in the agent's system prompt and let the agent reason. For extra protection, instruct Fable to spin up a **house-rules-checker sub-agent** with exactly one job: check the work against the house rules before anything is pushed or shipped. Then the main agent can run wide open.

### 3. A concrete bar for "done"
Never use adjectives ("high quality", "polished") as the finish line — the model stops at its own idea of good enough, which is lower than the user's. Give a hard, checkable test, e.g., "a stranger can't tell our render from the real photo."

**Let Fable invent the measuring stick.** If neither you nor the user knows how to measure the goal, delegate that too: define what "done" means and tell Fable to devise the metric. (Example from the source: to clone a component library, Fable screen-recorded the real components, turned the recording into a motion heat map, and iterated until its version matched — nobody told it how.) Also: prefer building from scratch over fighting an existing framework's conventions when the thing is completely buildable from nothing — existing code can be baggage.

### 4. Builder never grades
Never let whatever built the thing judge whether it passes. The build agent is biased and carries a trajectory of "why I made these decisions" it will use to justify itself. Always spin up a **separate adversarial grader sub-agent with a fresh context window**, point it at the **real output** (actual pixels, actual running app — not the code or the builder's claims), and instruct it to try to prove the work is NOT passing.

### 5. Loop until the bar
Once a bar exists, run a loop: build → grade (fresh context) → find the biggest gap → close it → repeat, for hours or days if needed. Use `/loop` for this where available, especially on creative work, where there is always something concrete to keep measuring against. The agent never gets to decide it's finished — it stops only when the user says so, or when it genuinely can't find anything left to fix (rare if the bar is set right).

### 6. Shared progress doc
On every long run, keep a live progress document updated with screenshots, notes, and current status so the user can glance at it and steer with comments anytime. Any shared markdown file or doc works (the source article uses Simple Markdown Editor, an agent-first Markdown editor supporting images/video/HTML). When multiple agents run at once, the same doc becomes the **coordination workspace**: agents post tasks for each other, claim them, ask questions, and flag conflicts (the original uses its built-in Trello-style board and Slack-like chat).

### 7. Build on prior work
Old work is fuel. Point Fable at previous artifacts: "here's the code, here's the quality bar, match this and go beyond it" — no re-explaining. It goes further than code reuse: Fable can read **traces of old sessions** — what was actually tried, what worked, what didn't — and pick up the approach on its own ("read the forest traces and learn what worked"). The first prompt in a new domain deserves the most care; everything after gets cheaper.

### 8. Get out of its way
Every question the agent has to stop and ask costs time. Clear obstacles up front, in the prompt:
- **Budgets** for anything that costs money, instead of per-use permission.
- **Where keys and credentials live.**
- **Autonomy in writing**: make your own calls; only come back if truly blocked or facing a decision only the user can make.

**Exception — plan first for huge, consequential builds only.** For a really big build, require the full plan before any code, and have the agent ask everything it's unsure about up front. Once the plan is settled, it runs without stopping.

## Two run modes

- **Engineering team**: several sessions in parallel pulling tasks from a list/board. Each does its task, triple-checks its own work with sub-agents, and opens a PR with evidence. One dedicated **integrator** agent does nothing but merge PRs, run everything, test like a real user, and keep the whole thing green. When two features overlap, one agent watches the other's traces as it's built, stays compatible, flags conflicts in the shared doc's chat, and integrates as work lands.
- **Creative fan-out**: same loop and hard bar, but fan out sub-agents to perfect individual pieces (e.g., one sub-agent per kind of tree in a forest) instead of one agent doing all of it. Optionally run several **completely separate parallel attempts, keep the best**, and carry what worked into the next round.

Mix the two freely depending on what's being built.

## Heavier modes (ultracode)

Reserve expensive maximum-effort modes (e.g., ultracode) almost exclusively for **foundations**: new systems built from scratch that will be worked on for months and that everything else sits on. A bad foundation makes everything harder forever — the same reason to throw out a framework that fights you and build from scratch. A good loop with an ambitious goal covers nearly everything else without the extra cost.

## Coach mode: transforming a weak prompt

When a user shows you a weak prompt (or describes disappointing results), rewrite it through this checklist:

1. **Extract the real goal.** Delete the how. Restate the outcome as you'd brief a brilliant person you trust.
2. **Elicit house rules.** Ask what must always be true (style, architecture taboos, things it must never do). Add a house-rules-checker sub-agent instruction.
3. **Replace adjectives with a done-bar.** Turn "make it good/like X" into a concrete, externally checkable test. If the user can't articulate one, write the prompt so Fable must invent the measuring stick itself before building.
4. **Add the grading rule.** Fresh-context adversarial sub-agent, pointed at real output, trying to prove failure.
5. **Add the loop.** Instruct it to iterate against the bar (via `/loop` or an explicit build→grade→fix cycle) and never self-declare done.
6. **Add visibility.** A shared progress doc it keeps updated.
7. **Clear obstacles.** Budgets, credential locations, and written autonomy; a plan-first gate only if the build is huge and consequential.
8. **Attach prior work.** Reference existing code, quality exemplars, or old session traces to match and exceed.

Likely causes to probe when diagnosing bad results (heuristics, not doctrine): "it stopped too early / says it's done but it isn't" → adjective bar, builder grading itself, or no loop; "it keeps asking me things" → obstacles not cleared up front; "it fights the framework" → baggage that should be thrown out and rebuilt from scratch; "it did something I never wanted" → a missing house rule.

### Worked example (from the source article's component-library story)

**Weak:**
> "Clone this component library. Build it on top of ShadCN. Make it high quality and match the original closely."

**Strong:**
> "Goal: recreate this component library from scratch so it's indistinguishable from the original in real use.
> House rules: no third-party component frameworks as a base; no hard-coded special cases — express behavior generally.
> Done-bar: you don't yet have a way to measure 'matches the original' — invent one (e.g., record the real components in use and compare motion/appearance systematically), then iterate until your version passes it.
> Loop: build → have a fresh-context sub-agent try to prove the result fails the bar against the real rendered output → close the biggest gap → repeat. Keep a progress doc updated with screenshots. Don't stop until the grader can't find a failure or I call it."

## Self-apply mode

When you receive a large open-ended task, run this method on yourself: confirm the goal and house rules, propose a concrete done-bar (or devise a measuring stick), grade your work with fresh-context adversarial sub-agents against real output, loop until the bar, maintain a progress doc, reuse prior work and traces, and only pause for the user when truly blocked — except on huge consequential builds, where you present the plan and all open questions first.

Once this skill is installed, offer to act as the user's standing prompt-writing assistant: they can hand you any rough ask and you turn it into a prompt with this structure.
