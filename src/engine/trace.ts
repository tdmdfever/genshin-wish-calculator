import { CR_MODELS } from './capturingRadiance';
import { isFourStarKind, levelLabel, targetLevelOf } from './goalKinds';
import { createRng } from './rng';
import { buildTrialInfo, countClaimedRanks, isFiveStarClaimBlocked, stepOnePull, type TraceNote, type TrialInfo } from './simulate';
import type { BannerKind, Goal, PullOutcome, SimulationInput, WeaponBannerState } from './types';

/**
 * "Why does the engine believe this" tooling, complementing the numeric checks: runs ONE concrete
 * pull-by-pull playthrough with `stepOnePull` — the same per-pull logic runSimulation uses, not a
 * reimplementation — and narrates it in plain language, so you can judge whether the pulling order
 * makes sense for a priority list. See FOCUS_RULES.md for the rules to check it against, and
 * trace.test.ts / trace.survey.test.ts for examples. Also backs the app's trace panel.
 */

export interface TraceStep {
  pull: number;
  banner: BannerKind;
  focusGoalName: string;
  /** Set when a 4-star goal is earlier in priority than `focusGoalName` but
   * isn't actually gating it (opportunistically accruing in parallel) — see
   * computeFocusDisplayName's doc comment for why `focusGoalName` itself is
   * NOT simply "the next incomplete goal by list position". */
  alsoAccruingGoalName?: string;
  outcomeLabel: string;
  notes: TraceNote[];
  /** True for any 5★ pull (even untracked — see below), and for a 4★-featured
   * pull that lands on the shared rate-up pool's untracked slot(s) — e.g. if
   * you're tracking 2 of a character banner's 3 real featured 4★s, roughly 1/3
   * of ALL featured-4★ hits go to the one you're not naming, invisibly, unless
   * shown explicitly. Without this, a run of hits that happen to land on one
   * tracked goal and never another looks more surprising than it is: you can't
   * tell "5 out of 5 total rolls" (a real ~1-in-100 tail) from "5 out of 15,
   * with 10 quiet misses to the untracked slot in between" (unremarkable) unless
   * the untracked misses are visible too — collapsing them into ordinary
   * no-effect pulls hides exactly the denominator you'd need to judge that.
   *
   * A 5★ is notable regardless of tracking because it's ALSO mechanically
   * significant beyond goal-matching (resets pity5, and depending on outcome
   * can set guaranteed5 / advance the Capturing Radiance counter / grant a
   * weapon-banner Fate Point) — that part doesn't apply to 4★s, which only ever
   * reset pity4/guaranteed4 regardless of which slot they land on, so an
   * untracked 4★ hit is notable purely for the "which slot got it" bookkeeping,
   * not for any hidden state-setup effect the way an untracked 5★ is. */
  notable: boolean;
}

export interface TraceRun {
  steps: TraceStep[];
  finalBitmask: number;
  goalDoneAtPull: Map<string, number>; // goalId -> first pull it became done, if any within budget
}

/**
 * Capturing Radiance annotation for a character-banner 5★ pull: the real pre→post counter
 * transition, read off the resulting state rather than inferred — inferring a category ("organic",
 * "CR-triggered") went wrong for guaranteed wins (which skip the 50/50 and keep the counter) and
 * only fit Hypothesis A.
 */
function crAnnotation(banner: BannerKind, preCrCounter: number, postCrCounter: number, preGuaranteed5: boolean, outcome: PullOutcome): string {
  if (banner !== 'character' || outcome.rarity !== 5) return '';
  if (preGuaranteed5) {
    // Always a win (the guaranteed branch has no loss outcome) — r carries over
    // unchanged, whatever it was, since resolve50_50 (and therefore Capturing
    // Radiance's own resolution) never runs for this pull. postCrCounter is
    // always === preCrCounter here; shown anyway for a uniform format.
    return ` [guaranteed win, unrelated to Capturing Radiance — r: ${preCrCounter}→${postCrCounter}]`;
  }
  const isWin = outcome.kind === 'featured';
  return ` [50/50: r ${preCrCounter}→${postCrCounter}, ${isWin ? 'WON' : 'lost'}]`;
}

/**
 * Weapon-banner annotation for a 5★ weapon pull: the real Fate Point / guaranteed5 transition, since
 * the two mechanics interact (see weaponBanner.ts). `preWeaponState`/`postWeaponState` must be
 * stepOnePull's `weaponStateUsed`/`weaponState` — the state after any phase-entry Fate Point reset.
 */
function weaponAnnotation(banner: BannerKind, outcome: PullOutcome, preWeaponState: WeaponBannerState, postWeaponState: WeaponBannerState): string {
  if (banner !== 'weapon' || outcome.rarity !== 5) return '';
  const fp = `FP ${preWeaponState.fatePoints}→${postWeaponState.fatePoints}`;
  const g5 = `guaranteed-featured ${preWeaponState.guaranteed5}→${postWeaponState.guaranteed5}`;
  if (preWeaponState.fatePoints === 1) {
    // A fate point fully overrides — 100% your chosen weapon, regardless of
    // guaranteed5's value (see weaponBanner.ts). Both flags reset.
    return ` [fate point spent — guaranteed your chosen weapon; ${fp}, ${g5}]`;
  }
  if (preWeaponState.guaranteed5) {
    // The standalone 75/25 pity guarantee, active on its own (no fate point) —
    // this is the case that only becomes reachable/observable once fatePoints
    // has reset (e.g. after a phase boundary), since within one phase a
    // standard loss also grants a fate point that would otherwise dominate.
    const won = outcome.kind === 'featured';
    return ` [guaranteed featured (no fate point) — 50/50 between the two: ${won ? 'WON your chosen' : 'got the OTHER'}; ${fp}, ${g5}]`;
  }
  if (outcome.kind === 'standard') {
    return ` [natural 75/25 roll: standard — next 5★ weapon now guaranteed featured (could be either); ${fp}, ${g5}]`;
  }
  const won = outcome.kind === 'featured';
  return ` [natural 75/25 roll: ${won ? 'your chosen weapon' : 'the OTHER featured weapon'}; ${fp}, ${g5}]`;
}

function describeOutcome(
  outcome: PullOutcome,
  goals: Goal[],
  banner: BannerKind,
  preCrCounter: number,
  postCrCounter: number,
  preGuaranteed5: boolean,
  preWeaponState: WeaponBannerState,
  postWeaponState: WeaponBannerState,
): string {
  const cr = crAnnotation(banner, preCrCounter, postCrCounter, preGuaranteed5, outcome);
  const weaponCr = weaponAnnotation(banner, outcome, preWeaponState, postWeaponState);
  if (outcome.rarity === 3) return '3★';
  if (outcome.rarity === 4 && outcome.kind === 'standard') return '4★ (standard, not rate-up)';
  if (outcome.rarity === 5 && outcome.kind === 'standard') return `5★ (standard banner)${cr}${weaponCr}`;
  // 5★ character goals all share the banner's one featured id, so looking one up by itemId would
  // name the first such goal even when a later one claimed the win — the notes name the claimant.
  if (outcome.rarity === 5 && outcome.kind === 'featured' && banner === 'character') return `5★ featured (the featured character)${cr}`;
  const matchedGoal = goals.find((g) => g.targetId === outcome.itemId);
  if (outcome.rarity === 4 && outcome.kind === 'featured') {
    // Unnamed rate-up slots are placeholder ids (phases.ts's padIds); label them generically.
    return matchedGoal ? `4★ featured (${matchedGoal.name})` : '4★ featured (untracked rate-up slot)';
  }
  const itemLabel = matchedGoal?.name ?? outcome.itemId;
  if (outcome.rarity === 5 && outcome.kind === 'featured') return `5★ featured (${itemLabel})${weaponCr}`;
  if (outcome.rarity === 5 && outcome.kind === 'featured_other') return `5★ featured, other weapon (${itemLabel})${weaponCr}`;
  return JSON.stringify(outcome);
}

/**
 * What a player would say they're pulling toward. The phase comes from `currentPhaseIndex` (the same
 * scan stepOnePull uses); within it, the primary name is the next unclaimed 5★ character rank — not
 * the next incomplete goal by list position, since an earlier-listed 4★ that doesn't gate anything
 * just accrues along the way ([Odette, Homa, Alyosha(→Odette+Miko), Miko]: "pulling for Miko,
 * picking up Alyosha"). When isFiveStarClaimBlocked holds the next rank, the blocking 4★ is the
 * primary name instead ("waiting on Alyosha"). `naiveFocusIdx` (next incomplete by position) only
 * feeds the "also accruing" name. Display only — the odds never depend on this.
 */
function computeFocusDisplayName(
  info: TrialInfo,
  goals: Goal[],
  bitmask: number,
  copyCounts: Int32Array,
  naiveFocusIdx: number,
  currentPhaseIndex: number,
): { primaryName: string; alsoAccruingName?: string } {
  const naiveFocusGoal = goals[naiveFocusIdx];
  const banner = info.bannerByPhase[currentPhaseIndex];
  if (banner !== 'character') return { primaryName: naiveFocusGoal.name };
  const fiveStarIdsInPhase = info.fiveStarCharGoalIdsByPhase[currentPhaseIndex];
  if (fiveStarIdsInPhase.length === 0) return { primaryName: naiveFocusGoal.name };

  const claimedRanks = countClaimedRanks(fiveStarIdsInPhase, info.goalIndexById, bitmask);
  if (claimedRanks >= fiveStarIdsInPhase.length) return { primaryName: naiveFocusGoal.name }; // every 5-star in this phase already claimed

  const nextGoalId = fiveStarIdsInPhase[claimedRanks];
  const blockingGoal = isFiveStarClaimBlocked(goals, info.phaseIndexByGoalId, info.goalIndexById, bitmask, copyCounts, currentPhaseIndex, nextGoalId, info.characterWindowPartnerByPhase);
  const primaryName = blockingGoal ? blockingGoal.name : goals[info.goalIndexById.get(nextGoalId)!].name;
  if (primaryName === naiveFocusGoal.name) return { primaryName };
  // "also accruing" means the naive goal is a REAL, currently-open passenger on
  // THIS phase's own pulls (e.g. anchored to both this phase's 5-star and a
  // later one) — not just "incomplete and listed earlier." A closed 4-star
  // (e.g. disconnected from every listed phase, per issue 1.5.5) is NOT
  // actually accruing anything here — showing it as "also accruing" was a
  // real, misleading trace bug, found by the user reading the narration
  // directly: it implied progress that the underlying simulation never
  // grants (her window stays shut this whole phase; closedGoalIdsByPhase
  // already reflects this, `applyOutcome` never lets her claim a copy here).
  const isNaiveFocusOpenHere = !info.closedGoalIdsByPhase[currentPhaseIndex].has(naiveFocusGoal.id);
  return isNaiveFocusOpenHere ? { primaryName, alsoAccruingName: naiveFocusGoal.name } : { primaryName };
}

/**
 * Walks ONE random pull-by-pull playthrough of `input` (fixed seed, so it's
 * reproducible), stopping early once every goal is done. Reuses
 * `simulate.ts`'s own `buildTrialInfo`/`stepOnePull` — the same functions
 * `runSimulation` calls in its statistics loop — so this is a faithful
 * walkthrough of the Monte Carlo engine's actual reasoning, not a parallel
 * reimplementation that could itself drift from what's really being computed.
 */
export function traceOneRun(input: SimulationInput, seed: number): TraceRun {
  const { goals, pullBudget, crModelId } = input;
  const crModel = CR_MODELS[crModelId];
  const info = buildTrialInfo(goals, input.characterBanner.featured5StarId);
  const rng = createRng(seed);
  let charState = { ...input.characterBanner.state };
  let weaponState = { ...input.weaponBanner.state };
  let bitmask = 0;
  let maxPhaseIndexSeen = -1;
  const copyCounts = new Int32Array(goals.length);
  const steps: TraceStep[] = [];
  const goalDoneAtPull = new Map<string, number>();

  for (let p = 1; p <= pullBudget; p++) {
    if (bitmask === info.fullMask) break;
    // Same phase scan as stepOnePull (-1 is defensive only).
    const currentPhaseIndex = info.blockingGoalIdsByPhase.findIndex((ids) => !ids.every((id) => (bitmask & (1 << info.goalIndexById.get(id)!)) !== 0));
    if (currentPhaseIndex === -1) break;
    const focusIdx = goals.findIndex((_, idx) => !(bitmask & (1 << idx)));
    const { primaryName: focusGoalName, alsoAccruingName } = computeFocusDisplayName(info, goals, bitmask, copyCounts, focusIdx, currentPhaseIndex);
    const preCrCounter = charState.crCounter;
    const preGuaranteed5 = charState.guaranteed5;
    const notes: TraceNote[] = [];
    const result = stepOnePull(info, input, crModel, charState, weaponState, bitmask, copyCounts, rng, maxPhaseIndexSeen, notes);
    charState = result.charState;
    weaponState = result.weaponState;
    maxPhaseIndexSeen = result.maxPhaseIndexSeen;
    const postCrCounter = charState.crCounter;

    for (let idx = 0; idx < goals.length; idx++) {
      const wasDone = (bitmask & (1 << idx)) !== 0;
      const nowDone = (result.bitmask & (1 << idx)) !== 0;
      if (!wasDone && nowDone) goalDoneAtPull.set(goals[idx].id, p);
    }
    bitmask = result.bitmask;

    const outcome = result.outcome!;
    const isUntrackedFourStarFeatured = outcome.rarity === 4 && outcome.kind === 'featured' && !goals.some((g) => g.targetId === outcome.itemId);
    steps.push({
      pull: p,
      banner: result.banner!,
      focusGoalName,
      alsoAccruingGoalName: alsoAccruingName,
      outcomeLabel: describeOutcome(outcome, goals, result.banner!, preCrCounter, postCrCounter, preGuaranteed5, result.weaponStateUsed, result.weaponState),
      notes,
      notable: outcome.rarity === 5 || isUntrackedFourStarFeatured,
    });
  }

  return { steps, finalBitmask: bitmask, goalDoneAtPull };
}

export interface FormattedTrace {
  /** Goal-by-goal outcome, headline-first — meant to be read BEFORE the full
   * log, so "did this work" is answerable without scrolling past the whole
   * pull-by-pull story. */
  summary: string;
  /** The full pull-by-pull narration, grouped into focus sections. */
  log: string;
}

/**
 * Formats a run as `{ summary, log }`: the summary is when each goal finished; the log is sectioned
 * by focus, with consecutive no-effect, non-notable pulls collapsed into one line so the decision
 * points stand out — copies gained, goals done, wins wasted/blocked, windows closed, focus changes,
 * and every 5★ (even an untracked one: it still sets guaranteed5, moves the CR counter or grants a
 * Fate Point). Split so the trace panel can show the summary and tuck the long log away.
 */
export function formatTrace(run: TraceRun, goals: Goal[]): FormattedTrace {
  const summaryLines: string[] = [];
  const doneCount = goals.filter((g) => run.goalDoneAtPull.has(g.id)).length;
  summaryLines.push(`Result: ${doneCount}/${goals.length} goals done within budget.`);
  for (const goal of goals) {
    const donePull = run.goalDoneAtPull.get(goal.id);
    summaryLines.push(`  ${goal.name}: ${donePull !== undefined ? `done at pull ${donePull}` : 'not done within budget'}`);
  }

  // Sections of consecutive steps with the same focus (banner + focus goal + also-accruing goal),
  // built in a first pass so each header can show its pull range. Banner alone isn't enough: focus
  // can shift within one same-banner run (a 5★ is won, a blocking 4★ catches up).
  interface Section {
    banner: string;
    focusGoalName: string;
    alsoAccruingGoalName?: string;
    steps: TraceStep[];
  }
  const sections: Section[] = [];
  for (const step of run.steps) {
    const focusKey = `${step.banner}|${step.focusGoalName}|${step.alsoAccruingGoalName ?? ''}`;
    const last = sections[sections.length - 1];
    const lastKey = last ? `${last.banner}|${last.focusGoalName}|${last.alsoAccruingGoalName ?? ''}` : null;
    if (focusKey !== lastKey) {
      sections.push({ banner: step.banner, focusGoalName: step.focusGoalName, alsoAccruingGoalName: step.alsoAccruingGoalName, steps: [step] });
    } else {
      last.steps.push(step);
    }
  }

  const logLines: string[] = [];
  for (const section of sections) {
    const firstPull = section.steps[0].pull;
    const lastPull = section.steps[section.steps.length - 1].pull;
    const count = section.steps.length;
    const also = section.alsoAccruingGoalName ? `, also accruing: ${section.alsoAccruingGoalName}` : '';
    logLines.push(
      `── pulls ${firstPull}-${lastPull} (${count} pull${count === 1 ? '' : 's'}): focus: ${section.banner} banner (toward ${section.focusGoalName}${also}) ──`,
    );

    let boringRunStart: number | null = null;
    const flushBoringRun = (throughPull: number) => {
      if (boringRunStart === null) return;
      const boringCount = throughPull - boringRunStart + 1;
      logLines.push(`  (pulls ${boringRunStart}-${throughPull}: ${boringCount} pull${boringCount === 1 ? '' : 's'}, no effect)`);
      boringRunStart = null;
    };

    for (const step of section.steps) {
      if (step.notes.length === 0 && !step.notable) {
        if (boringRunStart === null) boringRunStart = step.pull;
        continue;
      }
      flushBoringRun(step.pull - 1);
      let noteText: string;
      if (step.notes.length > 0) {
        noteText = step.notes.map((n) => `${n.goalName}: ${n.detail}`).join('; ');
      } else if (step.outcomeLabel.startsWith('4★')) {
        // A 4★ pull only ever resets pity4/guaranteed4, the same way regardless of
        // which rate-up slot it lands on — unlike a 5★, there's no hidden
        // state-setup effect here. This is shown purely so a run of hits on one
        // tracked 4★ (or the lack of hits on another) can be judged against the
        // true total, not just the tracked-goal subset.
        noteText = "landed on the shared rate-up pool's untracked slot — not one of your named 4★s";
      } else {
        noteText = 'not a tracked goal, but resets pity5 / may set guaranteed5 or a Fate Point';
      }
      logLines.push(`pull ${step.pull} [${step.banner}]: ${step.outcomeLabel} — ${noteText}`);
    }
    flushBoringRun(lastPull);
  }

  return { summary: summaryLines.join('\n'), log: logLines.join('\n') };
}

/**
 * The goal list as a plain priority-order roster — {rarity}★ {banner} {name}, target level and
 * anchors for 4★s, and window-linking status for every 5★ weapon — so the trace can be read
 * against the list it came from.
 */
export function formatGoalRoster(goals: Goal[]): string {
  const nameById = new Map(goals.map((g) => [g.id, g.name]));
  const lines = goals.map((g, i) => {
    const rarity = g.kind.startsWith('5star') ? '5' : '4';
    let line = `  ${i + 1}. ${rarity}★ ${g.banner} ${g.name}`;
    if (isFourStarKind(g.kind)) {
      line += ` (target ${levelLabel(g.kind, targetLevelOf(g))}`;
      if (g.anchoredFiveStarGoalIds?.length) {
        line += `, anchored to: ${g.anchoredFiveStarGoalIds.map((id) => nameById.get(id) ?? id).join(', ')}`;
      }
      line += ')';
    }
    if (g.kind === '5star_weapon') {
      line += g.linkedWeaponGoalId
        ? ` (same window as: ${nameById.get(g.linkedWeaponGoalId) ?? g.linkedWeaponGoalId})`
        : ' (not linked to another weapon goal — its own window)';
    }
    if (g.kind === '5star_character') {
      line += g.linkedCharacterGoalId
        ? ` (simultaneous with: ${nameById.get(g.linkedCharacterGoalId) ?? g.linkedCharacterGoalId})`
        : ' (not linked to another 5★ character — its own sequential phase)';
    }
    return line;
  });
  return `Goals (priority order):\n${lines.join('\n')}`;
}
