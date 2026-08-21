import { describe, expect, it } from 'vitest';
import { DEFAULT_CR_PARAMS } from '../capturingRadiance';
import { validateGoals } from '../goalValidation';
import { formatGoalRoster, formatTrace, traceOneRun, type TraceRun } from '../trace';
import type { CharacterBannerState, CRHypothesisId, Goal, SimulationInput, WeaponBannerState } from '../types';

/**
 * "Does this make sense to an actual player" survey — a permanent, structured
 * sweep of goal-list shapes, distinct from trace.test.ts's small set of
 * targeted regression examples. Where trace.test.ts pins one specific seed to
 * lock down one specific bug fix, this file's job is BREADTH: one scenario per
 * structural shape the engine has to handle (single goal, FIFO chains,
 * same-phase anchoring in all 3 configurations, cross-phase detours, pool
 * dilution, Epitomized Path, multi-phase kitchen sinks, both CR models,
 * non-zero starting states), with generic sanity assertions plus a few
 * targeted ones for the historically bug-prone shapes (anchoring/blocking,
 * cross-phase pool scoping). Every scenario also logs its full formatted
 * trace — run with `--reporter=verbose` to read the story, since for most of
 * these the log IS the point, the same way trace.test.ts's is.
 *
 * 4-star targetLevels and pull budgets are deliberately generous (C3+/R3+,
 * 150-400 pulls) so a goal doesn't complete on its first lucky hit — an early
 * default-target survey made most scenarios end in 1-2 notable pulls, which
 * hides exactly the multi-pull accrual/blocking behavior this file exists to
 * exercise.
 *
 * Every scenario's goal list must pass validateGoals — asserted generically
 * below for all of them. Found 2026-08-18 reviewing this very survey "would
 * this make sense to an actual player": an earlier version of the C-series
 * anchored a 4-star to only ONE of two SAME-PHASE 5-star goals (e.g. Alyosha
 * anchored to Odette but not Miko, both in one phase). That's not just
 * confusingly narrated — it's not a real configuration at all: two
 * simultaneous same-phase character banners always feature the IDENTICAL
 * 3-slot 4-star roster (see types.ts's Goal.anchoredFiveStarGoalIds doc
 * comment), so a 4-star anchored to any one of a phase's 5-stars must be
 * anchored to ALL of them — goalValidation.ts now enforces this. The C-series
 * below was redesigned around configurations that are actually reachable by a
 * real user of this app.
 */

const zeroCharState: CharacterBannerState = { pity5: 0, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false };
const zeroWeaponState: WeaponBannerState = { pity5: 0, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false };
const FEATURED_5STAR = 'char5';

function baseInput(overrides: Partial<SimulationInput>): SimulationInput {
  return {
    pullBudget: 350,
    characterBanner: { state: zeroCharState, featured5StarId: FEATURED_5STAR },
    weaponBanner: { state: zeroWeaponState },
    crModelId: 'A',
    crParams: DEFAULT_CR_PARAMS,
    goals: [],
    trialCount: 1,
    ...overrides,
  };
}

function fiveStarChar(id: string, name: string, linkedCharacterGoalId?: string): Goal {
  return { id, name, kind: '5star_character', banner: 'character', targetId: FEATURED_5STAR, linkedCharacterGoalId };
}
function fiveStarWeapon(id: string, name: string, targetId: string, linkedWeaponGoalId?: string): Goal {
  return { id, name, kind: '5star_weapon', banner: 'weapon', targetId, linkedWeaponGoalId };
}
function fourStarChar(id: string, name: string, targetId: string, targetLevel: number, anchors?: string[]): Goal {
  return { id, name, kind: '4star_character', banner: 'character', targetId, targetLevel, anchoredFiveStarGoalIds: anchors };
}
function fourStarWeapon(id: string, name: string, targetId: string, targetLevel: number, anchors?: string[]): Goal {
  return { id, name, kind: '4star_weapon', banner: 'weapon', targetId, targetLevel, anchoredFiveStarGoalIds: anchors };
}

/** 6 5star_character goals split 2/2/2 across 3 phases (weapon detours between)
 * — at most 2 same-phase 5-star character goals is the real cap (only 2
 * simultaneous character banners run per phase), so 6 total needs 3 phases. */
function sixFiveStarsWithDetours(): Goal[] {
  const goals: Goal[] = [];
  for (let phase = 0; phase < 3; phase++) {
    if (phase > 0) goals.push(fiveStarWeapon(`hd${phase}`, `Detour${phase}`, `detour-weapon-${phase}`));
    const evenId = `f${phase * 2}`;
    const oddId = `f${phase * 2 + 1}`;
    // Linked (sixteenth reported bug, 2026-08-19): each pair is meant to be
    // this scenario's own phase's two SIMULTANEOUS 5-stars — adjacency alone
    // no longer implies that.
    goals.push(fiveStarChar(evenId, `Featured${phase * 2}`, oddId), fiveStarChar(oddId, `Featured${phase * 2 + 1}`, evenId));
  }
  return goals;
}

interface Scenario {
  id: string;
  description: string;
  seed: number;
  goals: Goal[];
  overrides?: Partial<SimulationInput>;
  /** Extra checks beyond the generic sanity pass, for historically bug-prone shapes. */
  extraChecks?: (run: TraceRun, input: SimulationInput) => void;
}

function doneAt(run: TraceRun, goalId: string): number | undefined {
  return run.goalDoneAtPull.get(goalId);
}

function notesFor(run: TraceRun, goalName: string) {
  return run.steps.flatMap((s) => s.notes.filter((n) => n.goalName === goalName));
}

const scenarios: Scenario[] = [
  // ---- A: single-goal baselines ----
  { id: 'A1', description: 'single 5star_character goal', seed: 1, goals: [fiveStarChar('o', 'Odette')] },
  { id: 'A2', description: 'single 5star_weapon goal', seed: 2, goals: [fiveStarWeapon('h', 'Homa', 'homa')] },
  {
    id: 'A3',
    description: 'single unanchored 4star_character goal, target C5 (6 copies)',
    seed: 3,
    goals: [fourStarChar('a', 'Alyosha', 'c4a', 5)],
    overrides: { pullBudget: 400 },
  },
  {
    id: 'A4',
    description: 'single unanchored 4star_weapon goal, target R4 (4 copies)',
    seed: 4,
    goals: [fourStarWeapon('x', 'X', 'wx', 4)],
    overrides: { pullBudget: 400 },
  },

  // ---- B: FIFO chains, no 4-stars ----
  {
    id: 'B1',
    description: 'two LINKED (simultaneous) 5star_character goals, one phase',
    seed: 5,
    goals: [fiveStarChar('o', 'Odette', 'm'), fiveStarChar('m', 'Miko', 'o')],
    overrides: { pullBudget: 400 },
  },
  {
    id: 'B2',
    description: 'three sequential 5star_character goals: Odette+Miko LINKED as simultaneous (at the 2-per-phase cap), Raiden resumes after a weapon detour',
    seed: 6,
    goals: [fiveStarChar('o', 'Odette', 'm'), fiveStarChar('m', 'Miko', 'o'), fiveStarWeapon('h', 'Homa', 'homa'), fiveStarChar('r', 'Raiden')],
    overrides: { pullBudget: 650 },
  },
  {
    id: 'B3',
    description:
      'SIXTEENTH REPORTED BUG headline fix: THREE fully sequential 5star_character goals, UNLINKED, no weapon detour needed anywhere — used to be structurally impossible (adjacency alone always forced them into one shared, over-the-cap phase)',
    seed: 25,
    goals: [fiveStarChar('o', 'Odette'), fiveStarChar('m', 'Miko'), fiveStarChar('f', 'Furina')],
    overrides: { pullBudget: 950 },
  },

  // ---- C: same-phase anchoring, all 3 configurations ----
  {
    id: 'C1',
    description: 'Odette + Miko (LINKED, simultaneous), Alyosha(C5, target 6 copies) anchored to BOTH — should never block',
    seed: 7,
    goals: [fiveStarChar('o', 'Odette', 'm'), fourStarChar('a', 'Alyosha', 'c4a', 5, ['o', 'm']), fiveStarChar('m', 'Miko', 'o')],
    overrides: { pullBudget: 450 },
    extraChecks: (run) => {
      const alyoshaNotes = notesFor(run, 'Alyosha');
      expect(alyoshaNotes.some((n) => n.kind === 'wasted-blocked')).toBe(false);
    },
  },
  {
    id: 'C2',
    description:
      'Odette(char) -> WeaponDetour -> Alyosha(C5, anchored to Odette only) & Miko sharing Alyosha\'s own phase — Miko\'s claim must stay blocked on Alyosha even though her only anchor is an EARLIER, already-resolved phase',
    seed: 8,
    goals: [
      fiveStarChar('o', 'Odette'),
      fiveStarWeapon('h', 'Homa', 'homa'),
      fourStarChar('a', 'Alyosha', 'c4a', 5, ['o']),
      fiveStarChar('m', 'Miko'),
    ],
    overrides: { pullBudget: 600 },
    extraChecks: (run) => {
      const alyoshaDone = doneAt(run, 'a');
      const mikoDone = doneAt(run, 'm');
      // A same-phase 4-star short of target must absorb every subsequent
      // featured win before the next 5-star can be claimed — Miko can never
      // finish strictly before Alyosha, even though Alyosha's own anchor
      // (Odette) is from an earlier, already-finished phase.
      if (alyoshaDone !== undefined && mikoDone !== undefined) {
        expect(alyoshaDone).toBeLessThanOrEqual(mikoDone);
      }
    },
  },
  {
    id: 'C3',
    description: 'Odette + Miko (LINKED, simultaneous), Alyosha(C6, target 7 copies) anchored to BOTH — window must stay open even after both 5-stars are already claimed',
    seed: 9,
    goals: [fiveStarChar('o', 'Odette', 'm'), fourStarChar('a', 'Alyosha', 'c4a', 6, ['o', 'm']), fiveStarChar('m', 'Miko', 'o')],
    overrides: { pullBudget: 750 },
    extraChecks: (run) => {
      const mikoDone = doneAt(run, 'm');
      const alyoshaCopyGains = run.steps.filter((s) => s.notes.some((n) => n.goalName === 'Alyosha' && n.kind === 'copy-gained'));
      if (mikoDone !== undefined) {
        // At C6 she's unlikely to finish before both 5-stars are claimed —
        // confirm at least one copy still lands AFTER Miko (the phase's last
        // 5-star), proving the window doesn't slam shut once FIFO is exhausted.
        expect(alyoshaCopyGains.some((step) => step.pull > mikoDone)).toBe(true);
      }
      expect(notesFor(run, 'Alyosha').some((n) => n.kind === 'wasted-blocked')).toBe(false);
    },
  },
  {
    id: 'C4',
    description: 'Odette + Raiden (LINKED, one phase, Alyosha C5 anchored to BOTH) -> WeaponDetour -> Miko (separate phase, Alyosha excluded)',
    seed: 10,
    goals: [
      fiveStarChar('o', 'Odette', 'r'),
      fiveStarChar('r', 'Raiden', 'o'),
      fourStarChar('a', 'Alyosha', 'c4a', 5, ['o', 'r']),
      fiveStarWeapon('h', 'Homa', 'homa'),
      fiveStarChar('m', 'Miko'),
    ],
    overrides: { pullBudget: 650 },
    extraChecks: (run) => {
      // Anchored to both of her own phase's 5-stars, so she never blocks
      // either of them.
      expect(notesFor(run, 'Alyosha').some((n) => n.kind === 'wasted-blocked')).toBe(false);
      // Her window is closed during Miko's later, separate phase — any
      // featured 4-star hit on her slot there should show as wasted-closed,
      // never as a further copy gain.
      const alyoshaDone = doneAt(run, 'a');
      const mikoDone = doneAt(run, 'm');
      if (alyoshaDone !== undefined && mikoDone !== undefined && alyoshaDone < mikoDone) {
        const gainsAfterAlyoshaDone = run.steps.filter(
          (s) => s.pull > alyoshaDone && s.notes.some((n) => n.goalName === 'Alyosha' && n.kind === 'copy-gained'),
        );
        expect(gainsAfterAlyoshaDone.length).toBe(0); // she's already done, so this would indicate a stray extra copy note, not a closing bug — kept as a sanity guard
      }
    },
  },
  {
    id: 'C5',
    description:
      'SIXTEENTH REPORTED BUG: Odette + Miko UNLINKED and ADJACENT (no weapon detour at all) — genuinely sequential, so Alyosha(anchored to Odette only) must close before Miko\'s own (separate, later) phase, exactly like the detour-separated C2 case but with no detour needed to express it',
    seed: 26,
    goals: [fiveStarChar('o', 'Odette'), fourStarChar('a', 'Alyosha', 'c4a', 5, ['o']), fiveStarChar('m', 'Miko')],
    overrides: { pullBudget: 650 },
    extraChecks: (run) => {
      const alyoshaDone = doneAt(run, 'a');
      const mikoDone = doneAt(run, 'm');
      // Same invariant as C2: a same-phase 4-star short of target must absorb
      // every subsequent featured win before the NEXT (sequential) 5-star can
      // be claimed.
      if (alyoshaDone !== undefined && mikoDone !== undefined) {
        expect(alyoshaDone).toBeLessThanOrEqual(mikoDone);
      }
    },
  },
  {
    id: 'C6',
    description:
      "SEVENTEENTH REPORTED BUG, the literal originally-reported shape: Odette + Miko UNLINKED and ADJACENT, Alyosha(C5) anchored to Miko ONLY — the mirror of C5's 'anchored to Odette only'. Before this fix, Alyosha's blocking phase was decided by raw textual position (she sits right after Odette), so she held Odette's phase hostage even though her only anchor is the LATER phase — making Miko literally unwinnable until Alyosha finished. Now her blocking phase resolves to MAX(own textual phase, anchor phase) = Miko's phase, so she no longer blocks the Odette-to-Miko handoff at all. This seed shows Miko claimed well before Alyosha reaches her own target.",
    seed: 1,
    goals: [fiveStarChar('o', 'Odette'), fourStarChar('a', 'Alyosha', 'c4a', 5, ['m']), fiveStarChar('m', 'Miko')],
    overrides: { pullBudget: 650 },
    extraChecks: (run) => {
      const alyoshaDone = doneAt(run, 'a');
      const mikoDone = doneAt(run, 'm');
      // Opposite of C5's invariant: Miko must NOT be gated on Alyosha here —
      // this specific seed is picked to show her claimed well before Alyosha
      // reaches her own C5 target, proving the fix rather than just asserting
      // it can't be disproven.
      expect(mikoDone).toBeDefined();
      expect(alyoshaDone).toBeDefined();
      expect(mikoDone!).toBeLessThan(alyoshaDone!);
    },
  },

  // ---- D: cross-phase (detour) scenarios ----
  {
    id: 'D1',
    description:
      "Odette(char) -> WeaponDetour -> Alyosha(C5, anchored to Odette only) [ninth-bug shape] — this seed leaves Alyosha short of her target when Homa finishes, so the trace actually shows pulling switch BACK to the character banner for her after the weapon detour ends",
    seed: 14,
    goals: [fiveStarChar('o', 'Odette'), fiveStarWeapon('h', 'Homa', 'homa'), fourStarChar('a', 'Alyosha', 'c4a', 5, ['o'])],
    overrides: { pullBudget: 550 },
    extraChecks: (run) => {
      const banners = run.steps.map((s) => s.banner);
      const weaponIdx = banners.indexOf('weapon');
      const alyoshaDone = doneAt(run, 'a');
      const homaDone = doneAt(run, 'h');
      // This seed is specifically picked (2026-08-19, re-picked from the
      // original seed 11 at the user's request) so Alyosha is NOT done by the
      // time Homa's own weapon phase finishes — confirming pulling genuinely
      // resumes on the character banner for her afterward, not just that it
      // COULD (seed 11's original choice happened to let her finish
      // opportunistically during Odette's own earlier stretch, which never
      // exercised the switch-back at all).
      expect(weaponIdx).toBeGreaterThan(-1);
      expect(homaDone).toBeDefined();
      expect(alyoshaDone === undefined || alyoshaDone > homaDone!).toBe(true);
      expect(banners.slice(weaponIdx).includes('character')).toBe(true);
    },
  },
  {
    id: 'D2',
    description: 'Odette -> WeaponDetour -> Miko, Alyosha(C5) anchored to BOTH Odette and Miko (spans the detour)',
    seed: 12,
    goals: [
      fiveStarChar('o', 'Odette'),
      fiveStarWeapon('h', 'Homa', 'homa'),
      fourStarChar('a', 'Alyosha', 'c4a', 5, ['o', 'm']),
      fiveStarChar('m', 'Miko'),
    ],
    overrides: { pullBudget: 600 },
    extraChecks: (run) => {
      // Anchored to both means Alyosha never blocks Miko's claim.
      expect(notesFor(run, 'Alyosha').some((n) => n.kind === 'wasted-blocked')).toBe(false);
    },
  },
  {
    id: 'D3',
    description: 'per-phase 4-star pool check: 2 named C5-target 4-stars in phase 0, 1 more in phase 2 (2+1 split, total=3)',
    seed: 13,
    goals: [
      fiveStarChar('o', 'Odette'),
      fourStarChar('a1', 'Alyosha', 'c4a', 5, ['o']),
      fourStarChar('a2', 'Bennett', 'c4b', 5, ['o']),
      fiveStarWeapon('h', 'Homa', 'homa'),
      fiveStarChar('m', 'Miko'),
      fourStarChar('a3', 'Chongyun', 'c4c', 5, ['m']),
    ],
    overrides: { pullBudget: 600 },
    extraChecks: (run) => {
      const odetteDone = doneAt(run, 'o');
      // Chongyun is anchored only to Miko (phase 2) — no copies before Odette's
      // phase even finishes, let alone before Miko's phase starts.
      if (odetteDone !== undefined) {
        const chongyunGains = run.steps.filter((s) => s.notes.some((n) => n.goalName === 'Chongyun' && n.kind === 'copy-gained'));
        for (const step of chongyunGains) expect(step.pull).toBeGreaterThan(odetteDone);
      }
    },
  },
  {
    id: 'D4',
    description: 'per-phase 4-star pool check: 1 named 4-star in phase 0, 2 more in phase 2 (1+2 split, other direction)',
    seed: 14,
    goals: [
      fiveStarChar('o', 'Odette'),
      fourStarChar('a1', 'Alyosha', 'c4a', 5, ['o']),
      fiveStarWeapon('h', 'Homa', 'homa'),
      fiveStarChar('m', 'Miko'),
      fourStarChar('a2', 'Bennett', 'c4b', 5, ['m']),
      fourStarChar('a3', 'Chongyun', 'c4c', 5, ['m']),
    ],
    overrides: { pullBudget: 600 },
  },

  // ---- E: weapon Epitomized Path ----
  { id: 'E1', description: 'single 5star_weapon goal (baseline)', seed: 15, goals: [fiveStarWeapon('h', 'Homa', 'homa')] },
  {
    id: 'E2',
    description:
      "two LINKED 5star_weapon goals sharing ONE phase — KEY FIX: Epitomized Path retargets to WeaponB once WeaponA is claimed, so WeaponB also benefits from Fate Points. Since the fifteenth reported bug (2026-08-19), sharing a phase this way requires an explicit mutual link — see E5 for the same adjacency LEFT unlinked, which no longer shares anything. This seed's FIRST 5★ weapon pull lands on WeaponB (the 'other' featured weapon, correctly credited even though WeaponA is nominally 'chosen') and its SECOND is guaranteed WeaponA via the Fate Point that loss granted — confirms the other-weapon credit and the fate-point guarantee both work on this shared banner",
    seed: 4,
    goals: [fiveStarWeapon('wa', 'WeaponA', 'wa-id', 'wb'), fiveStarWeapon('wb', 'WeaponB', 'wb-id', 'wa')],
    overrides: { pullBudget: 400 },
    extraChecks: (run) => {
      const weaponSteps = run.steps.filter((s) => s.banner === 'weapon' && s.outcomeLabel.startsWith('5★'));
      expect(weaponSteps.length).toBeGreaterThanOrEqual(2);
      expect(weaponSteps[0].outcomeLabel).toContain('5★ featured, other weapon (WeaponB)');
      expect(weaponSteps[1].outcomeLabel).toContain('5★ featured (WeaponA)');
      expect(weaponSteps[1].outcomeLabel).toContain('fate point spent');
    },
  },
  {
    id: 'E3',
    description:
      "CROSS-PHASE FIX: WeaponA(phase0) -> CharDetour -> WeaponB(phase2) — WeaponB must get its OWN Fate Point benefit (distinct from E2's same-phase retarget fix). This seed's FIRST 5★ weapon pull once focus switches to WeaponB is a loss (the anonymous 'other' weapon, granting a Fate Point) and its SECOND is guaranteed WeaponB — confirms WeaponB's own phase gets a genuine fresh Epitomized Path selection, not a leftover from WeaponA's phase",
    seed: 8,
    goals: [fiveStarWeapon('wa', 'WeaponA', 'wa-id'), fiveStarChar('o', 'Odette'), fiveStarWeapon('wb', 'WeaponB', 'wb-id')],
    overrides: { pullBudget: 550 },
    extraChecks: (run) => {
      const wbSteps = run.steps.filter((s) => s.banner === 'weapon' && s.focusGoalName === 'WeaponB' && s.outcomeLabel.startsWith('5★'));
      expect(wbSteps.length).toBeGreaterThanOrEqual(2);
      expect(wbSteps[0].outcomeLabel.startsWith('5★ featured (WeaponB)')).toBe(false);
      expect(wbSteps[1].outcomeLabel).toContain('5★ featured (WeaponB)');
      expect(wbSteps[1].outcomeLabel).toContain('fate point spent');
    },
  },
  {
    id: 'E4',
    description: 'THREE separate weapon-banner phases in a row, each needs its own correct chosen identity',
    seed: 18,
    goals: [
      fiveStarWeapon('wa', 'WeaponA', 'wa-id'),
      fiveStarChar('o', 'Odette'),
      fiveStarWeapon('wb', 'WeaponB', 'wb-id'),
      fiveStarChar('m', 'Miko'),
      fiveStarWeapon('wc', 'WeaponC', 'wc-id'),
    ],
    overrides: { pullBudget: 750 },
  },
  {
    id: 'E5',
    description:
      'FIFTEENTH REPORTED BUG, case 2: [WeaponA, WeaponB] adjacent but explicitly UNLINKED — genuinely two different real weapon-banner phases (e.g. already own both characters), so NO opportunistic sharing and NO Fate Point carry between them, unlike E2\'s linked pair',
    seed: 29,
    goals: [fiveStarWeapon('wa', 'WeaponA', 'wa-id'), fiveStarWeapon('wb', 'WeaponB', 'wb-id')],
    overrides: { pullBudget: 400 },
  },
  {
    id: 'E6',
    description:
      "FIFTEENTH REPORTED BUG, case 1: [Odette, OdetteWeapon, Raiden, RaidenWeapon] — Odette/Raiden are one real phase's two simultaneous character banners (now ALSO explicitly linked to each other, per the sixteenth-bug follow-up that relaxed linkedCharacterGoalId to tolerate a weapon-banner goal sandwiched between a linked pair), and OdetteWeapon/RaidenWeapon are that SAME real phase's one shared weapon banner's two weapons. Priority-order interleaving with the character goals splits them into 4 separate Phase objects regardless of either link — this seed shows RaidenWeapon actually landing (and getting credited) DURING OdetteWeapon's own phase, before Raiden's own phase has even started, via the explicit weapon link",
    seed: 147,
    goals: [
      fiveStarChar('o', 'Odette', 'r'),
      fiveStarWeapon('ow', 'OdetteWeapon', 'odette-weapon-id', 'rw'),
      fiveStarChar('r', 'Raiden', 'o'),
      fiveStarWeapon('rw', 'RaidenWeapon', 'raiden-weapon-id', 'ow'),
    ],
    overrides: { pullBudget: 500 },
  },

  // ---- F: weapon 4-stars ----
  {
    id: 'F1',
    description: 'weapon 4-stars (R4) split across two weapon-banner phases (2+2, total=4, at the total cap)',
    seed: 19,
    goals: [
      fiveStarWeapon('wa', 'WeaponA', 'wa-id'),
      fourStarWeapon('r1', 'RuinsA', 'r4a', 4, ['wa']),
      fourStarWeapon('r2', 'RuinsB', 'r4b', 4, ['wa']),
      fiveStarChar('o', 'Odette'),
      fiveStarWeapon('wb', 'WeaponB', 'wb-id'),
      fourStarWeapon('r3', 'RuinsC', 'r4c', 4, ['wb']),
      fourStarWeapon('r4', 'RuinsD', 'r4d', 4, ['wb']),
    ],
    overrides: { pullBudget: 750 },
  },
  {
    id: 'F2',
    description: '4 named weapon 4-stars (R4) all in ONE phase (under the 5-wide per-phase cap)',
    seed: 20,
    goals: [
      fiveStarWeapon('wa', 'WeaponA', 'wa-id'),
      fourStarWeapon('r1', 'RuinsA', 'r4a', 4, ['wa']),
      fourStarWeapon('r2', 'RuinsB', 'r4b', 4, ['wa']),
      fourStarWeapon('r3', 'RuinsC', 'r4c', 4, ['wa']),
      fourStarWeapon('r4', 'RuinsD', 'r4d', 4, ['wa']),
    ],
    overrides: { pullBudget: 600 },
  },

  // ---- G: multi-phase kitchen sinks ----
  {
    id: 'G1',
    description: '5 phases alternating char/weapon/char/weapon/char, no 4-stars',
    seed: 21,
    goals: [
      fiveStarChar('o', 'Odette'),
      fiveStarWeapon('wa', 'WeaponA', 'wa-id'),
      fiveStarChar('m', 'Miko'),
      fiveStarWeapon('wb', 'WeaponB', 'wb-id'),
      fiveStarChar('r', 'Raiden'),
    ],
    overrides: { pullBudget: 750 },
  },
  {
    id: 'G2',
    description: 'kitchen sink — same 5 phases, with C5/R4 4-stars mixed in on both banners',
    seed: 22,
    goals: [
      fiveStarChar('o', 'Odette'),
      fourStarChar('a1', 'Alyosha', 'c4a', 5, ['o']),
      fiveStarWeapon('wa', 'WeaponA', 'wa-id'),
      fourStarWeapon('r1', 'RuinsA', 'r4a', 4, ['wa']),
      fiveStarChar('m', 'Miko'),
      fourStarChar('a2', 'Bennett', 'c4b', 5, ['m']),
      fiveStarWeapon('wb', 'WeaponB', 'wb-id'),
      fourStarWeapon('r2', 'RuinsB', 'r4b', 4, ['wb']),
      fiveStarChar('r', 'Raiden'),
      fourStarChar('a3', 'Chongyun', 'c4c', 5, ['r']),
    ],
    overrides: { pullBudget: 850 },
  },

  // ---- H: CR model comparison, same structure ----
  {
    id: 'H1',
    description: 'Hypothesis A, 6 5star_character goals in 3 weapon-detour-separated phases (2 per phase, at the cap) — watch the r counter climb/reset across many 50/50s',
    seed: 3,
    goals: sixFiveStarsWithDetours(),
    overrides: { pullBudget: 950, crModelId: 'A' as CRHypothesisId },
  },
  {
    id: 'H2',
    description: 'Hypothesis B, SAME structure and seed — every 50/50 still shows its real transition regardless of model',
    seed: 3,
    goals: sixFiveStarsWithDetours(),
    overrides: { pullBudget: 950, crModelId: 'B' as CRHypothesisId },
  },

  // ---- I: non-zero starting states ----
  {
    id: 'I1',
    description: 'both banners starting near hard pity (guaranteed win essentially immediately)',
    seed: 23,
    goals: [fiveStarChar('o', 'Odette'), fiveStarWeapon('h', 'Homa', 'homa')],
    overrides: {
      pullBudget: 150,
      characterBanner: { state: { ...zeroCharState, pity5: 89, guaranteed5: false }, featured5StarId: FEATURED_5STAR },
      weaponBanner: { state: { ...zeroWeaponState, pity5: 79 } },
    },
  },
  {
    id: 'I2',
    description: 'both banners starting already-guaranteed/fate-pointed — next 5-star is a lock',
    seed: 24,
    goals: [fiveStarChar('o', 'Odette'), fiveStarWeapon('h', 'Homa', 'homa')],
    overrides: {
      pullBudget: 350,
      characterBanner: { state: { ...zeroCharState, guaranteed5: true, crCounter: 2 }, featured5StarId: FEATURED_5STAR },
      weaponBanner: { state: { ...zeroWeaponState, fatePoints: 1 } },
    },
  },
];

describe('trace survey — optimal-pulling sanity sweep (v3)', () => {
  for (const scenario of scenarios) {
    it(`${scenario.id}: ${scenario.description}`, () => {
      const input = baseInput({ goals: scenario.goals, ...scenario.overrides });
      const run = traceOneRun(input, scenario.seed);
      console.log(`\n########## ${scenario.id}: ${scenario.description} (seed ${scenario.seed}) ##########`);
      console.log(formatGoalRoster(scenario.goals));
      console.log('');
      const { summary, log } = formatTrace(run, input.goals);
      console.log(summary);
      console.log('');
      console.log('Pull-by-pull log:');
      console.log(log);

      // ---- generic sanity, applied to every scenario ----
      // Every scenario must be a goal list a real user could actually submit
      // — i.e. one validateGoals accepts. Catches scenario authoring drift
      // into configurations that don't correspond to any real structure (see
      // this file's own doc comment for the C-series bug this caught).
      expect(validateGoals(scenario.goals)).toEqual([]);
      expect(run.steps.length).toBeGreaterThan(0);
      for (const donePull of run.goalDoneAtPull.values()) {
        expect(donePull).toBeLessThanOrEqual(input.pullBudget);
        expect(donePull).toBeGreaterThan(0);
      }
      // Every character-banner 5-star pull must carry a real pre->post CR
      // transition annotation — regression guard for the guaranteed-win
      // mislabeling bug (CLAUDE.md's trace.ts crAnnotation history).
      for (const step of run.steps) {
        if (step.banner === 'character' && step.outcomeLabel.startsWith('5★')) {
          expect(step.outcomeLabel).toMatch(/\[(50\/50|guaranteed win)/);
        }
      }

      scenario.extraChecks?.(run, input);
    });
  }
});
