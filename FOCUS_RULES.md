# Focus-switching rulebook

This is a reference for answering "given this goal list, what does the engine assume a
player actually does, pull by pull?" — without having to poke at the dev server to find
out. It's a companion to CLAUDE.md's Architecture section, which explains *why* the code
is shaped the way it is; this document is organized instead around *what to expect* for
a given scenario, as a lookup tool.

If you're checking a new scenario and this document doesn't clearly answer it, that's a
sign either the rulebook needs a new entry or the engine has a gap — in either case, add
an [invariant test](src/engine/__tests__/invariants.test.ts) (see "How this gets tested"
below) rather than only checking it by hand in the dev server; the whole reason this
document and that test file exist is that dev-server casework doesn't leave anything
behind to prevent the next regression.

## The model, in one paragraph

Goals are pursued in strict priority order. "Priority order" doesn't just mean "which
goal's odds get reported first" — it's the mechanism that determines *when a player
switches which banner they're pulling on*: banner focus is always "the banner of the
highest-priority goal that isn't done yet," full stop, no exceptions and no
optimization/lookahead. Everything below is about the two things that make this richer
than a naive reading suggests: (1) goals on the *same* banner as the current focus can
get satisfied opportunistically, out of priority order, while pulling toward whichever
goal is nominally "in focus"; and (2) 4★/weapon-identity items have their own rules for
*how long* they stay eligible for that opportunistic accrual.

## Step 1 — priority order becomes phases

Group the goal list into maximal runs of consecutive same-banner goals. Each run is a
**phase**. Focus only ever switches banners at a phase boundary — this is forced by the
one-paragraph model above: since focus is "the banner of the highest-priority incomplete
goal," and that only changes when you run out of incomplete goals on the current banner,
a phase can't end until literally every goal inside it is done.

```
Odette(char) → Weapon(weapon) → Alyosha(char) → Miko(char)
   phase 0        phase 1          phase 2 (Alyosha AND Miko, merged — same banner, adjacent)
```

## Step 2 — within a phase, who gets checked on every pull?

Every pull on the phase's banner is checked against **every not-yet-done goal on that
banner**, not just the current phase's own goals, and not sequentially by priority
within the phase either — with different matching rules per goal kind:

| Goal kind | Matching | Scope |
|---|---|---|
| `5star_character` | Identity-agnostic (any featured win) — see CLAUDE.md's "Why 5★ character goals ignore identity" | **Phase-local FIFO**: the earliest pending `5star_character` goal *in this phase* claims the next featured win. Resets every phase — a `5star_character` goal in a *different* phase is a separate, later win, never satisfied by an earlier phase's pulls. |
| `4star_character` / `4star_weapon` | Identity-specific (`targetId` must match) | **Persistent + anchor-gated** (Step 3) — can accrue on any pull of that banner *while its window is open*, regardless of which phase its own priority slot lands in. |
| `5star_weapon` | Identity-specific (`targetId` must match) | **Persistent, but always scoped to its own single phase** — never opportunistic across phases, unlike 4★s (see "Why 5★ weapons don't get an anchor field" below). |

## Step 3 — when does focus actually move on? (the crux)

This is the part that's easy to get wrong by intuition, and the part every worked
example below is really about.

**Rule A — a phase can't end until every one of its own goals is done.** Not just the
top-priority one. If `[Odette, Alyosha]` are both in phase 0, phase 0 doesn't end (focus
doesn't move to phase 1) until Odette **and** Alyosha are both satisfied, even though
Odette is higher priority.

**Rule B — within a phase, a 5★-character claim can be *blocked*, not just delayed.**
If some 4★ in this same phase is anchored *only* to already-claimed 5★(s) — not also to
the upcoming one — and hasn't reached its own target yet, the next featured win doesn't
advance to the next 5★ at all; it's wasted as a repeat of the current one. This is what
makes "anchored to one banner" and "anchored to both" behaviorally different when two
5★s share a phase — see the worked example below. Implementation:
`goalTracking.ts`'s `isNextFiveStarClaimBlocked`.

**Rule C — a 4★'s accrual window has both an opening edge and a closing edge**, and both
depend on its anchors:

- *Same-phase anchor* (an anchor that's one of THIS phase's own 5★s): the window opens
  only once phase-internal focus (Rule B's "current claimed rank," possibly held up by
  Rule B itself) reaches that specific 5★'s rank, and closes once focus moves past it —
  UNLESS a later anchor in the same phase keeps it open longer.
- *Anchor in a different phase*: the window is closed everywhere except between (Rule C combines Steps 1–2's phase indices) the earliest and latest anchor's phase, inclusive.
  Outside that range in either direction — too early (anchor's phase hasn't started) or
  too late (every anchor's phase has already fully resolved) — no accrual happens at
  all, no matter how many pulls land on that banner.
- *Unanchored*: no restriction at all — open for the banner's entire lifetime in the
  goal list. This requires 0 or 1 total `5star_character` goals (character) or at most 1
  distinct weapon-banner phase (weapon) in the list; otherwise an anchor is *required*,
  precisely because the engine can't otherwise know which window you mean.

**Rule D — 5★-weapon identity has no Rule-C equivalent at all.** A `5star_weapon` goal
is always scoped to exactly the one phase it's positioned in — never opportunistic
across phases, never anchored, never "unrestricted." See "Why 5★ weapons don't get an
anchor field" below for why this is simpler than the 4★ case, not an oversight.

## Worked example — the case you asked about

Goal list: `Odette(5★) → Alyosha(4★) → Miko(5★)`, all one phase (character banner,
consecutive, no weapon-banner detour in between).

**If Alyosha is anchored to `[Odette, Miko]` (both):**
1. Pull on the character banner. Any featured win before Odette's own is claimed
   claims Odette's rank (Rule B: nothing blocks it, since Alyosha's anchors include the
   *upcoming* rank too — see the `anchors.includes(nextGoalId)` early-exit in
   `isNextFiveStarClaimBlocked`).
2. The instant Odette is won, the next featured win is free to claim Miko's rank
   immediately — **even if Alyosha hasn't reached her own target yet.** Nothing is
   holding up the FIFO counter.
3. Alyosha keeps accruing copies the whole time, through *both* Odette's pulls and
   Miko's pulls (Rule C: both ranks are her anchors, so her window spans the entire
   phase), but her own progress never gates when Miko is claimed.
4. The phase only ends (Rule A) once Odette AND Alyosha AND Miko are *all* done — so if
   Alyosha is still short of target after Miko drops, pulling continues (still on this
   banner) until she catches up, but that pulling is "for Alyosha," not "for Miko."

**If Alyosha is anchored to `[Odette]` only:**
1. Same as above through Odette's win.
2. Now the next featured win is checked against Rule B: Alyosha is anchored *only* to
   the already-claimed Odette, not to the upcoming Miko rank, and (suppose) hasn't hit
   her target yet — so the claim is **blocked**. That featured win doesn't advance the
   FIFO counter; it's absorbed as "just another copy of Odette" and, incidentally, is
   also another opportunity for Alyosha to accrue (Rule C: focus is still "on Odette's
   rank" the whole time she's blocking).
3. This repeats — every featured win is wasted this way — until Alyosha finally reaches
   her target. *Only then* does the next featured win actually claim Miko's rank.
4. Once focus moves to Miko, Alyosha's window closes (Rule C: Miko's rank isn't one of
   her anchors) — she stops accruing, for good, for this simulation.

**Consequence, confirmed by [invariants.test.ts](src/engine/__tests__/invariants.test.ts):**
anchored-to-both always reaches every one of Alyosha's own constellation levels with
probability ≥ anchored-to-Odette-only (wider window, strictly more chances), AND the
*full chain* (Odette + Alyosha + Miko all done) also completes with probability ≥ in the
anchored-to-both case (nothing ever blocks Miko's claim there). Both directions are
tested explicitly, not just asserted in prose.

## Quick-reference: what changes what

| Change | Effect on the goal it's applied to | Effect on goals *after* it in priority |
|---|---|---|
| Add an anchor (narrow the window) | Can only reduce or match its own odds at every level | Can only slow down or match completion (via Rule B blocking) |
| Add a second anchor (widen from one to both) | Can only increase or match its own odds | Can only speed up or match completion |
| Raise `targetLevel` | N/A (defines "done" for this goal) | Can only slow down or match completion — more pulls "reserved" for this goal before focus can move on |
| Lower `targetLevel` | N/A | Can only speed up or match completion |
| Append a new goal at lower priority | No effect at all (exact equality, not just monotonic) | N/A — it IS the later goal |
| Increase pull budget | Every probability is non-decreasing | Same |

Every row here is one of the invariant tests, not just a claim — see the next section.

## Why 5★ weapons don't get an anchor field

It's tempting to think weapon 5★s need the same anchoring machinery as 4★s, since both
are identity-specific and both can coexist with something else on the same banner. They
don't, for a structural reason: a `5star_weapon` goal's *identity* already uniquely
determines which phase it belongs to (each phase runs exactly one weapon banner, with
its own distinct chosen/other-featured pair) — there's no ambiguity to resolve the way
there is for a 4★ that might legitimately be featured across two *different* phases'
rosters. So instead of an opt-in anchor, every `5star_weapon` goal is unconditionally
scoped to its own natal phase (`phases.ts`'s
`computeClosedFiveStarWeaponTargetIdsForPhase`) — always on, no configuration needed,
and no "unanchored = unrestricted" case to speak of, because being featured on two
different phases' weapon banners simultaneously isn't a thing that happens in the real
game the way a repeated 4★ across two phases can.

## How this gets tested

Four layers. The first three all tell you WHETHER the numbers are right; the fourth is
different in kind — it's the only one that tells you WHY, which matters because none of
the other three can be read for intent at a glance.

1. **Cross-validation** (`exactEngine.test.ts`) — the exact DP engine vs. an independent
   Monte Carlo implementation (`simulate.ts`) on the same input. Proves the two agree.
   Does **not** prove either one matches the rules above, since both were written
   against the same understanding of those rules — a shared conceptual error would pass
   every cross-validation test.
2. **Invariants** (`invariants.test.ts`) — logical relationships between two *related*
   runs of the exact engine alone (see the table above), each one following directly
   from the rules in this document, not from either implementation's internals. These
   catch exactly the class of bug cross-validation can't: a shared conceptual error that
   nonetheless breaks a relationship like "wider window can't give worse odds."
3. **Regression tests, numbered as "Nth reported bug"** (`exactEngine.test.ts`,
   `goalTracking.test.ts`) — each one pins down a *specific* scenario that was once
   computed wrong, with a comment explaining what broke and why. These exist because
   invariant tests weren't designed until after several of these bugs were found by hand
   in the dev server; if you find a new one that way, the fix belongs here as a new
   numbered case, not just in memory.
4. **Intent verification / trace tool** (`trace.ts`, examples in `trace.test.ts`) — runs
   ONE concrete, reproducible pull-by-pull playthrough of a goal list (reusing
   `simulate.ts`'s own `stepOnePull`, not a parallel reimplementation) and narrates it in
   plain language: which banner is in focus and why, every copy gained, every win claimed
   or wasted/blocked with a stated reason, every phase-focus change. Run
   `npx vitest run trace --reporter=verbose` and read the printed log for a goal list
   you're unsure about — this is what to reach for INSTEAD of manually adding goals to
   the dev server and squinting at a chart shape, since a numeric answer (even a *correct*
   one) doesn't show you the reasoning that produced it, and a wrong one doesn't tell you
   where the reasoning diverged from what you expected. The three layers above can tell
   you a number is wrong; only this one helps you see *why*, at the same level of detail
   a human would reason about "does this make sense for this priority."

None of these four replaces manual dev-server exploration entirely — they narrow what you
need to hand-check to genuinely novel scenario *shapes*, not variations on shapes already
covered above, and the trace tool specifically narrows how long that hand-check takes.
