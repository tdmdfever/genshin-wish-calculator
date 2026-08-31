# Genshin Impact Wish Calculator

A client-side calculator for Genshin Impact's Character and Weapon Event Wish banners. Enter your current pity/guarantee state, add a priority-ordered list of goals (5★/4★ characters and weapons, with optional constellation/refinement targets), and see your exact odds of completing each prefix of that list over your next pulls — plus a full constellation/refinement breakdown for every 4★ goal.

Odds are computed exactly via dynamic programming, not estimated by simulation — there's no trial count or sampling noise.

## Features

- Character and Weapon Event Wish pity, 50/50, and guarantee mechanics, including the Weapon banner's Epitomized Path (Fate Points)
- Two selectable Capturing Radiance models — HoYoverse has never published the real formula, so both leading community hypotheses are available side by side, not presented as a single confirmed answer
- Priority-ordered goals with opportunistic completion (a lower-priority goal can complete before a higher-priority one if it happens to drop first)
- Per-goal constellation (C0–C6) / refinement (R1–R5) odds, with support for 4★ items shared across a patch's two paired character banners
- Interactive chart with hover, plus an accessible table view

## Getting started

```bash
npm install
npm run dev      # start the dev server
npm run test     # run the test suite
npm run build    # type-check and build for production
```

**New here? Read [HOW_IT_WORKS.md](./HOW_IT_WORKS.md)** — a from-scratch rundown of everything, starting with what a "wish" even is and building all the way up to the exact math (DP recurrences, state encoding, convolution) behind the numbers on screen. No prior familiarity with the game or the code assumed.

For contributors: [ARCHITECTURE.md](./ARCHITECTURE.md) is the shorter, structural-only current-state reference; [CLAUDE.md](./CLAUDE.md) is orientation; [CHANGELOG.md](./CHANGELOG.md) is the full dated development history.

## Accuracy notes

Pity curves, 50/50, and Epitomized Path mechanics are sourced from community research and cross-checked against an independent open-source implementation. Capturing Radiance in particular remains undocumented by HoYoverse — the two models offered here are community estimates, not confirmed rates, and are expected to diverge from each other and possibly from the real game.
