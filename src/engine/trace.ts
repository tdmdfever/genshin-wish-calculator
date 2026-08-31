import { CR_MODELS } from './capturingRadiance';
import { createRng } from './rng';
import { buildTrialInfo, countClaimedRanks, isFiveStarClaimBlocked, stepOnePull, type TraceNote, type TrialInfo } from './simulate';
import type { BannerKind, Goal, PullOutcome, SimulationInput, WeaponBannerState } from './types';

/**
 * "Intent verification" tooling — a companion to invariants.test.ts, not a
 * replacement for it. Cross-validation (exactEngine.test.ts) and invariants
 * (invariants.test.ts) both tell you WHETHER the numbers are right; neither tells
 * you WHY the engine believes what it believes for a specific goal list. This
 * runs ONE concrete pull-by-pull playthrough — using `stepOnePull`, the exact
 * same per-pull logic `runSimulation` uses for its statistics, not a separate
 * reimplementation — and narrates it in plain language, so you can read the story
 * and judge "does this make sense for this priority?" the way you already do by
 * eyeballing the dev server, but without needing to actually add goals and wait.
 *
 * See FOCUS_RULES.md for the rules this is meant to help you check by eye, and
 * trace.test.ts for runnable examples (including the two user-reported bugs from
 * this session, as worked examples of what a real bug looks like in trace form).
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
 * Capturing Radiance annotation for a character-banner 5★ pull — shows the REAL
 * pre→post counter transition for every such pull, not an inferred label.
 *
 * Earlier versions of this function tried to CATEGORIZE each pull ("organic",
 * "CR-triggered", "boosted win zone") by inferring from the pre-pull counter
 * alone, using logic hardcoded to Hypothesis A's specific r=2/r=3 rules. That was
 * wrong twice over, both found 2026-08-18: (1) it didn't check `guaranteed5`, so
 * a win that happened to be guaranteed (bypasses `crModel.resolve50_50` and
 * Capturing Radiance's own resolution entirely, carrying `crCounter` over
 * UNCHANGED) got mislabeled as a genuine CR-zone resolution whenever it
 * coincided with r=1/2/3 (reachable via a loss at r=0/1/2 respectively, which
 * always sets `guaranteed5=true` in that same transition); (2) even after fixing
 * that, the remaining r=2/r=3 labels were still hardcoded to Hypothesis A's
 * specific rules and produced byte-identical, misleading output when Hypothesis
 * B (a different model with different rules) was actually running the
 * simulation. Both problems disappear by not inferring/categorizing at all —
 * `postCrCounter` (the counter AFTER this pull, read directly off the real
 * resulting state, not guessed) already tells the whole story regardless of
 * which CR model or mechanic path produced it, so this just reports the raw
 * transition and lets the reader judge "does this make sense" themselves.
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
 * Weapon-banner annotation for a 5★ weapon pull — the weapon-side counterpart
 * to crAnnotation, showing the REAL fate-point / guaranteed5 story rather
 * than an inferred label, for the same reason: guessing from one flag alone
 * risks getting the two independent mechanics' interaction wrong. Added
 * 2026-08-19 at the user's request, after they flagged (correctly — see
 * weaponBanner.ts's transitionWeaponBanner doc comment) that the engine was
 * missing the standalone 75/25 "guaranteed featured" pity mechanic entirely,
 * conflating it with Epitomized Path Fate Points.
 *
 * `preWeaponState`/`postWeaponState` must be the state actually fed into
 * transitionWeaponBanner and the state it returned — i.e. `stepOnePull`'s
 * `weaponStateUsed`/`weaponState` — not whatever the caller's own `weaponState`
 * variable held BEFORE the call, since that may not yet reflect a phase-entry
 * fatePoints reset (see TrialInfo's resetFatePointsOnEntry).
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
  // 5star_character matching is identity-agnostic (see CLAUDE.md's "Why 5★
  // character goals ignore identity") — every 5star_character goal shares the
  // SAME targetId (the banner's one config.featured5StarId), so looking one up
  // by itemId here would always resolve to whichever such goal happens to be
  // first in the list, misleadingly implying THAT one was the claimant even when
  // a later-ranked goal actually claimed the win (the `notes` field, populated
  // from the real bitmask diff, is what correctly names the actual claimant).
  if (outcome.rarity === 5 && outcome.kind === 'featured' && banner === 'character') return `5★ featured (the featured character)${cr}`;
  const matchedGoal = goals.find((g) => g.targetId === outcome.itemId);
  if (outcome.rarity === 4 && outcome.kind === 'featured') {
    // Same identity-pool logic as the 5★-weapon case just above: the itemId is
    // a REAL slot in the shared rate-up pool (see buildSimulationInput.ts's
    // padding), but if it's one of the anonymous placeholder slots (nothing
    // names it), showing the raw placeholder id (e.g. "other-4star-char-0")
    // would be meaningless — labeled generically instead.
    return matchedGoal ? `4★ featured (${matchedGoal.name})` : '4★ featured (untracked rate-up slot)';
  }
  const itemLabel = matchedGoal?.name ?? outcome.itemId;
  if (outcome.rarity === 5 && outcome.kind === 'featured') return `5★ featured (${itemLabel})${weaponCr}`;
  if (outcome.rarity === 5 && outcome.kind === 'featured_other') return `5★ featured, other weapon (${itemLabel})${weaponCr}`;
  return JSON.stringify(outcome);
}

/**
 * The naive "next incomplete goal by priority-list position" (`goals.findIndex`)
 * is the CORRECT concept for choosing which BANNER to pull on (matches
 * `stepOnePull`'s own real logic) — but is a MISLEADING "what are we pulling
 * toward" narration whenever that goal is a 4-star that doesn't actually gate
 * anything: 4-star accrual is opportunistic (governed by anchor windows, not
 * priority position), so an earlier-listed-but-non-blocking 4-star can sit
 * "next" in priority order for dozens of pulls while the banner's REAL
 * sequential target — the next unclaimed 5star_character rank in this phase,
 * per FIFO — is actually a LATER-listed goal. Found 2026-08-18 reviewing trace
 * output "would this make sense to an actual player": a real player pursuing
 * [Odette, Homa, Alyosha(anchored to both Odette+Miko), Miko] would say "I'm
 * pulling for Miko, picking up Alyosha's copies along the way" — not "I'm
 * focusing on Alyosha instead of Miko", even though Alyosha is listed first.
 * Confirmed this was PURELY a display concern, never a computation bug: the
 * real FIFO/anchor-gating logic (`fiveStarCharGoalIdsByPhase`) is built from
 * the 5-star goals' OWN relative order, independent of where any 4-star sits,
 * so Alyosha's list position never actually affected Miko's odds.
 *
 * MUST also account for `isFiveStarClaimBlocked` (found the same day, testing
 * this very fix): once Odette is won, if Alyosha is anchored to Odette ONLY
 * (not Miko too) and hasn't reached her own target, the next featured win is
 * NOT actually progressing toward Miko at all — it's blocked, absorbed as
 * another copy of Odette's own (already-claimed) rank, per FOCUS_RULES.md's
 * Rule B. A first version of this function ignored that and reported "Miko" as
 * primary the instant Odette was won, which is wrong in exactly the cases where
 * it matters most: a real player in this state would say "I'm stuck waiting on
 * Alyosha, haven't actually started on Miko yet" — so when blocked, the
 * BLOCKING 4-star becomes the primary name instead.
 *
 * UPDATE (2026-08-19, "4★ anchoring is phase-derived" fix): `naiveFocusIdx`'s
 * OWN NATAL phase is no longer a reliable source for "which phase are we
 * actually pulling toward" — a 4★'s resolved BLOCKING phase (see phases.ts's
 * resolveFourStarBlockingPhase) can now differ from where it's textually
 * positioned. `currentPhaseIndex` (computed the SAME way `stepOnePull` computes
 * its own real focus — see TrialInfo's blockingGoalIdsByPhase) is the actual
 * source of truth now; `naiveFocusIdx` is kept only to detect "also accruing"
 * (an earlier-listed, still-incomplete goal that isn't what's actually gating).
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
    // Mirrors stepOnePull's own phase-scan exactly (see TrialInfo's
    // blockingGoalIdsByPhase doc comment and stepOnePull's own comment on why
    // -1 is now believed unreachable for any real, validated goal list —
    // twentieth-reported-bug follow-up, 2026-08-21 — kept as a defensive
    // fallback, not a live path).
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
 * Renders a TraceRun as a readable multi-line log, split into a short
 * `summary` (goal outcomes, meant to be read first) and the full `log`
 * (grouped into focus sections, each labeled with its pull range so a reader
 * can see how long a stretch took without counting lines). Consecutive pulls
 * with no effect AND no notable outcome (the overwhelming majority, since most
 * pulls are 3-stars or off-rate-up 4-stars) are collapsed into one summary
 * line instead of printed individually, so the log stays focused on the
 * decision points that actually matter for "does this make sense" review:
 * copies gained, goals completed, wins wasted/blocked, windows closed,
 * banner-focus changes, and every 5★ pull — even an off-banner one that
 * matches no tracked goal, since it's still what sets guaranteed5 / advances
 * the Capturing Radiance counter / grants a weapon Fate Point, and silently
 * hiding it is exactly what makes a later goal's "why did this take so many
 * extra pulls" hard to answer by eye.
 *
 * Split into `{ summary, log }` (2026-08-19, at the user's request — "this is
 * hell to sift through") instead of one long string, specifically so a UI
 * consumer (TracePanel.tsx) can show the summary immediately and put the much
 * longer pull-by-pull log behind its own collapsible disclosure, rather than
 * making a reader scroll through hundreds of lines just to see whether a goal
 * finished. Both pieces are shared between the live trace panel and this
 * file's own test-suite console output — a fix here improves both surfaces.
 */
export function formatTrace(run: TraceRun, goals: Goal[]): FormattedTrace {
  const summaryLines: string[] = [];
  const doneCount = goals.filter((g) => run.goalDoneAtPull.has(g.id)).length;
  summaryLines.push(`Result: ${doneCount}/${goals.length} goals done within budget.`);
  for (const goal of goals) {
    const donePull = run.goalDoneAtPull.get(goal.id);
    summaryLines.push(`  ${goal.name}: ${donePull !== undefined ? `done at pull ${donePull}` : 'not done within budget'}`);
  }

  // Group consecutive steps sharing one "focus key" (banner + which goal
  // we're actually working toward together) into sections, so each section's
  // header can show its real pull range — computed via this first pass,
  // rather than printed incrementally, since the range's END isn't known
  // until the section is over. Banner alone isn't enough to key a section:
  // the real focus can shift WITHIN one continuous same-banner run too (e.g.
  // once a 5-star is won, or once a blocking 4-star catches up), with no
  // banner-switch to hang a new header off of — missing that transition
  // entirely was a real gap found 2026-08-18 while checking whether this
  // narration would make sense to an actual player.
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
 * Renders a goal list as a plain priority-order roster — {rarity}★ {banner}
 * {name}, plus target level/anchors for 4-stars and explicit window-linking
 * status for 5star_weapon goals — so a reader can see at a glance what a goal
 * list actually is without reverse-engineering it from formatTrace's pull-by-
 * pull narration. Originally lived only in trace.survey.test.ts; moved here
 * (2026-08-19, at the user's request) so the same formatting is available to a
 * live "generate a trace" UI feature, not just the test suite — every
 * 5star_weapon goal explicitly states its window-linking status (not just when
 * linked) because it applies to every weapon goal, and the whole point is being
 * able to verify the pulling sequence for ANY goal list at a glance, not just
 * ones a scenario author already knows are linked.
 */
export function formatGoalRoster(goals: Goal[]): string {
  const nameById = new Map(goals.map((g) => [g.id, g.name]));
  const lines = goals.map((g, i) => {
    const rarity = g.kind.startsWith('5star') ? '5' : '4';
    let line = `  ${i + 1}. ${rarity}★ ${g.banner} ${g.name}`;
    if (g.kind === '4star_character' || g.kind === '4star_weapon') {
      const levelLabel = g.kind === '4star_character' ? `C${g.targetLevel ?? 0}` : `R${g.targetLevel ?? 1}`;
      line += ` (target ${levelLabel}`;
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
