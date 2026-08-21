import { describe, expect, it } from 'vitest';
import {
  buildPersistentSpec,
  buildPhaseLocalSpec,
  copyCountOf,
  decodeVector,
  encodeVector,
  isGoalDone,
  isPhaseFullyDone,
  updateGoalTracking,
  zeroVector,
} from '../goalTracking';
import { buildPhases, computeClosedFourStarGoalIdsForPhase } from '../phases';
import type { Goal, PullOutcome } from '../types';

function g(overrides: Partial<Goal>): Goal {
  return { id: 'g', name: 'g', kind: '5star_character', banner: 'character', targetId: 'g', ...overrides };
}

describe('vector encode/decode', () => {
  it('round-trips arbitrary vectors', () => {
    const dims = [3, 8];
    for (let a = 0; a < 3; a++) {
      for (let c = 0; c < 8; c++) {
        const code = encodeVector(dims, [a, c]);
        expect(decodeVector(dims, code)).toEqual([a, c]);
      }
    }
  });
});

describe('5star_character tracking (identity-agnostic, FIFO, phase-local)', () => {
  const goalA = g({ id: 'a', name: 'Mavuika', kind: '5star_character', targetId: 'char5' });
  const goalB = g({ id: 'b', name: 'Mavuika C1', kind: '5star_character', targetId: 'char5' });
  const phaseSpec = buildPhaseLocalSpec([goalA, goalB]);
  const persistentSpec = buildPersistentSpec('character', [goalA, goalB]);
  const featuredWin: PullOutcome = { rarity: 5, kind: 'featured', itemId: 'char5' };

  it('first win satisfies only the first goal', () => {
    const pv = zeroVector(persistentSpec.dims);
    const { phaseVector: v1 } = updateGoalTracking(phaseSpec, persistentSpec, zeroVector(phaseSpec.dims), pv, featuredWin);
    expect(isGoalDone(phaseSpec, persistentSpec, v1, pv, goalA)).toBe(true);
    expect(isGoalDone(phaseSpec, persistentSpec, v1, pv, goalB)).toBe(false);
  });

  it('second win satisfies both', () => {
    const pv = zeroVector(persistentSpec.dims);
    const r1 = updateGoalTracking(phaseSpec, persistentSpec, zeroVector(phaseSpec.dims), pv, featuredWin);
    const r2 = updateGoalTracking(phaseSpec, persistentSpec, r1.phaseVector, r1.persistentVector, featuredWin);
    expect(isGoalDone(phaseSpec, persistentSpec, r2.phaseVector, r2.persistentVector, goalA)).toBe(true);
    expect(isGoalDone(phaseSpec, persistentSpec, r2.phaseVector, r2.persistentVector, goalB)).toBe(true);
    expect(isPhaseFullyDone(phaseSpec, persistentSpec, r2.phaseVector, r2.persistentVector, [goalA, goalB])).toBe(true);
  });

  it('counter is capped at the number of such goals (extra wins are no-ops)', () => {
    let phaseVector = zeroVector(phaseSpec.dims);
    let persistentVector = zeroVector(persistentSpec.dims);
    for (let i = 0; i < 5; i++) {
      const r = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, featuredWin);
      phaseVector = r.phaseVector;
      persistentVector = r.persistentVector;
    }
    expect(phaseVector[0]).toBe(2);
  });
});

describe('5star_weapon tracking (identity-specific, persistent)', () => {
  const chosen = g({ id: 'w1', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' });
  const other = g({ id: 'w2', kind: '5star_weapon', banner: 'weapon', targetId: 'other' });
  const phaseSpec = buildPhaseLocalSpec([chosen, other]);
  const persistentSpec = buildPersistentSpec('weapon', [chosen, other]);

  it('a chosen-weapon win only satisfies the chosen goal', () => {
    const { persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, zeroVector(phaseSpec.dims), zeroVector(persistentSpec.dims), {
      rarity: 5,
      kind: 'featured',
      itemId: 'chosen',
    });
    expect(isGoalDone(phaseSpec, persistentSpec, zeroVector(phaseSpec.dims), persistentVector, chosen)).toBe(true);
    expect(isGoalDone(phaseSpec, persistentSpec, zeroVector(phaseSpec.dims), persistentVector, other)).toBe(false);
  });

  it('an other-weapon win only satisfies the other goal', () => {
    const { persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, zeroVector(phaseSpec.dims), zeroVector(persistentSpec.dims), {
      rarity: 5,
      kind: 'featured_other',
      itemId: 'other',
    });
    expect(isGoalDone(phaseSpec, persistentSpec, zeroVector(phaseSpec.dims), persistentVector, chosen)).toBe(false);
    expect(isGoalDone(phaseSpec, persistentSpec, zeroVector(phaseSpec.dims), persistentVector, other)).toBe(true);
  });
});

describe('4-star copy-count tracking and target levels (persistent)', () => {
  const charGoalC2 = g({ id: 'aino', name: 'Aino', kind: '4star_character', targetId: 'aino', targetLevel: 2 });
  const weaponGoalR3 = g({ id: 'sword', name: 'Sword', kind: '4star_weapon', banner: 'weapon', targetId: 'sword', targetLevel: 3 });
  const charPhase = buildPhaseLocalSpec([charGoalC2]);
  const charPersistent = buildPersistentSpec('character', [charGoalC2]);
  const weaponPhase = buildPhaseLocalSpec([weaponGoalR3]);
  const weaponPersistent = buildPersistentSpec('weapon', [weaponGoalR3]);
  const ainoWin: PullOutcome = { rarity: 4, kind: 'featured', itemId: 'aino' };
  const swordWin: PullOutcome = { rarity: 4, kind: 'featured', itemId: 'sword' };

  it('character goal targetLevel=2 (C2) needs 3 total copies', () => {
    let pv = zeroVector(charPersistent.dims);
    const pzero = zeroVector(charPhase.dims);
    expect(isGoalDone(charPhase, charPersistent, pzero, pv, charGoalC2)).toBe(false);
    pv = updateGoalTracking(charPhase, charPersistent, pzero, pv, ainoWin).persistentVector; // copy 1 = C0
    expect(copyCountOf(charPersistent, pv, 'aino')).toBe(1);
    expect(isGoalDone(charPhase, charPersistent, pzero, pv, charGoalC2)).toBe(false);
    pv = updateGoalTracking(charPhase, charPersistent, pzero, pv, ainoWin).persistentVector; // copy 2 = C1
    expect(isGoalDone(charPhase, charPersistent, pzero, pv, charGoalC2)).toBe(false);
    pv = updateGoalTracking(charPhase, charPersistent, pzero, pv, ainoWin).persistentVector; // copy 3 = C2
    expect(copyCountOf(charPersistent, pv, 'aino')).toBe(3);
    expect(isGoalDone(charPhase, charPersistent, pzero, pv, charGoalC2)).toBe(true);
  });

  it('weapon goal targetLevel=3 (R3) needs 3 total copies', () => {
    let pv = zeroVector(weaponPersistent.dims);
    const pzero = zeroVector(weaponPhase.dims);
    pv = updateGoalTracking(weaponPhase, weaponPersistent, pzero, pv, swordWin).persistentVector; // R1
    pv = updateGoalTracking(weaponPhase, weaponPersistent, pzero, pv, swordWin).persistentVector; // R2
    expect(isGoalDone(weaponPhase, weaponPersistent, pzero, pv, weaponGoalR3)).toBe(false);
    pv = updateGoalTracking(weaponPhase, weaponPersistent, pzero, pv, swordWin).persistentVector; // R3
    expect(copyCountOf(weaponPersistent, pv, 'sword')).toBe(3);
    expect(isGoalDone(weaponPhase, weaponPersistent, pzero, pv, weaponGoalR3)).toBe(true);
  });

  it('character copy count caps at 7 (C6), weapon at 5 (R5)', () => {
    let pv = zeroVector(charPersistent.dims);
    const pzero = zeroVector(charPhase.dims);
    for (let i = 0; i < 10; i++) pv = updateGoalTracking(charPhase, charPersistent, pzero, pv, ainoWin).persistentVector;
    expect(copyCountOf(charPersistent, pv, 'aino')).toBe(7);

    let pvw = zeroVector(weaponPersistent.dims);
    const pzeroW = zeroVector(weaponPhase.dims);
    for (let i = 0; i < 10; i++) pvw = updateGoalTracking(weaponPhase, weaponPersistent, pzeroW, pvw, swordWin).persistentVector;
    expect(copyCountOf(weaponPersistent, pvw, 'sword')).toBe(5);
  });

  it('default target levels: character C0 (1 copy), weapon R1 (1 copy)', () => {
    const charDefault = g({ id: 'x', kind: '4star_character', targetId: 'x' });
    const weaponDefault = g({ id: 'y', kind: '4star_weapon', banner: 'weapon', targetId: 'y' });
    const cPhase = buildPhaseLocalSpec([charDefault]);
    const cPersistent = buildPersistentSpec('character', [charDefault]);
    const wPhase = buildPhaseLocalSpec([weaponDefault]);
    const wPersistent = buildPersistentSpec('weapon', [weaponDefault]);

    let cpv = zeroVector(cPersistent.dims);
    const cpzero = zeroVector(cPhase.dims);
    expect(isGoalDone(cPhase, cPersistent, cpzero, cpv, charDefault)).toBe(false);
    cpv = updateGoalTracking(cPhase, cPersistent, cpzero, cpv, { rarity: 4, kind: 'featured', itemId: 'x' }).persistentVector;
    expect(isGoalDone(cPhase, cPersistent, cpzero, cpv, charDefault)).toBe(true);

    let wpv = zeroVector(wPersistent.dims);
    const wpzero = zeroVector(wPhase.dims);
    expect(isGoalDone(wPhase, wPersistent, wpzero, wpv, weaponDefault)).toBe(false);
    wpv = updateGoalTracking(wPhase, wPersistent, wpzero, wpv, { rarity: 4, kind: 'featured', itemId: 'y' }).persistentVector;
    expect(isGoalDone(wPhase, wPersistent, wpzero, wpv, weaponDefault)).toBe(true);
  });
});

describe('4-star anchored to specific 5-star character goal(s) — per-phase closure, persistent tracking', () => {
  // Linked (sixteenth reported bug, 2026-08-19) since every test in this block
  // relies on Odette+Miko sharing ONE phase — adjacency alone no longer implies
  // that (see types.ts's linkedCharacterGoalId doc comment).
  const odette = g({ id: 'o', name: 'Odette', kind: '5star_character', targetId: 'o', linkedCharacterGoalId: 'm' });
  const miko = g({ id: 'm', name: 'Miko', kind: '5star_character', targetId: 'm', linkedCharacterGoalId: 'o' });
  const weapon = g({ id: 'w', name: 'Weapon', kind: '5star_weapon', banner: 'weapon', targetId: 'w' });
  const featuredOdetteOrMiko: PullOutcome = { rarity: 5, kind: 'featured', itemId: 'irrelevant' }; // identity-agnostic match
  const ainoWin: PullOutcome = { rarity: 4, kind: 'featured', itemId: 'a' };

  it('case B, target ALREADY met when its anchor wins: focus moves on immediately, closing the window right there', () => {
    // Alyosha's target here is the default C0 (1 copy) — already satisfied before
    // Odette even wins. Once Odette wins, nothing is left blocking focus from
    // moving on to Miko, so Alyosha's window closes at that exact point: she can't
    // pick up any more copies after this, since we're no longer "on her patch."
    const alyoshaCaseB = g({ id: 'a', name: 'Alyosha', kind: '4star_character', targetId: 'a', anchoredFiveStarGoalIds: ['o'] });
    const allGoals = [odette, alyoshaCaseB, miko]; // all one phase: consecutive, same banner
    const phases = buildPhases(allGoals);
    expect(phases).toHaveLength(1);
    const phaseSpec = buildPhaseLocalSpec(phases[0].goals);
    const persistentSpec = buildPersistentSpec('character', allGoals);
    const closedGoalIds = computeClosedFourStarGoalIdsForPhase(phases, 0, persistentSpec.fourStarGoals.map((fg) => fg.goal));
    expect(closedGoalIds.has('a')).toBe(false); // anchor shares this phase — the cross-phase closer never applies here

    let phaseVector = zeroVector(phaseSpec.dims);
    let persistentVector = zeroVector(persistentSpec.dims);
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, ainoWin, closedGoalIds)); // 1 copy before Odette's win — target already met
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(1);

    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, featuredOdetteOrMiko, closedGoalIds)); // Odette's win (FIFO) — Alyosha no longer blocks anything, so focus moves to Miko right here
    expect(isGoalDone(phaseSpec, persistentSpec, phaseVector, persistentVector, odette)).toBe(true);

    // No further copies — focus has already moved to Miko's patch.
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, ainoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(1);
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, ainoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(1);
  });

  it('case B, target still PENDING when its anchor wins: window stays open until the target is met, THEN closes', () => {
    // Alyosha needs C1 (2 copies) here — still short after 1 copy, so even once
    // Odette wins, Alyosha herself is the reason focus hasn't moved on yet: her
    // window has to stay open until she personally reaches target.
    const alyoshaC1 = g({ id: 'a', name: 'Alyosha', kind: '4star_character', targetId: 'a', targetLevel: 1, anchoredFiveStarGoalIds: ['o'] });
    const allGoals = [odette, alyoshaC1, miko];
    const phases = buildPhases(allGoals);
    const phaseSpec = buildPhaseLocalSpec(phases[0].goals);
    const persistentSpec = buildPersistentSpec('character', allGoals);
    const closedGoalIds = computeClosedFourStarGoalIdsForPhase(phases, 0, persistentSpec.fourStarGoals.map((fg) => fg.goal));

    let phaseVector = zeroVector(phaseSpec.dims);
    let persistentVector = zeroVector(persistentSpec.dims);
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, ainoWin, closedGoalIds)); // 1 copy
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, featuredOdetteOrMiko, closedGoalIds)); // Odette's win — Alyosha still blocks Miko's claim (only 1/2 copies)
    expect(isGoalDone(phaseSpec, persistentSpec, phaseVector, persistentVector, odette)).toBe(true);

    // Still open — Alyosha's own target isn't met yet, so focus hasn't moved on.
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, ainoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(2); // now C1 — target met

    // NOW focus moves on (nothing left blocking Miko's claim) — further copies stop.
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, ainoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(2);
  });

  it("a 4-star anchored to a LATER same-phase 5-star doesn't accrue until focus actually reaches that patch — the reported bug", () => {
    // Priority: Odette, "41" (anchored to Odette only), Miko, "42" (anchored to
    // Miko only) — all one phase. 42 must NOT start picking up copies just
    // because it shares a phase with Miko; it has to wait until focus has
    // actually moved past Odette+41 and onto Miko's patch. Before this fix, 42
    // accrued unrestricted from pull 1, identically to 41 — making the two
    // indistinguishable even though 42 requires two prior goals to finish first.
    const fortyOne = g({ id: '41', name: '41', kind: '4star_character', targetId: '41', anchoredFiveStarGoalIds: ['o'] });
    const fortyTwo = g({ id: '42', name: '42', kind: '4star_character', targetId: '42', anchoredFiveStarGoalIds: ['m'] });
    const allGoals = [odette, fortyOne, miko, fortyTwo];
    const phases = buildPhases(allGoals);
    expect(phases).toHaveLength(1);
    const phaseSpec = buildPhaseLocalSpec(phases[0].goals);
    const persistentSpec = buildPersistentSpec('character', allGoals);
    const closedGoalIds = computeClosedFourStarGoalIdsForPhase(phases, 0, persistentSpec.fourStarGoals.map((fg) => fg.goal));
    const fortyTwoWin: PullOutcome = { rarity: 4, kind: 'featured', itemId: '42' };
    const fortyOneWin: PullOutcome = { rarity: 4, kind: 'featured', itemId: '41' };

    let phaseVector = zeroVector(phaseSpec.dims);
    let persistentVector = zeroVector(persistentSpec.dims);

    // Before Odette is even won: 42 does not accrue.
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, fortyTwoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, '42')).toBe(0);

    // Odette wins, but 41 isn't done yet (still blocking Miko's claim, so focus
    // is still on Odette's patch) — 42 still shouldn't accrue.
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, featuredOdetteOrMiko, closedGoalIds));
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, fortyTwoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, '42')).toBe(0);

    // 41 reaches its (default C0) target — focus can now move to Miko's patch.
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, fortyOneWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, '41')).toBe(1);

    // Still not open yet — Miko herself hasn't actually been won. Focus is
    // "moving toward" Miko's patch, which IS enough for 42 to start counting
    // (you don't need to have already won Miko to be pulling on her patch).
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, fortyTwoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, '42')).toBe(1);

    // And 41's window has now closed — no more copies for her.
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, fortyOneWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, '41')).toBe(1);
  });

  // UPDATE (2026-08-19, "4★ anchoring is phase-derived" fix): leaving a 4-star
  // unanchored while 2+ same-kind 5-stars exist elsewhere in the list is now a
  // deliberate "disconnected from everything currently listed" choice (issue
  // 1.5.5), not "no restriction, counts everywhere" — see
  // computeClosedFourStarGoalIdsForPhase's own doc comment.
  it('unanchored 4-star, with another same-kind 5-star present in a genuinely DISTINCT (unlinked) phase, is deliberately disconnected — never counts', () => {
    // Deliberately fresh, UNLINKED goals here — this describe block's shared
    // `odette`/`miko` fixtures are mutually linked (simultaneous, one phase),
    // which is the wrong shape for testing "2+ DISTINCT phases" disconnection.
    const odetteUnlinked = g({ id: 'ou', name: 'Odette', kind: '5star_character', targetId: 'ou' });
    const mikoUnlinked = g({ id: 'mu', name: 'Miko', kind: '5star_character', targetId: 'mu' });
    const alyoshaUnanchored = g({ id: 'a', name: 'Alyosha', kind: '4star_character', targetId: 'a' });
    const allGoals = [odetteUnlinked, alyoshaUnanchored, mikoUnlinked];
    const phases = buildPhases(allGoals);
    // 3, not 2 (twentieth-reported-bug follow-up, 2026-08-21): Alyosha, being
    // genuinely disconnected here (2 distinct unlinked phases exist), now gets
    // her own isolated phase — confirms this is genuinely the ambiguous,
    // 2-distinct-5-star-phase shape, not linked/merged.
    expect(phases).toHaveLength(3);
    const phaseSpec = buildPhaseLocalSpec(phases[0].goals);
    const persistentSpec = buildPersistentSpec('character', allGoals);
    const closedGoalIds = computeClosedFourStarGoalIdsForPhase(phases, 0, persistentSpec.fourStarGoals.map((fg) => fg.goal));

    let phaseVector = zeroVector(phaseSpec.dims);
    let persistentVector = zeroVector(persistentSpec.dims);
    const featuredOdetteUnlinkedOrMikoUnlinked: PullOutcome = { rarity: 5, kind: 'featured', itemId: 'ou' };
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, featuredOdetteUnlinkedOrMikoUnlinked, closedGoalIds));
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, ainoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(0);
  });

  it('unanchored 4-star, with NO same-kind 5-star anywhere, has nothing to disconnect from — keeps counting (unchanged fallback)', () => {
    const alyoshaUnanchored = g({ id: 'a', name: 'Alyosha', kind: '4star_character', targetId: 'a' });
    const allGoals = [alyoshaUnanchored];
    const phases = buildPhases(allGoals);
    const phaseSpec = buildPhaseLocalSpec(phases[0].goals);
    const persistentSpec = buildPersistentSpec('character', allGoals);
    const closedGoalIds = computeClosedFourStarGoalIdsForPhase(phases, 0, persistentSpec.fourStarGoals.map((fg) => fg.goal));

    let phaseVector = zeroVector(phaseSpec.dims);
    let persistentVector = zeroVector(persistentSpec.dims);
    ({ phaseVector, persistentVector } = updateGoalTracking(phaseSpec, persistentSpec, phaseVector, persistentVector, ainoWin, closedGoalIds));
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(1);
  });

  // Eighteenth-reported-bug follow-up (2026-08-20): with EXACTLY ONE same-kind
  // 5-star in the whole list, `anchoredFiveStarGoalIds: undefined` (never
  // touched) and an EXPLICIT `[]` (user actively unchecked the one available
  // box) used to be indistinguishable — both fell into the SAME "nothing to
  // disconnect from, keep counting" fallback, since hasFourStarAnchorAmbiguity
  // only ever treats 2+ candidates as real ambiguity. That made it impossible
  // to express "this 4-star is on a DIFFERENT, not-yet-added phase" without
  // adding a phantom placeholder 5-star just to create real ambiguity. Now
  // `undefined` keeps the old fallback (still counts — the common case stays
  // zero-click) but an explicit `[]` always means deliberately disconnected,
  // regardless of candidate count.
  it('with exactly ONE same-kind 5-star: undefined anchors still auto-attaches (unchanged), but an EXPLICIT empty array now means deliberately disconnected', () => {
    const odetteAlone = g({ id: 'oa', name: 'Odette', kind: '5star_character', targetId: 'oa' });
    const alyoshaUndefined = g({ id: 'a1', name: 'Alyosha1', kind: '4star_character', targetId: 'a1' }); // anchoredFiveStarGoalIds omitted -> undefined
    const alyoshaExplicitEmpty = g({ id: 'a2', name: 'Alyosha2', kind: '4star_character', targetId: 'a2', anchoredFiveStarGoalIds: [] });

    for (const [alyosha, expectedCopies, expectedPhaseCount] of [
      // undefined -> unambiguous auto-attach, still merges into Odette's phase.
      [alyoshaUndefined, 1, 1],
      // explicit [] -> ALWAYS disconnected (twentieth-reported-bug follow-up,
      // 2026-08-21) -> her own isolated phase, even with only one candidate.
      [alyoshaExplicitEmpty, 0, 2],
    ] as const) {
      const allGoals = [odetteAlone, alyosha];
      const phases = buildPhases(allGoals);
      expect(phases).toHaveLength(expectedPhaseCount);
      const phaseSpec = buildPhaseLocalSpec(phases[0].goals);
      const persistentSpec = buildPersistentSpec('character', allGoals);
      const closedGoalIds = computeClosedFourStarGoalIdsForPhase(phases, 0, persistentSpec.fourStarGoals.map((fg) => fg.goal));

      let alyoshaPhaseVector = zeroVector(phaseSpec.dims);
      let alyoshaPersistentVector = zeroVector(persistentSpec.dims);
      const targetId = alyosha.targetId;
      const featuredWin: PullOutcome = { rarity: 4, kind: 'featured', itemId: targetId };
      ({ phaseVector: alyoshaPhaseVector, persistentVector: alyoshaPersistentVector } = updateGoalTracking(
        phaseSpec,
        persistentSpec,
        alyoshaPhaseVector,
        alyoshaPersistentVector,
        featuredWin,
        closedGoalIds,
      ));
      expect(copyCountOf(persistentSpec, alyoshaPersistentVector, targetId)).toBe(expectedCopies);
    }
  });

  it("anchor resolved in an EARLIER phase (separated by a weapon-banner detour): stays OPEN in Alyosha's own LATER phase (ninth reported bug), and copies gained during the EARLIER phase are also preserved via persistent carryover", () => {
    // Priority: Odette (char, phase0), Weapon (weapon, phase1), Alyosha (char,
    // phase2, anchored to Odette). Alyosha isn't one of phase0's own goals, but her
    // persistent dimension is tracked there too (multiple 4-stars coexist on a
    // banner) — copies gained opportunistically during phase0 are preserved.
    //
    // Ninth reported bug: an earlier version ALSO closed Alyosha's window in
    // phase2 itself, reasoning "every anchor (Odette, phase0) is strictly before
    // phase2, so it's resolved, so close it" — but phase2 = [alyosha] alone, so
    // that phase can never graduate without her, and closing her window there
    // meant it could never graduate past whatever she'd already accrued in
    // phase0, no matter the pull budget (a real, user-reported hard-ceiling bug —
    // see exactEngine.ts's "ninth reported bug" test for the end-to-end version).
    // An item's own REQUIRED phase must never be closed by the anchor-range
    // check; only a phase that's neither an anchor's phase nor the item's own can be.
    const alyosha = g({ id: 'a', name: 'Alyosha', kind: '4star_character', targetId: 'a', anchoredFiveStarGoalIds: ['o'] });
    const allGoals = [odette, weapon, alyosha];
    const phases = buildPhases(allGoals);
    expect(phases).toHaveLength(3);
    const persistentSpec = buildPersistentSpec('character', allGoals);
    const fourStarGoals = persistentSpec.fourStarGoals.map((fg) => fg.goal);

    const closedInPhase0 = computeClosedFourStarGoalIdsForPhase(phases, 0, fourStarGoals);
    expect(closedInPhase0.has('a')).toBe(false); // Odette's own phase — anchor not yet resolved from here
    const closedInPhase2 = computeClosedFourStarGoalIdsForPhase(phases, 2, fourStarGoals);
    expect(closedInPhase2.has('a')).toBe(false); // Alyosha's own required phase — must stay open regardless of anchor timing

    const phase0Spec = buildPhaseLocalSpec(phases[0].goals); // = [odette]; Alyosha not one of ITS own goals
    let phaseVector = zeroVector(phase0Spec.dims);
    let persistentVector = zeroVector(persistentSpec.dims);
    // A copy drops during Odette's own phase, before Odette wins.
    ({ phaseVector, persistentVector } = updateGoalTracking(phase0Spec, persistentSpec, phaseVector, persistentVector, ainoWin, closedInPhase0));
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(1);

    // Carry persistentVector forward (weapon phase 1 doesn't touch it), into phase 2.
    const phase2Spec = buildPhaseLocalSpec(phases[2].goals); // = [alyosha]
    let phase2Vector = zeroVector(phase2Spec.dims);
    ({ phaseVector: phase2Vector, persistentVector } = updateGoalTracking(phase2Spec, persistentSpec, phase2Vector, persistentVector, ainoWin, closedInPhase2));
    // The earlier copy carries forward AND the window stays open here — 2, not 1.
    expect(copyCountOf(persistentSpec, persistentVector, 'a')).toBe(2);
  });
});
