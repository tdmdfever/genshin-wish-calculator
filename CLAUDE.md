# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Genshin Impact gacha wish calculator. Given your current pity/guarantee state on the Character and Weapon Event Wish banners plus a priority-ordered list of goals (5★/4★ characters and weapons, with optional constellation/refinement targets), it computes exact — not simulated — probabilities of completing each prefix of your goal list by every pull count up to your budget, plus a full constellation/refinement breakdown for every 4★ goal. Client-side only, no backend.

## Where things live

This file is intentionally short — it's orientation, not reference. Two companion docs carry the depth:

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the engine actually works right now: phase decomposition, the exact-DP algorithm, goal-tracking semantics, banner mechanics, performance architecture, known limitations. Start here for "how does X work" or "why is the code shaped this way." Current-state only — no bug-by-bug narrative.
- **[CHANGELOG.md](CHANGELOG.md)** — the full, dated, session-by-session development history: every bug found and fixed, every performance investigation, every design decision and the reasoning/measurement behind it, in its original narrative form. Start here for "why did we decide X" in more depth than ARCHITECTURE.md's summary, or to see the full story behind a specific fix. (This used to be the entire contents of this file, before a 2026-08-21 split — see its own header for why.)
- **[FOCUS_RULES.md](FOCUS_RULES.md)** — a lookup reference for exactly what the engine assumes a player does, pull by pull (when banner focus switches, when a 4★'s accrual window opens/closes, and why). Companion to ARCHITECTURE.md's prose.

If you're about to touch `phaseDp.ts`/`exactEngine.ts`'s core loop, or change goal-matching/tracking semantics, read ARCHITECTURE.md's "Known limitations" section first — several non-obvious tradeoffs are already deliberately, measurably decided, and re-deriving them from scratch wastes a session that a five-minute read would save.

## Load-bearing constraints — don't relitigate these without new measurement

- `MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER` (`goalValidation.ts`) = 3 character / 4 weapon. This is a *performance* cap, not a correctness one — raising it needs a real profiling pass first (see ARCHITECTURE.md's "Performance architecture"), and likely a deeper fix (phase-scoped, not banner-wide, `PersistentSpec`) rather than a bigger constant.
- `MAX_ACTIVE_FOUR_STAR_GOALS_PER_PHASE` = 3 character / 5 weapon — this one IS correctness-motivated (the real per-phase roster size) and shouldn't move at all.
- `MAX_DISCONNECTED_FOUR_STAR_GOALS_PER_BANNER` = 2 character / 3 weapon, and `MAX_CONTINUATION_HORIZON_PULLS` = 400 — both performance caps with their own measured justification in `goalValidation.ts`/`exactEngine.ts`'s own doc comments.
- The `crCounter`/persistent-vector time-marginalization residual (up to ~8pp in adversarial deep-target-compounding cases) is a known, accepted architectural limitation, not a bug — deliberately left unfixed per explicit user decision. Don't attempt to fix it without a fresh ask; a real fix is a substantial architectural change (see CHANGELOG.md's "twelfth reported bug" entries for the full diagnostic trail if you need it).
- "Resume the DP on a pull-budget increase" was investigated via a full plan-mode design pass and directly measured — the residual it would introduce (10-38 percentage points in the tested adversarial case) was far too large to accept, and abandoned per explicit user decision (2026-08-21). Don't re-attempt without new measurement showing the underlying architecture has changed.
- When you change goal-matching or tracking semantics, mirror the change in BOTH `exactEngine.ts`/`phaseDp.ts` (exact) and `simulate.ts` (Monte Carlo) — the tests will (correctly) start disagreeing otherwise.

## Commands

- `npm run dev` — start the Vite dev server
- `npm run build` — type-check (`tsc -b`) then production build
- `npm run test` / `npx vitest run` — run the full test suite (all tests live in `src/engine/__tests__/`)
- `npx vitest run <pattern>` — run one test file, e.g. `npx vitest run exactEngine`
- `npx tsc -b` — type-check only, no build
- `npm run lint` — oxlint

Some tests — mostly in `exactEngine.test.ts`, but also `invariants.test.ts`, `oddsAudit.test.ts`, and `sliceResult.test.ts`'s own most adversarial case — run full exact-DP computations and are slow (several seconds each) — they carry explicit per-test timeouts (`it(..., 30_000)`), and running the whole suite in parallel with other files can push them close to that budget or over it (confirmed directly, 2026-08-30: the same specific tests can time out under parallel-file contention even with zero engine changes in flight — a single flaky-looking run in CI or locally isn't on its own evidence of a regression; isolate and time the specific failing test alone before concluding one). If you add a similarly expensive test, give it a generous explicit timeout rather than relying on the default.
