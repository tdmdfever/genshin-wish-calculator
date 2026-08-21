import { describe, expect, it } from 'vitest';
import {
  buildPhases,
  computeCharacterBannerConfigForPhase,
  computeClosedFiveStarWeaponTargetIdsForPhase,
  computeWeaponBannerConfigAfterFirstClaimedForPhase,
  computeWeaponBannerConfigForPhase,
} from '../phases';
import type { Goal } from '../types';

function g(overrides: Partial<Goal>): Goal {
  return { id: 'g', name: 'g', kind: '5star_character', banner: 'character', targetId: 'g', ...overrides };
}

describe('buildPhases', () => {
  it('groups consecutive same-banner goals into one phase', () => {
    // 4star_character (not 5star_character) deliberately, to keep this test
    // about the GENERIC same-banner-merges-by-default rule, isolated from the
    // sixteenth-bug special case (5star_character goals now require an
    // explicit linkedCharacterGoalId to merge — see the dedicated describe
    // block below).
    const goals = [
      g({ id: 'a', kind: '4star_character', banner: 'character' }),
      g({ id: 'b', kind: '4star_character', banner: 'character' }),
      g({ id: 'c', banner: 'weapon' }),
      g({ id: 'd', kind: '4star_character', banner: 'character' }),
    ];
    const phases = buildPhases(goals);
    expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['a', 'b'], ['c'], ['d']]);
    expect(phases.map((p) => p.banner)).toEqual(['character', 'weapon', 'character']);
  });

  it('records each phase\'s starting index within the global goal list', () => {
    const goals = [g({ id: 'a', banner: 'character' }), g({ id: 'b', banner: 'weapon' }), g({ id: 'c', banner: 'character' })];
    const phases = buildPhases(goals);
    expect(phases.map((p) => p.globalStartIndex)).toEqual([0, 1, 2]);
  });

  // Fifteenth reported bug (2026-08-19): adjacency alone no longer implies "same
  // weapon-banner window" — see types.ts's linkedWeaponGoalId doc comment.
  describe('5star_weapon adjacency vs. explicit linking', () => {
    function fiveStarWeapon(id: string, linkedWeaponGoalId?: string): Goal {
      return { id, name: id, kind: '5star_weapon', banner: 'weapon', targetId: id, linkedWeaponGoalId };
    }

    it('splits two ADJACENT unlinked 5star_weapon goals into separate phases (used to always merge)', () => {
      const goals = [fiveStarWeapon('wa'), fiveStarWeapon('wb')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['wa'], ['wb']]);
    });

    it('still merges two ADJACENT, MUTUALLY-linked 5star_weapon goals into one phase (unchanged behavior)', () => {
      const goals = [fiveStarWeapon('wa', 'wb'), fiveStarWeapon('wb', 'wa')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['wa', 'wb']]);
    });

    it('does not merge a 4star_weapon goal\'s adjacency with an unrelated 5star_weapon goal', () => {
      // Anchored explicitly to WeaponA, NOT ambiguous/disconnected — this test
      // is specifically about adjacency-merging being independent of
      // weapon-window linking, not about disconnected-4-star isolation (see
      // the twentieth-reported-bug follow-up's own dedicated tests for that).
      const fourStar: Goal = { id: 'x', name: 'X', kind: '4star_weapon', banner: 'weapon', targetId: 'x', anchoredFiveStarGoalIds: ['wa'] };
      const goals = [fiveStarWeapon('wa'), fourStar, fiveStarWeapon('wb')];
      const phases = buildPhases(goals);
      // The 4-star merges into WeaponA's phase (unrelated to weapon-window
      // linking, which only gates 5star_weapon-vs-5star_weapon adjacency); WeaponB
      // still splits off since it's unlinked to WeaponA.
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['wa', 'x'], ['wb']]);
    });
  });

  // Sixteenth reported bug (2026-08-19): adjacency alone no longer implies
  // "simultaneous phase" — see types.ts's linkedCharacterGoalId doc comment.
  describe('5star_character adjacency vs. explicit linking', () => {
    function fiveStarChar(id: string, linkedCharacterGoalId?: string): Goal {
      return { id, name: id, kind: '5star_character', banner: 'character', targetId: 'char5', linkedCharacterGoalId };
    }

    it('splits two ADJACENT unlinked 5star_character goals into separate (sequential) phases (used to always merge)', () => {
      const goals = [fiveStarChar('miko'), fiveStarChar('furina')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['miko'], ['furina']]);
    });

    it('still merges two ADJACENT, MUTUALLY-linked 5star_character goals into one phase (simultaneous banners, unchanged behavior)', () => {
      const goals = [fiveStarChar('miko', 'furina'), fiveStarChar('furina', 'miko')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['miko', 'furina']]);
    });

    it('supports chasing 3+ sequential 5star_character goals with no weapon detour needed', () => {
      const goals = [fiveStarChar('a'), fiveStarChar('b'), fiveStarChar('c')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['a'], ['b'], ['c']]);
    });

    it('does not merge a 4star_character goal\'s adjacency with an unrelated 5star_character goal', () => {
      // Anchored explicitly to Miko, NOT ambiguous/disconnected — this test
      // is specifically about adjacency-merging being independent of 5-star
      // linking, not about disconnected-4-star isolation (see the
      // twentieth-reported-bug follow-up's own dedicated tests for that).
      const fourStar: Goal = { id: 'x', name: 'X', kind: '4star_character', banner: 'character', targetId: 'x', anchoredFiveStarGoalIds: ['miko'] };
      const goals = [fiveStarChar('miko'), fourStar, fiveStarChar('furina')];
      const phases = buildPhases(goals);
      // The 4-star merges into Miko's phase (unrelated to 5-star linking, which
      // only gates 5star_character-vs-5star_character adjacency); Furina still
      // splits off since she's unlinked to Miko.
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['miko', 'x'], ['furina']]);
    });
  });

  // Twentieth-reported-bug follow-up (2026-08-21): a disconnected 4-star now
  // gets her own isolated phase, at her own priority position, instead of
  // being deferred to a synthesized phase after every real phase.
  describe('disconnected 4-star isolation', () => {
    function fiveStarChar(id: string): Goal {
      return { id, name: id, kind: '5star_character', banner: 'character', targetId: 'char5' };
    }
    function fourStarChar(id: string, anchors?: string[]): Goal {
      return { id, name: id, kind: '4star_character', banner: 'character', targetId: id, anchoredFiveStarGoalIds: anchors };
    }

    it('an ambiguous unanchored 4-star (2+ candidate 5-star windows elsewhere) becomes the sole member of her own isolated phase', () => {
      const goals = [fiveStarChar('o'), fourStarChar('a'), fiveStarChar('m')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['o'], ['a'], ['m']]);
    });

    it('an explicit empty anchor array always isolates, even with only ONE candidate 5-star window', () => {
      const goals = [fiveStarChar('o'), fourStarChar('a', [])];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['o'], ['a']]);
    });

    it('an UNAMBIGUOUS unanchored 4-star (only one candidate 5-star window) still auto-attaches, unchanged', () => {
      const goals = [fiveStarChar('o'), fourStarChar('a')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['o', 'a']]);
    });

    it('two ADJACENT disconnected 4-stars each get their own SEPARATE, sequential phase (not merged)', () => {
      const goals = [fiveStarChar('o'), fourStarChar('a'), fourStarChar('b'), fiveStarChar('m')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['o'], ['a'], ['b'], ['m']]);
    });
  });
});

describe('computeCharacterBannerConfigForPhase', () => {
  const odette = g({ id: 'o', kind: '5star_character', banner: 'character', targetId: 'char5' });
  const weaponDetour = g({ id: 'wd', kind: '5star_weapon', banner: 'weapon', targetId: 'w' });
  const miko = g({ id: 'm', kind: '5star_character', banner: 'character', targetId: 'char5' });
  function fourStarChar(id: string, targetId: string, anchors: string[]): Goal {
    return { id, name: id, kind: '4star_character', banner: 'character', targetId, anchoredFiveStarGoalIds: anchors };
  }

  it("each phase's pool contains only that phase's own 3 real ids — no dilution from a different phase's names", () => {
    const a1 = fourStarChar('a1', 'a1', ['o']);
    const a2 = fourStarChar('a2', 'a2', ['o']);
    const a3 = fourStarChar('a3', 'a3', ['o']);
    const b1 = fourStarChar('b1', 'b1', ['m']);
    const b2 = fourStarChar('b2', 'b2', ['m']);
    const b3 = fourStarChar('b3', 'b3', ['m']);
    const goals = [odette, a1, a2, a3, weaponDetour, miko, b1, b2, b3];
    const phases = buildPhases(goals);
    const allCharFourStars = [a1, a2, a3, b1, b2, b3];

    const phase0Config = computeCharacterBannerConfigForPhase(phases, 0, allCharFourStars, 'char5');
    expect(new Set(phase0Config.featured4StarIds)).toEqual(new Set(['a1', 'a2', 'a3']));

    const phase2Config = computeCharacterBannerConfigForPhase(phases, 2, allCharFourStars, 'char5');
    expect(new Set(phase2Config.featured4StarIds)).toEqual(new Set(['b1', 'b2', 'b3']));
  });

  it('pads with placeholders up to 3 when fewer than 3 real ids are active in a phase', () => {
    const a1 = fourStarChar('a1', 'a1', ['o']);
    const goals = [odette, a1];
    const phases = buildPhases(goals);
    const config = computeCharacterBannerConfigForPhase(phases, 0, [a1], 'char5');
    expect(config.featured4StarIds).toHaveLength(3);
    expect(config.featured4StarIds).toContain('a1');
  });
});

describe('computeWeaponBannerConfigForPhase', () => {
  function fiveStarWeapon(id: string, targetId: string): Goal {
    return { id, name: id, kind: '5star_weapon', banner: 'weapon', targetId };
  }
  const charDetour = g({ id: 'cd', kind: '5star_character', banner: 'character', targetId: 'c' });

  it("each phase's chosen/other identities come from THAT phase's own goals, not global priority position", () => {
    const weaponA = fiveStarWeapon('wa', 'weaponA');
    const weaponB = fiveStarWeapon('wb', 'weaponB');
    const goals = [weaponA, charDetour, weaponB];
    const phases = buildPhases(goals);

    const phase0Config = computeWeaponBannerConfigForPhase(phases, 0, []);
    expect(phase0Config.chosenWeaponId).toBe('weaponA');
    expect(phase0Config.otherFeaturedWeaponId).not.toBe('weaponB'); // no second weapon goal in THIS phase

    const phase2Config = computeWeaponBannerConfigForPhase(phases, 2, []);
    // This is the fix: WeaponB is the FIRST (and only) 5star_weapon goal in ITS
    // OWN phase, so it must be the "chosen" identity there — a Fate Point earned
    // during phase 2 must be able to guarantee it. The old global-priority-position
    // derivation would have made it "other" forever, since it's 2nd in the whole list.
    expect(phase2Config.chosenWeaponId).toBe('weaponB');
  });

  it("a phase's 4-star weapon pool contains only that phase's own active ids, padded to 5", () => {
    function fourStarWeapon(id: string, targetId: string, anchors: string[]): Goal {
      return { id, name: id, kind: '4star_weapon', banner: 'weapon', targetId, anchoredFiveStarGoalIds: anchors };
    }
    const weaponA = fiveStarWeapon('wa', 'weaponA');
    const weaponB = fiveStarWeapon('wb', 'weaponB');
    const a1 = fourStarWeapon('a1', 'a1', ['wa']);
    const b1 = fourStarWeapon('b1', 'b1', ['wb']);
    const goals = [weaponA, a1, charDetour, weaponB, b1];
    const phases = buildPhases(goals);
    const allWeaponFourStars = [a1, b1];

    const phase0Config = computeWeaponBannerConfigForPhase(phases, 0, allWeaponFourStars);
    expect(phase0Config.featured4WeaponIds).toContain('a1');
    expect(phase0Config.featured4WeaponIds).not.toContain('b1');
    expect(phase0Config.featured4WeaponIds).toHaveLength(5);

    const phase2Config = computeWeaponBannerConfigForPhase(phases, 2, allWeaponFourStars);
    expect(phase2Config.featured4WeaponIds).toContain('b1');
    expect(phase2Config.featured4WeaponIds).not.toContain('a1');
  });

  // Fifteenth reported bug (2026-08-19): [OdetteWeapon, CharDetour, RaidenWeapon]
  // LINKED must be treated as ONE real window split across two phases by the
  // character-banner detour — unlike the unlinked case tested above (line ~79),
  // where phase0's "other" identity correctly stays a placeholder.
  describe('explicitly LINKED weapon goals split across a character-banner detour', () => {
    const weaponA = fiveStarWeapon('wa', 'weaponA');
    const linkedWeaponA: Goal = { ...weaponA, linkedWeaponGoalId: 'wb' };
    const linkedWeaponB: Goal = { ...fiveStarWeapon('wb', 'weaponB'), linkedWeaponGoalId: 'wa' };

    it("each phase's config resolves the OTHER identity to the linked partner's real targetId, not a placeholder", () => {
      const goals = [linkedWeaponA, charDetour, linkedWeaponB];
      const phases = buildPhases(goals);
      expect(phases).toHaveLength(3); // still 3 separate Phase objects — linking doesn't change buildPhases here, unlike the adjacent case

      const phase0Config = computeWeaponBannerConfigForPhase(phases, 0, []);
      expect(phase0Config.chosenWeaponId).toBe('weaponA');
      expect(phase0Config.otherFeaturedWeaponId).toBe('weaponB');

      const phase2Config = computeWeaponBannerConfigForPhase(phases, 2, []);
      expect(phase2Config.chosenWeaponId).toBe('weaponB');
      expect(phase2Config.otherFeaturedWeaponId).toBe('weaponA');
    });

    it('neither target is closed in either phase (opportunistic crediting either direction stays open)', () => {
      const goals = [linkedWeaponA, charDetour, linkedWeaponB];
      const phases = buildPhases(goals);
      const allFiveStarWeaponGoals = [linkedWeaponA, linkedWeaponB];

      expect(computeClosedFiveStarWeaponTargetIdsForPhase(phases, 0, allFiveStarWeaponGoals).has('weaponB')).toBe(false);
      expect(computeClosedFiveStarWeaponTargetIdsForPhase(phases, 2, allFiveStarWeaponGoals).has('weaponA')).toBe(false);
    });

    it('the UNLINKED equivalent still closes the cross-phase target (regression guard against the linked fix leaking)', () => {
      const goals = [weaponA, charDetour, fiveStarWeapon('wb', 'weaponB')];
      const phases = buildPhases(goals);
      const allFiveStarWeaponGoals = [weaponA, fiveStarWeapon('wb', 'weaponB')];
      expect(computeClosedFiveStarWeaponTargetIdsForPhase(phases, 0, allFiveStarWeaponGoals).has('weaponB')).toBe(true);
    });

    it('the Epitomized-Path-retarget config (fourteenth reported bug machinery) activates for a linked cross-phase pair too', () => {
      const goals = [linkedWeaponA, charDetour, linkedWeaponB];
      const phases = buildPhases(goals);
      const afterClaimed0 = computeWeaponBannerConfigAfterFirstClaimedForPhase(phases, 0, []);
      expect(afterClaimed0).toBeDefined();
      expect(afterClaimed0!.chosenWeaponId).toBe('weaponB');
      expect(afterClaimed0!.otherFeaturedWeaponId).toBe('weaponA');

      // Unlinked cross-phase pair: no retarget applicable (undefined, matching every phase before the 14th-bug fix).
      const unlinkedGoals = [weaponA, charDetour, fiveStarWeapon('wb', 'weaponB')];
      const unlinkedPhases = buildPhases(unlinkedGoals);
      expect(computeWeaponBannerConfigAfterFirstClaimedForPhase(unlinkedPhases, 0, [])).toBeUndefined();
    });
  });
});
