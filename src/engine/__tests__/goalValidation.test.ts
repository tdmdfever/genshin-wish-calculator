import { describe, expect, it } from 'vitest';
import { validateGoals } from '../goalValidation';
import { buildPhases } from '../phases';
import type { Goal } from '../types';

function fiveStarChar(id: string, name: string, linkedCharacterGoalId?: string): Goal {
  return { id, name, kind: '5star_character', banner: 'character', targetId: id, linkedCharacterGoalId };
}
function fourStarChar(id: string, name: string, anchoredFiveStarGoalIds?: string[]): Goal {
  return { id, name, kind: '4star_character', banner: 'character', targetId: id, anchoredFiveStarGoalIds };
}
function fiveStarWeapon(id: string, name: string, linkedWeaponGoalId?: string): Goal {
  return { id, name, kind: '5star_weapon', banner: 'weapon', targetId: id, linkedWeaponGoalId };
}
function fourStarWeapon(id: string, name: string, anchoredFiveStarGoalIds?: string[]): Goal {
  return { id, name, kind: '4star_weapon', banner: 'weapon', targetId: id, anchoredFiveStarGoalIds };
}
function weaponDetour(id = 'wd'): Goal {
  return fiveStarWeapon(id, 'Detour weapon');
}
function charDetour(id = 'cd'): Goal {
  return fiveStarChar(id, 'Detour char');
}

describe('validateGoals', () => {
  it('allows an unanchored 4-star goal when there are 0 or 1 five-star character goals', () => {
    expect(validateGoals([fourStarChar('a', 'Alyosha')])).toEqual([]);
    expect(validateGoals([fiveStarChar('o', 'Odette'), fourStarChar('a', 'Alyosha')])).toEqual([]);
  });

  it('leaving a 4-star unanchored when 2+ five-star character goals exist is now VALID — a deliberate disconnect (issue 1.5.5), not an error requiring a choice', () => {
    const goals = [fiveStarChar('o', 'Odette'), fourStarChar('a', 'Alyosha'), fiveStarChar('m', 'Miko')];
    expect(validateGoals(goals)).toEqual([]);
  });

  it('case A: anchored to both paired banners, adjacent — valid', () => {
    const goals = [fiveStarChar('o', 'Odette'), fourStarChar('a', 'Alyosha', ['o', 'm']), fiveStarChar('m', 'Miko')];
    expect(validateGoals(goals)).toEqual([]);
  });

  it('case B: anchored to just the first of two SAME-PHASE banners — rejected (simultaneous same-phase banners always share the identical 4-star roster, so a partial anchor here can never correspond to a real configuration)', () => {
    // Linked (sixteenth reported bug, 2026-08-19): same-phase sharing now needs
    // an explicit mutual link — adjacency alone no longer implies it. Alyosha
    // sits directly BETWEEN Odette and Miko here, so this now trips the
    // findFlankingLinkedPair check (twentieth-reported-bug follow-up,
    // 2026-08-21) instead of the older "same-phase coverage" one — same
    // underlying requirement (anchor to both), different, more specific
    // message since this shape is now structurally forced, not just checked.
    const goals = [fiveStarChar('o', 'Odette', 'm'), fourStarChar('a', 'Alyosha', ['o']), fiveStarChar('m', 'Miko', 'o')];
    const errors = validateGoals(goals);
    expect(errors).toHaveLength(1);
    expect(errors[0].goalId).toBe('a');
    expect(errors[0].message).toContain('simultaneous');
  });

  it("rejects Odette -> Miko -> Alyosha(anchored to Odette only) — Odette's banner is already gone by Alyosha's slot (also trips the same-phase coverage rule, since Miko shares Odette's phase and isn't anchored)", () => {
    const goals = [fiveStarChar('o', 'Odette', 'm'), fiveStarChar('m', 'Miko', 'o'), fourStarChar('a', 'Alyosha', ['o'])];
    const errors = validateGoals(goals);
    expect(errors).toHaveLength(2);
    expect(errors.every((e) => e.goalId === 'a')).toBe(true);
  });

  it('rejects a foreign 5-star sandwiched between two anchors (Odette, Raiden, Miko in 3 SEPARATE phases via detours — keeps this test isolated to the "sandwiched" rule, not the same-phase-coverage rule)', () => {
    const goals = [
      fiveStarChar('o', 'Odette'),
      weaponDetour('wd1'),
      fiveStarChar('r', 'Raiden'),
      weaponDetour('wd2'),
      fiveStarChar('m', 'Miko'),
      fourStarChar('a', 'Alyosha', ['o', 'm']),
    ];
    const errors = validateGoals(goals);
    expect(errors).toHaveLength(1);
    expect(errors[0].goalId).toBe('a');
  });

  it('rejects more than 2 anchors (Odette, Raiden, Miko in 3 separate phases, so only the maxAnchors rule fires)', () => {
    const goals = [
      fiveStarChar('o', 'Odette'),
      weaponDetour('wd1'),
      fiveStarChar('r', 'Raiden'),
      weaponDetour('wd2'),
      fiveStarChar('m', 'Miko'),
      fourStarChar('a', 'Alyosha', ['o', 'r', 'm']),
    ];
    const errors = validateGoals(goals);
    expect(errors).toHaveLength(1);
    expect(errors[0].goalId).toBe('a');
  });

  it('rejects an anchor referencing a nonexistent goal', () => {
    const goals = [fiveStarChar('o', 'Odette'), fiveStarChar('m', 'Miko'), fourStarChar('a', 'Alyosha', ['ghost'])];
    const errors = validateGoals(goals);
    expect(errors).toHaveLength(1);
    expect(errors[0].goalId).toBe('a');
  });

  it('a 4-star positioned before both of its two anchors is still valid as long as nothing foreign is sandwiched', () => {
    const goals = [fourStarChar('a', 'Alyosha', ['o', 'm']), fiveStarChar('o', 'Odette'), fiveStarChar('m', 'Miko')];
    expect(validateGoals(goals)).toEqual([]);
  });

  it('a 4-star anchored only to a 5-star in a strictly later, non-adjacent phase is now VALID (issue 3) — its blocking phase resolves to the anchor\'s phase via MAX(own textual phase, latest anchor phase), not its own earlier textual phase', () => {
    // Odette(phase0), B(4-star, anchored to Miko only, textually phase0 too),
    // weapon detour (phase1), Miko(phase2) — B's blocking phase is now
    // MAX(0, 2) = 2 (Miko's), not her own textual phase 0, so this is no
    // longer structurally dead.
    const goals = [fiveStarChar('o', 'Odette'), fourStarChar('b', 'B', ['m']), weaponDetour(), fiveStarChar('m', 'Miko')];
    expect(validateGoals(goals)).toEqual([]);
  });

  it('allows a 4-star anchored to an earlier anchor, positioned in a later phase (checking a frozen count)', () => {
    const goals = [fiveStarChar('o', 'Odette'), weaponDetour(), fourStarChar('a', 'Alyosha', ['o'])];
    expect(validateGoals(goals)).toEqual([]);
  });

  describe('same-phase anchors must cover EVERY 5-star sharing that phase (simultaneous same-phase banners always share the identical 4-star roster)', () => {
    it('rejects a 4-star anchored to only the SECOND of two same-phase 5-stars too (symmetric with case B above)', () => {
      // Also flanked (see case B's own updated comment) — same findFlankingLinkedPair path.
      const goals = [fiveStarChar('o', 'Odette', 'm'), fourStarChar('a', 'Alyosha', ['m']), fiveStarChar('m', 'Miko', 'o')];
      const errors = validateGoals(goals);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('a');
      expect(errors[0].message).toContain('simultaneous');
    });

    it('allows anchoring to just one 5-star when the other same-kind 5-star goals are in a DIFFERENT phase (cross-phase, not same-phase)', () => {
      const goals = [fiveStarChar('o', 'Odette'), weaponDetour(), fourStarChar('a', 'Alyosha', ['o']), fiveStarChar('m', 'Miko')];
      expect(validateGoals(goals)).toEqual([]);
    });

    // Sixteenth reported bug (2026-08-19): since same-phase sharing now
    // requires an explicit MUTUAL link (a single id field, at most one
    // partner), buildPhases can never merge 3+ 5star_character goals into one
    // phase at all anymore — a 3rd goal's own link target can match at most
    // ONE of an already-2-member phase's occupants, so it always splits off.
    // The "caps same-phase 5-star character goals at 2" rule in
    // goalValidation.ts (predates explicit linking) is consequently no longer
    // reachable through any input — left in place as harmless defensive code
    // (same spirit as the weapon side's analogous size-cap check), but there's
    // no longer a constructible scenario to regression-test it against, so
    // the old test for it (which relied on bare adjacency implying same-phase)
    // is removed rather than force-fit into an unreachable shape.
    it('3+ 5-star character goals in a row are now naturally SEQUENTIAL by default, no detour or error needed at all — this is the headline fix', () => {
      const goals = [fiveStarChar('o', 'Odette'), fiveStarChar('r', 'Raiden'), fiveStarChar('m', 'Miko')];
      expect(validateGoals(goals)).toEqual([]);
    });
  });

  describe('linkedCharacterGoalId (a weapon-banner goal between a linked pair is fine, another character-banner goal is not)', () => {
    it('allows a linked pair with a weapon-banner goal (and its own linked weapon partner) sandwiched between them — the real interleaved-phase shape', () => {
      const goals = [
        fiveStarChar('o', 'Odette', 'r'),
        fiveStarWeapon('ow', 'OdetteWeapon', 'rw'),
        fiveStarChar('r', 'Raiden', 'o'),
        fiveStarWeapon('rw', 'RaidenWeapon', 'ow'),
      ];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('still rejects a linked pair with another 5★ CHARACTER goal sandwiched between them', () => {
      const goals = [fiveStarChar('o', 'Odette', 'r'), fiveStarChar('m', 'Miko'), fiveStarChar('r', 'Raiden', 'o')];
      const errors = validateGoals(goals);
      expect(errors.some((e) => e.goalId === 'o' && e.message.includes('5★ character goal sits between them'))).toBe(true);
    });

    it('allows a 4★ character goal sandwiched between a linked pair (same-phase anchoring case, unaffected by this relaxation)', () => {
      const goals = [fiveStarChar('o', 'Odette', 'm'), fourStarChar('a', 'Alyosha', ['o', 'm']), fiveStarChar('m', 'Miko', 'o')];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('rejects an asymmetric (one-directional) link', () => {
      const goals = [fiveStarChar('o', 'Odette', 'r'), fiveStarChar('r', 'Raiden')];
      const errors = validateGoals(goals);
      expect(errors.some((e) => e.goalId === 'o' && e.message.includes("isn't linked back"))).toBe(true);
    });
  });

  describe('4star_weapon anchoring', () => {
    it('allows an unanchored 4-star weapon goal when there is only 1 weapon-banner phase', () => {
      const goals = [fiveStarWeapon('wa', 'WeaponA'), fourStarWeapon('x', 'X')];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('does NOT require an anchor just because 2 LINKED five-star weapon goals share one window (chosen + other-featured)', () => {
      // Since the fifteenth reported bug (2026-08-19), sharing a phase requires an
      // explicit mutual link — adjacency alone no longer implies it.
      const goals = [fiveStarWeapon('wa', 'WeaponA', 'wb'), fiveStarWeapon('wb', 'WeaponB', 'wa'), fourStarWeapon('x', 'X')];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('leaving a 4-star weapon unanchored when 2 adjacent five-star weapon goals are left UNLINKED (two distinct windows) is now VALID — a deliberate disconnect, not an error', () => {
      const goals = [fiveStarWeapon('wa', 'WeaponA'), fiveStarWeapon('wb', 'WeaponB'), fourStarWeapon('x', 'X')];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('leaving a 4-star weapon unanchored when 2+ distinct weapon-banner phases exist is now VALID', () => {
      const goals = [fiveStarWeapon('wa', 'WeaponA'), charDetour(), fourStarWeapon('x', 'X'), fiveStarWeapon('wb', 'WeaponB')];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('rejects more than 1 anchor for a 4-star weapon', () => {
      const goals = [
        fiveStarWeapon('wa', 'WeaponA'),
        charDetour(),
        fiveStarWeapon('wb', 'WeaponB'),
        fourStarWeapon('x', 'X', ['wa', 'wb']),
      ];
      const errors = validateGoals(goals);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('x');
    });

    it('accepts a single valid anchor once 2+ weapon-banner phases exist', () => {
      const goals = [fiveStarWeapon('wa', 'WeaponA'), charDetour(), fourStarWeapon('x', 'X', ['wa']), fiveStarWeapon('wb', 'WeaponB')];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('a 4-star weapon anchored only to a later, non-adjacent weapon-banner phase is now VALID (issue 3) — blocking phase resolves via MAX(own textual phase, anchor phase)', () => {
      const goals = [fiveStarWeapon('wa', 'WeaponA'), fourStarWeapon('x', 'X', ['wb']), charDetour(), fiveStarWeapon('wb', 'WeaponB')];
      expect(validateGoals(goals)).toEqual([]);
    });
  });

  describe('4-star per-phase overlap cap (matches the real roster size — 3 character, 5 weapon)', () => {
    it('allows up to 3 4-star character goals sharing one phase', () => {
      const goals = [fourStarChar('a', 'A'), fourStarChar('b', 'B'), fourStarChar('c', 'C')];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('rejects a 4th 4-star character goal active in the same phase — flagged by the total cap (they\'re numerically equal for character today, so the per-phase check never has to fire on its own; see the dedup note in goalValidation.ts)', () => {
      const goals = [fourStarChar('a', 'A'), fourStarChar('b', 'B'), fourStarChar('c', 'C'), fourStarChar('d', 'D')];
      const errors = validateGoals(goals);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('d');
      expect(errors[0].message).toContain('across your whole priority list');
    });

    // Weapon's per-phase cap (5) is currently UNREACHABLE on its own: the total
    // cap (4, see MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER's doc comment) is strictly
    // tighter, and "active in one phase" is always a subset of "total named", so
    // the total check always fires first for any goal count that would otherwise
    // test the per-phase check in isolation. The maxActivePerPhase=5 logic stays
    // in goalValidation.ts (matches the real game's roster size, and would become
    // reachable again if the total cap is ever raised via a deeper architectural
    // fix — see CLAUDE.md) but isn't independently testable through validateGoals
    // today. This test documents that reality directly, instead of asserting a
    // now-impossible-to-reach state.
    it('weapon: the total cap (4) fires before the per-phase cap (5) ever could, for any single-phase goal count', () => {
      const goals = [
        fourStarWeapon('a', 'A'),
        fourStarWeapon('b', 'B'),
        fourStarWeapon('c', 'C'),
        fourStarWeapon('d', 'D'),
        fourStarWeapon('e', 'E'),
      ];
      const errors = validateGoals(goals);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('e');
      expect(errors[0].message).toContain('across your whole priority list');
    });

    it('allows 2+1 4-star character goals split across two DIFFERENT phases (each individually ≤3 active, total stays within the 3-goal total cap) — this fix\'s real benefit: an existing budget of 3 can be freely DISTRIBUTED across phases, not crammed into one', () => {
      const goals = [
        fiveStarChar('o', 'Odette'),
        fourStarChar('a1', 'A1', ['o']),
        fourStarChar('a2', 'A2', ['o']),
        weaponDetour(),
        fiveStarChar('m', 'Miko'),
        fourStarChar('b1', 'B1', ['m']),
      ];
      expect(validateGoals(goals)).toEqual([]);
    });
  });

  describe('4-star total-per-banner cap (bounds the exact-DP state space, independent of per-phase overlap)', () => {
    // These totals (3 character, 4 weapon — see MAX_TOTAL_FOUR_STAR_GOALS_PER_BANNER's
    // own doc comment) are directly measured, not guessed: a banner reused across
    // phases means a goal's FROZEN post-graduation value still rides along as a
    // live dimension in every later phase, and since that frozen value varies
    // across the whole distribution reaching the later phase, the later phase's
    // reachable-state count multiplies by that variety on top of its own newly-
    // varying goals — far steeper than a naive "8x/6x per goal" reading suggests.
    // Character topped out at its own per-phase cap (3); weapon tolerated one more
    // (4) before the same cliff. Both were directly profiled via runExactSimulation
    // at this app's default pull budget (90) — going further needs its own
    // profiling pass, not just a bigger constant.
    it('rejects a 4th 4-star character goal even when every phase individually stays within the per-phase cap', () => {
      const goals = [
        fiveStarChar('o', 'Odette'),
        fourStarChar('a1', 'A1', ['o']),
        fourStarChar('a2', 'A2', ['o']),
        weaponDetour('wd1'),
        fiveStarChar('m', 'Miko'),
        fourStarChar('b1', 'B1', ['m']),
        fourStarChar('b2', 'B2', ['m']),
      ];
      const errors = validateGoals(goals);
      // Every phase has ≤2 active 4-stars — the per-phase cap never fires. Only
      // the TOTAL cap (4 > 3) does, flagging the 4th 4-star goal by priority-list
      // position, not by which phase it's in.
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('b2');
      expect(errors[0].message).toContain('across your whole priority list');
    });

    it('rejects a 5th 4-star weapon goal split 3+2 across two phases (each individually within the 5-wide per-phase cap), independently of the character count', () => {
      const goals: Goal[] = [
        fiveStarWeapon('wa', 'WeaponA'),
        fourStarWeapon('a1', 'A1', ['wa']),
        fourStarWeapon('a2', 'A2', ['wa']),
        fourStarWeapon('a3', 'A3', ['wa']),
        charDetour(),
        fiveStarWeapon('wb', 'WeaponB'),
        fourStarWeapon('b1', 'B1', ['wb']),
        fourStarWeapon('b2', 'B2', ['wb']),
        fourStarChar('h', 'H'),
        fourStarChar('i', 'I'),
        fourStarChar('j', 'J'),
      ];
      const errors = validateGoals(goals);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('b2');
      expect(errors[0].message).toContain('across your whole priority list');
    });
  });

  // Twentieth-reported-bug follow-up (2026-08-21): a disconnected 4-star now
  // gets her own real, isolated phase (phases.ts's buildPhases) instead of
  // sharing one synthesized trailing phase — directly measured to be
  // expensive regardless of pull budget once too many are disconnected at
  // once on the same banner (see MAX_DISCONNECTED_FOUR_STAR_GOALS_PER_BANNER's
  // own doc comment for the numbers), so this cap is separate from, and
  // narrower than, the total-per-banner cap above.
  describe('disconnected-4-star-count cap (separate from, and narrower than, the total-per-banner cap)', () => {
    it('rejects a 3rd simultaneously-disconnected character 4-star (cap is 2, one less than the total cap of 3)', () => {
      // 2 unlinked 5-stars (Odette, Miko) create the real ambiguity needed
      // for unanchored 4-stars to count as disconnected at all.
      const goals = [
        fiveStarChar('o', 'Odette'),
        fourStarChar('a', 'A'),
        fourStarChar('b', 'B'),
        fourStarChar('c', 'C'),
        fiveStarChar('m', 'Miko'),
      ];
      const errors = validateGoals(goals);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('c');
      expect(errors[0].message).toContain('disconnected');
    });

    it('allows exactly 2 simultaneously-disconnected character 4-stars', () => {
      const goals = [fiveStarChar('o', 'Odette'), fourStarChar('a', 'A'), fourStarChar('b', 'B'), fiveStarChar('m', 'Miko')];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('rejects a 4th simultaneously-disconnected weapon 4-star (cap is 3, one less than the total cap of 4)', () => {
      const goals = [
        fiveStarWeapon('h', 'Homa'),
        fourStarWeapon('a', 'A'),
        fourStarWeapon('b', 'B'),
        fourStarWeapon('c', 'C'),
        fourStarWeapon('d', 'D'),
        fiveStarWeapon('n', 'Neuvillette'),
      ];
      const errors = validateGoals(goals);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('d');
      expect(errors[0].message).toContain('disconnected');
    });

    it('an anchored 4-star does not count against the disconnected cap, even alongside 2 disconnected ones', () => {
      const goals = [
        fiveStarChar('o', 'Odette'),
        fourStarChar('a', 'A'),
        fourStarChar('b', 'B'),
        fourStarChar('c', 'C', ['o']),
        fiveStarChar('m', 'Miko'),
      ];
      expect(validateGoals(goals)).toEqual([]);
    });
  });

  // Fifteenth reported bug (2026-08-19): explicit Goal.linkedWeaponGoalId
  // validation — see types.ts's doc comment for the mechanic.
  describe('5star_weapon window linking', () => {
    it('accepts a valid mutual link with a character-banner detour in between', () => {
      const goals = [
        fiveStarWeapon('wa', 'WeaponA', 'wb'),
        charDetour(),
        fiveStarWeapon('wb', 'WeaponB', 'wa'),
      ];
      expect(validateGoals(goals)).toEqual([]);
    });

    it('rejects a link set on a non-5star_weapon goal', () => {
      const bad: Goal = { id: 'x', name: 'X', kind: '4star_weapon', banner: 'weapon', targetId: 'x', linkedWeaponGoalId: 'wa' };
      const goals = [fiveStarWeapon('wa', 'WeaponA'), bad];
      const errors = validateGoals(goals);
      expect(errors.map((e) => e.goalId)).toContain('x');
    });

    it('rejects a self-link', () => {
      const bad: Goal = { id: 'wa', name: 'WeaponA', kind: '5star_weapon', banner: 'weapon', targetId: 'wa', linkedWeaponGoalId: 'wa' };
      const errors = validateGoals([bad]);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('wa');
    });

    it('rejects a link to a goal id that no longer exists', () => {
      const goals = [fiveStarWeapon('wa', 'WeaponA', 'ghost')];
      const errors = validateGoals(goals);
      expect(errors).toHaveLength(1);
      expect(errors[0].goalId).toBe('wa');
    });

    it('rejects an asymmetric (one-directional) link', () => {
      const goals = [fiveStarWeapon('wa', 'WeaponA', 'wb'), fiveStarWeapon('wb', 'WeaponB')];
      const errors = validateGoals(goals);
      expect(errors.map((e) => e.goalId)).toContain('wa');
    });

    it('rejects a natal phase with more than one OTHER 5star_weapon goal besides the linked partner', () => {
      // wa declares its partner as wb (mutual, symmetric) — but priority order
      // [wa, wc, wb] means wc (which one-directionally links to wa) is what
      // actually merges into wa's own phase via buildPhases, bumping wb off
      // into its own separate phase. wa's own phase now has an unexpected
      // 3rd-wheel (wc), not its declared partner.
      const w = (id: string, name: string, linkedWeaponGoalId?: string): Goal => ({
        id,
        name,
        kind: '5star_weapon',
        banner: 'weapon',
        targetId: id,
        linkedWeaponGoalId,
      });
      const goals = [w('wa', 'WeaponA', 'wb'), w('wc', 'WeaponC', 'wa'), w('wb', 'WeaponB', 'wa')];
      const phases = buildPhases(goals);
      expect(phases.map((p) => p.goals.map((goal) => goal.id))).toEqual([['wa', 'wc'], ['wb']]); // sanity-check the setup
      const errors = validateGoals(goals);
      expect(errors.some((e) => e.goalId === 'wa' && e.message.includes('another 5★ weapon goal'))).toBe(true);
    });

    it('rejects a linked pair with another weapon-banner phase sandwiched between them', () => {
      const goals = [
        fiveStarWeapon('wa', 'WeaponA', 'wc'),
        fiveStarWeapon('wb', 'WeaponB'), // unrelated, unlinked — forces its own phase, sandwiched between wa and wc
        charDetour(),
        fiveStarWeapon('wc', 'WeaponC', 'wa'),
      ];
      const errors = validateGoals(goals);
      expect(errors.some((e) => e.goalId === 'wa' && e.message.includes('another weapon-banner phase sits between them'))).toBe(true);
    });
  });
});
