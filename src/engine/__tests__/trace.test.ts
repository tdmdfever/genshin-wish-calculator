import { describe, expect, it } from 'vitest';
import { DEFAULT_CR_PARAMS } from '../capturingRadiance';
import { formatTrace, traceOneRun } from '../trace';
import type { CharacterBannerConfig, CharacterBannerState, Goal, SimulationInput, WeaponBannerState } from '../types';

/**
 * Runnable usage examples for trace.ts — "intent verification" tooling. Run any
 * of these with `npx vitest run trace --reporter=verbose` and read the printed
 * log: does the story it tells match what you'd expect for that priority list?
 * This is meant to replace ad hoc dev-server poking for exactly this question,
 * not to assert exact probabilities (that's what exactEngine.test.ts and
 * invariants.test.ts are for) — the assertions here just confirm the trace
 * completes and produces a sane structure; the log itself is the actual point.
 */

const charConfig: CharacterBannerConfig = { featured5StarId: 'char5', featured4StarIds: ['c4a', 'c4b', 'c4c'] };
const zeroCharState: CharacterBannerState = { pity5: 0, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false };
const zeroWeaponState: WeaponBannerState = { pity5: 0, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false };
function baseInput(overrides: Partial<SimulationInput>): SimulationInput {
  return { pullBudget: 90, characterBanner: { state: zeroCharState, featured5StarId: charConfig.featured5StarId }, weaponBanner: { state: zeroWeaponState }, crModelId: 'A', crParams: DEFAULT_CR_PARAMS, goals: [], trialCount: 1, ...overrides };
}

const odette: Goal = { id: 'o', name: 'Odette', kind: '5star_character', banner: 'character', targetId: 'char5' };
const miko: Goal = { id: 'm', name: 'Miko', kind: '5star_character', banner: 'character', targetId: 'char5' };

describe('trace tool — usage examples', () => {
  it('Odette → Alyosha (anchored to BOTH) → Miko: Miko should NOT be blocked by Alyosha', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', anchoredFiveStarGoalIds: ['o', 'm'] };
    const input = baseInput({ goals: [odette, alyosha, miko], pullBudget: 90 });
    const run = traceOneRun(input, 1);
    console.log('\n=== Odette -> Alyosha(anchored to BOTH) -> Miko ===');
    const { summary, log } = formatTrace(run, input.goals);
    console.log(`${summary}\n\n${log}`);
    expect(run.steps.length).toBeGreaterThan(0);
  });

  it('Odette → Alyosha (anchored to Odette ONLY) → Miko: look for "wasted-blocked" notes while Alyosha is short of target', () => {
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 1, anchoredFiveStarGoalIds: ['o'] };
    const input = baseInput({ goals: [odette, alyosha, miko], pullBudget: 90 });
    const run = traceOneRun(input, 2);
    console.log('\n=== Odette -> Alyosha(anchored to Odette ONLY, C1) -> Miko ===');
    const { summary, log } = formatTrace(run, input.goals);
    console.log(`${summary}\n\n${log}`);
    expect(run.steps.length).toBeGreaterThan(0);
  });

  it('the user-reported regression, in trace form: Odette → Homa(weapon) → Alyosha(anchored to Odette) — confirm pulling resumes on the character banner after Homa', () => {
    const homa: Goal = { id: 'h', name: 'Homa', kind: '5star_weapon', banner: 'weapon', targetId: 'chosen' };
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 1, anchoredFiveStarGoalIds: ['o'] };
    const input = baseInput({ goals: [odette, homa, alyosha], pullBudget: 150 });
    const run = traceOneRun(input, 3);
    console.log('\n=== Odette -> Homa(weapon) -> Alyosha(anchored to Odette, C1) — ninth-bug scenario ===');
    const { summary, log } = formatTrace(run, input.goals);
    console.log(`${summary}\n\n${log}`);
    // For seed 3 specifically (verified via the printed log above), Alyosha
    // isn't fully satisfied by the time Homa's weapon-banner phase finishes, so
    // the trace's own focus-banner markers must show the character banner
    // reappearing AFTER the weapon banner — exactly the behavior the ninth-bug
    // fix restored. Before the fix, this seed would show Alyosha stuck at 1
    // copy forever, no pull 117 line at all, and Alyosha absent from the summary.
    const banners = run.steps.map((s) => s.banner);
    const weaponIdx = banners.indexOf('weapon');
    expect(weaponIdx).toBeGreaterThan(-1);
    expect(banners.slice(weaponIdx).includes('character')).toBe(true);
    expect(run.goalDoneAtPull.has('a')).toBe(true);
  });

  it('Capturing Radiance in action: a genuine 50/50 resolution at r=2 vs. a guaranteed-pity win that coincidentally sits at r=2, found by seed search and pinned here', () => {
    // A SINGLE 5-star-character goal can never show the counter build past r=1 —
    // the run ends the instant that one goal is won, and a GUARANTEED win (after
    // a loss) never goes through the 50/50 resolution at all
    // (transitionCharacterBanner's `if (state.guaranteed5)` branch bypasses
    // crModel.resolve50_50 entirely), so the counter simply carries over
    // unchanged rather than ever getting a chance to climb further. Confirmed by
    // directly sampling: 500 seeds, single-goal list, 300-pull budget, the
    // counter never once exceeded 1. Needs several 5-star-character goals in a
    // row so pulling continues (and more real 50/50s get resolved) past each
    // guaranteed win — seed 1913 with 6 such goals over 400 pulls happens to
    // produce BOTH cases the trace tool needs to distinguish (see trace.ts's
    // crAnnotation doc comment for the bugs this pins down, found 2026-08-18):
    //   - pull 184: guaranteed5=true entering (from an earlier loss at r=1),
    //     labeled "[guaranteed win, unrelated to Capturing Radiance — r: 2→2]"
    //     — NOT a genuine r=2 CR resolution, even though r happens to read 2.
    //   - pull 262: guaranteed5=false entering, a genuine resolve50_50 win,
    //     labeled "[50/50: r 2→1, WON]" — the real pre->post transition, read
    //     directly off state rather than inferred/categorized (which is what
    //     let the mislabeling bug above happen in the first place, and also
    //     what made the old annotation silently wrong under CR Hypothesis B).
    // An earlier pinned seed (3) showed only the FIRST kind of event and had
    // been mislabeled as "a real r=2 boosted win" by the pre-fix annotation
    // logic — re-searched for a seed exhibiting the second, genuine kind too,
    // once the bug was found and fixed.
    const manyFiveStars: Goal[] = Array.from({ length: 6 }, (_, i) => ({
      id: `f${i}`,
      name: `Featured${i}`,
      kind: '5star_character',
      banner: 'character',
      targetId: 'char5',
    }));
    const input = baseInput({ goals: manyFiveStars, pullBudget: 400 });
    const run = traceOneRun(input, 1913);
    console.log('\n=== Capturing Radiance in action (6 successive 5-star-character goals) ===');
    const { summary, log } = formatTrace(run, input.goals);
    console.log(`${summary}\n\n${log}`);
    const genuineCrHits = run.steps.filter((s) => s.outcomeLabel.includes('[50/50: r 2'));
    const guaranteedHits = run.steps.filter((s) => s.outcomeLabel.includes('[guaranteed win'));
    expect(genuineCrHits.length).toBeGreaterThan(0);
    expect(guaranteedHits.length).toBeGreaterThan(0);
  });

  it('the twelfth reported bug, in trace form: a same-phase 4-star extending phase0 past its own 5-star must not let a featured win during that stretch leak credit to a LATER phase\'s 5-star, before the intervening weapon detour even starts', () => {
    // Found 2026-08-18 by the user reviewing the trace survey: for
    // [Odette, Alyosha(anchored to Odette only), Homa(weapon detour), Miko],
    // simulate.ts's 5star_character claiming loop had NO phase-boundary check
    // at all — the earliest not-yet-done 5star_character goal in PRIORITY
    // ORDER claimed any featured win, regardless of which phase the pull was
    // actually happening in. Since Alyosha's window stays open through the
    // whole of phase0 (correctly — see the "same phase anchor never closes
    // early" rule), a featured win landing during that extended stretch — well
    // before Homa's own weapon-banner phase even begins — was getting credited
    // to Miko, a goal whose own real-world phase hadn't structurally started.
    // Confirmed via exact-vs-Monte-Carlo comparison this was a real ~30%
    // overstatement in simulate.ts specifically (the exact engine's
    // PhaseLocalSpec is naturally immune, since each phase's own DP only ever
    // knows about its own phase's 5star_character goals) — never affected the
    // live app, but did make the trace tool's narration wrong for this shape.
    // Fixed by gating 5star_character claiming to only fire when the
    // candidate goal's own phase equals the CURRENT PULL's actual phase.
    const alyosha: Goal = { id: 'a', name: 'Alyosha', kind: '4star_character', banner: 'character', targetId: 'c4a', targetLevel: 3, anchoredFiveStarGoalIds: ['o'] };
    const homa: Goal = { id: 'h', name: 'Homa', kind: '5star_weapon', banner: 'weapon', targetId: 'homa' };
    const input = baseInput({ goals: [odette, alyosha, homa, miko], pullBudget: 400 });
    const run = traceOneRun(input, 14);
    console.log("\n=== twelfth reported bug: Odette -> Alyosha(anchored to Odette only) -> Homa(weapon) -> Miko ===");
    const { summary, log } = formatTrace(run, input.goals);
    console.log(`${summary}\n\n${log}`);
    const homaDone = run.goalDoneAtPull.get('h');
    const mikoDone = run.goalDoneAtPull.get('m');
    // Miko can never be done before the weapon detour (Homa) itself finishes —
    // her own phase can't structurally start until the intervening phase does.
    if (homaDone !== undefined && mikoDone !== undefined) {
      expect(mikoDone).toBeGreaterThan(homaDone);
    }
    // No character-banner featured win before Homa is done may claim Miko.
    for (const step of run.steps) {
      if (homaDone !== undefined && step.pull > homaDone) break;
      if (step.notes.some((n) => n.goalName === 'Miko' && n.kind === 'done')) {
        throw new Error(`Miko was claimed at pull ${step.pull}, before Homa (pull ${homaDone}) even finished`);
      }
    }
  });
});
