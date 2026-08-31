import type { BannerKind, CharacterBannerConfig, Goal, WeaponBannerConfig } from './types';

/** A maximal run of consecutive same-banner goals in priority order. */
export interface Phase {
  banner: BannerKind;
  goals: Goal[];
  /** Index of this phase's first goal within the original global goal list. */
  globalStartIndex: number;
}

/**
 * For a 4-star goal, its "flanking linked pair" — the nearest same-kind
 * 5-star goal on each side of its raw priority-list position (walking past
 * everything else, matching how character/weapon-link adjacency already
 * works elsewhere), when BOTH exist and are mutually linked to EACH OTHER
 * (simultaneous). When this pair exists, the 4-star's own disconnection (or
 * anchoring to just one side) is structurally impossible: if the two
 * flanking 5-stars run at the same real-world time, there's no time gap
 * between them for an unrelated phase — or a partial anchor covering only
 * one of them — to occupy. She must be on their shared window. Returns the
 * pair's ids `[before, after]`, or `undefined` if no such pair exists (found
 * by the user hitting this live: `[Odette, Alyosha, Miko]`, linking
 * Odette+Miko as simultaneous left Alyosha's stale single-sided anchor
 * silently invalid with no UI signal forcing the fix).
 */
export function findFlankingLinkedPair(goals: Goal[], fourStarGoalId: string): [string, string] | undefined {
  const idx = goals.findIndex((g) => g.id === fourStarGoalId);
  if (idx === -1) return undefined;
  const fourStar = goals[idx];
  if (fourStar.kind !== '4star_character' && fourStar.kind !== '4star_weapon') return undefined;
  const fiveStarKind = fourStar.kind === '4star_character' ? '5star_character' : '5star_weapon';
  const linkField = fiveStarKind === '5star_character' ? 'linkedCharacterGoalId' : 'linkedWeaponGoalId';

  let before: Goal | undefined;
  for (let i = idx - 1; i >= 0; i--) {
    if (goals[i].kind === fiveStarKind) {
      before = goals[i];
      break;
    }
  }
  let after: Goal | undefined;
  for (let i = idx + 1; i < goals.length; i++) {
    if (goals[i].kind === fiveStarKind) {
      after = goals[i];
      break;
    }
  }
  if (!before || !after) return undefined;
  if (before[linkField] !== after.id || after[linkField] !== before.id) return undefined;
  return [before.id, after.id];
}

/**
 * Which 4-star goals are "disconnected" — no coherent anchor to any listed
 * same-kind 5-star window: either `anchoredFiveStarGoalIds` is an EXPLICIT
 * empty array (the user actively unchecked every candidate), or it's
 * `undefined` (never touched) while 2+ DISTINCT same-kind 5-star "windows"
 * exist elsewhere in the list (real ambiguity — nothing to default-attach to).
 *
 * Deliberately operates on the RAW `Goal[]` list, not an already-built
 * `Phase[]` array — `buildPhases` itself needs this result to decide where to
 * force phase boundaries (twentieth-reported-bug follow-up, 2026-08-21: a
 * disconnected 4-star now gets its OWN isolated phase, at its own priority
 * position, rather than being deferred to a synthesized phase after every
 * real phase — see buildPhases's own doc comment), so this can't be derived
 * FROM `phases` without circularity. "Distinct window" is re-derived directly
 * from `linkedCharacterGoalId`/`linkedWeaponGoalId` — a linked (simultaneous)
 * pair of same-kind 5-stars is one window, everything else is its own — the
 * SAME signal `buildPhases` itself uses to decide phase boundaries, so this
 * stays consistent with whatever `buildPhases` will actually produce.
 *
 * Must count windows containing an ACTUAL 5-star-weapon goal, not "any
 * weapon-banner phase" (the old, now-removed `hasFourStarAnchorAmbiguity`'s
 * weapon branch counted raw `Phase` membership, which — once disconnected
 * 4-stars start creating their own single-goal weapon-banner phases — would
 * inflate the count and wrongly flag an unrelated, genuinely-unambiguous
 * weapon 4-star elsewhere in the same list as disconnected too. Operating on
 * raw goals instead of `Phase` objects avoids this trap by construction.
 */
export function computeDisconnectedFourStarGoalIds(goals: Goal[]): Set<string> {
  function countWindows(fiveStarKind: '5star_character' | '5star_weapon'): number {
    const sameKind = goals.filter((g) => g.kind === fiveStarKind);
    const seen = new Set<string>();
    let windows = 0;
    for (const g of sameKind) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const linkId = fiveStarKind === '5star_character' ? g.linkedCharacterGoalId : g.linkedWeaponGoalId;
      if (linkId) seen.add(linkId);
      windows++;
    }
    return windows;
  }
  const windowsByKind = { '5star_character': countWindows('5star_character'), '5star_weapon': countWindows('5star_weapon') } as const;

  const disconnected = new Set<string>();
  for (const goal of goals) {
    if (goal.kind !== '4star_character' && goal.kind !== '4star_weapon') continue;
    const anchors = goal.anchoredFiveStarGoalIds;
    if (anchors && anchors.length > 0) continue; // has real anchors — not disconnected
    if (anchors !== undefined) {
      disconnected.add(goal.id); // explicit empty — always disconnected
      continue;
    }
    const fiveStarKind = goal.kind === '4star_character' ? '5star_character' : '5star_weapon';
    if (windowsByKind[fiveStarKind] >= 2) disconnected.add(goal.id); // ambiguous — nothing to default-attach to
  }
  return disconnected;
}

/**
 * Groups a priority-ordered goal list into phases. Banner focus only ever switches
 * when the highest-priority *incomplete* goal moves to a different banner — and
 * since that only depends on the fixed priority order (not on which order goals
 * within a run happen to complete in), a maximal run of consecutive same-banner
 * goals always shares one contiguous focus period. See simulate.ts's
 * "priority-driven banner focus" policy, which this generalizes for the exact engine.
 *
 * TWO EXCEPTIONS to the plain "same banner = same phase" rule, both making
 * adjacency insufficient on its own — a phase boundary can now also be forced
 * WITHIN a run of same-banner goals, or (see linkedCharacterGoalId) NOT forced
 * despite non-adjacency being impossible for that case:
 *
 * - Fifteenth reported bug (2026-08-19): two ADJACENT 5star_weapon goals do NOT
 *   automatically merge into one phase anymore — they only do when explicitly
 *   linked (Goal.linkedWeaponGoalId, mutual). Adjacency used to be the ONLY
 *   signal for "same real weapon-banner window," which was wrong whenever a
 *   user genuinely means "these are on two different real phases, pull each
 *   banner to completion in sequence" (e.g. already own both characters).
 *   Forcing a phase split here reuses the SAME phase-boundary machinery (fresh
 *   config, fresh closed-set, and critically a Fate Points reset — see
 *   exactEngine.ts's resetWeaponFatePoints) that already models a genuine new
 *   Epitomized Path selection, rather than needing new engine machinery.
 * - Sixteenth reported bug (2026-08-19): two ADJACENT 5star_character goals do
 *   NOT automatically merge into one phase anymore either — they only do when
 *   explicitly linked (Goal.linkedCharacterGoalId, mutual), meaning "these are
 *   two genuinely SIMULTANEOUS character banners" (see the doc comment on
 *   linkedCharacterGoalId for why this is NOT the weapon case's "same banner").
 *   Before this fix, EVERY adjacent run of 5star_character goals was forced
 *   into one shared phase — so chasing 3+ sequential (non-simultaneous)
 *   5-stars with no weapon detour between them was impossible to express, and
 *   a 4-star anchored to only one of two ACTUALLY-sequential 5-stars was
 *   incorrectly rejected as "must be anchored to all of them."
 *   `buildPhases` only merges a linked pair when they're LITERALLY adjacent
 *   (`sameBanner` requires `last.banner === goal.banner`, which is false the
 *   instant a weapon-banner goal sits between them) — it never searches across
 *   a non-adjacent gap the way the weapon fix's computeWeaponWindowGoalsForPhase
 *   does. That's fine: unlike weapon Epitomized Path (a per-phase selection
 *   that must reset), character pity/guaranteed5/crCounter carries over
 *   unconditionally between ANY two same-banner phases regardless of whether
 *   they got merged into one Phase object, so nothing computational actually
 *   needs the merge to happen. Consequently, `goalValidation.ts`'s
 *   `linkedCharacterGoalId` check does NOT require the pair to share a literal
 *   Phase (updated 2026-08-19, same day) — a weapon-banner goal prioritized
 *   between two linked character goals is a real, valid configuration (a
 *   phase's one shared weapon banner runs fully concurrently with both of its
 *   character banners), it just means they end up as separate Phase objects
 *   that happen to carry state between them like any other same-banner
 *   reoccurrence. Only another 5star_character goal between them is rejected
 *   — a 4star_character goal in between is fine (that's exactly what
 *   same-phase anchoring models), just like a weapon-banner goal.
 * - Twentieth-reported-bug follow-up (2026-08-21): a DISCONNECTED 4-star (see
 *   computeDisconnectedFourStarGoalIds) always becomes the SOLE member of its
 *   own isolated phase, forced apart from its neighbors — representing "this
 *   4-star's real rerun is some separate, unlisted phase, positioned exactly
 *   where it sits in priority order." This replaces the earlier
 *   (nineteenth-bug) design, where a disconnected goal could only ever
 *   resolve in a synthesized phase appended after every REAL listed phase on
 *   its banner — wrong whenever the disconnected goal's own priority
 *   position was BEFORE a later real goal (e.g.
 *   `[Odette, Alyosha(disconnected), Miko]`: Alyosha's own completion odds
 *   used to collapse onto "Miko also done," since her resolution literally
 *   couldn't start until Miko's own phase had already finished too — found by
 *   the user reading the odds chart directly). Two ADJACENT disconnected
 *   4-stars do NOT merge into one shared window — each gets its own separate,
 *   sequential phase (the user's explicit choice; a future explicit-linking
 *   mechanism to merge them, mirroring linkedCharacterGoalId/
 *   linkedWeaponGoalId, is out of scope here).
 *
 *   Implemented as a SEPARATE post-processing split over the baseline phases
 *   above (banner adjacency + 5-star linking), not woven into the same
 *   single linear pass — an earlier draft tried the latter (forcing a new
 *   phase whenever the PREVIOUS phase was an isolated disconnected goal) and
 *   introduced a real bug: a NON-disconnected goal pushed into its own new
 *   phase merely because it followed an isolated one (e.g. Alyosha, anchored
 *   to Odette, textually following a disconnected Sara) would then silently
 *   merge with a LATER, unrelated 5-star (Miko) that the ordinary 5-star
 *   linking rule was never asked to keep separate from THIS specific phase —
 *   entangling two goals that were never meant to share a window at all.
 *   Splitting an already-fully-formed baseline phase around its own
 *   disconnected members instead can never create a NEW adjacency with a
 *   goal outside that baseline phase, since the baseline algorithm already
 *   decided that boundary independently.
 */
export function buildPhases(goals: Goal[]): Phase[] {
  const disconnectedIds = computeDisconnectedFourStarGoalIds(goals);
  const globalIndexById = new Map(goals.map((goal, i) => [goal.id, i]));
  const baselinePhases: Phase[] = [];
  for (let i = 0; i < goals.length; i++) {
    const goal = goals[i];
    const last = baselinePhases[baselinePhases.length - 1];
    const sameBanner = !!last && last.banner === goal.banner;
    const forceNewWindow =
      sameBanner &&
      ((goal.kind === '5star_weapon' && last!.goals.some((g) => g.kind === '5star_weapon' && g.id !== goal.linkedWeaponGoalId)) ||
        (goal.kind === '5star_character' && last!.goals.some((g) => g.kind === '5star_character' && g.id !== goal.linkedCharacterGoalId)));
    if (sameBanner && !forceNewWindow) {
      last!.goals.push(goal);
    } else {
      baselinePhases.push({ banner: goal.banner, goals: [goal], globalStartIndex: i });
    }
  }

  const phases: Phase[] = [];
  for (const baseline of baselinePhases) {
    let run: Goal[] = [];
    const flushRun = () => {
      if (run.length === 0) return;
      phases.push({ banner: baseline.banner, goals: run, globalStartIndex: globalIndexById.get(run[0].id)! });
      run = [];
    };
    for (const goal of baseline.goals) {
      if (disconnectedIds.has(goal.id)) {
        flushRun();
        phases.push({ banner: baseline.banner, goals: [goal], globalStartIndex: globalIndexById.get(goal.id)! });
      } else {
        run.push(goal);
      }
    }
    flushRun();
  }
  return phases;
}

/** Maps every goal id in the list to the index of the phase it belongs to. */
export function buildPhaseIndexByGoalId(phases: Phase[]): Map<string, number> {
  const phaseIndexByGoalId = new Map<string, number>();
  phases.forEach((phase, i) => {
    for (const goal of phase.goals) phaseIndexByGoalId.set(goal.id, i);
  });
  return phaseIndexByGoalId;
}

/**
 * Resolves which ONE phase a 4-star goal BLOCKS — i.e. must be done before that
 * phase (and therefore banner focus) can graduate/advance. This used to be
 * implicit: `buildPhases` glues every goal, 4-star included, into whichever
 * banner-run it's textually adjacent to, and THAT raw membership was what
 * `runPhaseDp`/`isPhaseFullyDone` (exact engine) and `stepOnePull`'s
 * `targetIdx` (Monte Carlo) used for blocking — completely independent of the
 * goal's own `anchoredFiveStarGoalIds`. Confirmed via direct tracing to be a
 * real bug (2026-08-19): `[Odette, Alyosha(anchored to Miko only, UNLINKED
 * from Odette — genuinely separate, sequential phases), Miko]` — Alyosha's
 * raw-adjacency phase is Odette's (she's textually glued there), so
 * `isPhaseFullyDone`/the FIFO 5★-character claim's phase-gate stayed pinned to
 * Odette's phase, meaning MIKO COULD NEVER BE WON AT ALL until Alyosha
 * (anchored only to a LATER phase) finished — even though Miko's own pulls
 * were happening the whole time. This was also the root cause of the "4-star
 * listed before its only anchor" rejection (removed from goalValidation.ts,
 * see there) and of issue 1.5.5 (no way to say "this 4-star isn't on any
 * currently-listed phase at all").
 *
 * The fix: `MAX(the goal's own raw-adjacency phase, its LATEST anchor's
 * phase)` — never the min, never the anchor alone. Worked through every
 * existing scenario shape by hand:
 * - Anchored to a phase LATER than its own raw position (the broken case
 *   above): MAX picks the anchor's phase — she now blocks Miko's phase
 *   instead of Odette's, fixing the bug directly.
 * - Anchored to a phase EARLIER than its own raw position — the "ninth
 *   reported bug" shape, `[Odette, WeaponDetour, Alyosha(anchored to Odette
 *   only)]`: her own raw phase (the last one, existing ONLY to chase her) is
 *   AFTER her only anchor. Dropping "own raw phase" from the MAX here would
 *   make that trailing phase have ZERO blocking members — vacuously "done" at
 *   pull 0, never actually waiting for her. MAX keeps her blocking (and, via
 *   the pre-existing natal-phase-never-closes exception below, trackable) in
 *   her own trailing phase.
 * - Anchored to BOTH an earlier and a later phase (multi-phase spanning, e.g.
 *   `D2`'s `[Odette, WeaponDetour, Alyosha(anchored=[Odette,Miko]), Miko]`):
 *   MAX of her own raw phase (Miko's, since she's textually glued there) and
 *   her latest anchor (also Miko's) is still Miko's — unaffected, matches
 *   today's already-correct, already-tested behavior.
 * - No anchors at all: `buildPhases` has already given a DISCONNECTED goal
 *   (see computeDisconnectedFourStarGoalIds) her own isolated phase — so
 *   `ownPhase` IS her real, correct blocking phase, same as any other
 *   no-anchor case. An UNAMBIGUOUS goal (only one candidate 5-star window
 *   anywhere) stayed a normal member of that one phase, so `ownPhase` is
 *   correct there too. Both collapse to the same `return ownPhase`.
 *
 * **Twentieth-reported-bug follow-up (2026-08-21): this function used to also
 * take a `disconnectedFallbackPhaseIndex` for redirecting a disconnected
 * goal's blocking phase to a synthesized trailing "Phase R" — removed
 * entirely.** `buildPhases` now gives a disconnected goal her own real,
 * isolated phase directly (at her own priority position, not deferred to the
 * very end), so there's no more separate "fallback" phase to redirect to —
 * `ownPhase` (from `phaseIndexByGoalId`, itself just a byproduct of
 * `buildPhases`'s own grouping) is always the right, final answer.
 *
 * **Twenty-first reported bug (2026-08-30): "always the LATEST anchor"
 * silently assumed a 4-star's own natal phase is never itself a real anchor
 * window worth waiting for — wrong whenever it is one.** Shape:
 * `[Odette, Alyosha(anchored=[Odette,Miko]), WeaponDetour, Miko]`, Odette↔Miko
 * LINKED (simultaneous) but not adjacent (the weapon sits between them), so
 * `buildPhases` can't merge them into one Phase object the way it does for a
 * literally-adjacent linked pair. Alyosha's own natal phase is Odette's
 * (textually glued there); her anchors resolve to phases 0 (Odette) and 2
 * (Miko); the OLD rule picked MAX = 2 unconditionally, meaning Odette's own
 * phase graduated the instant Odette dropped — even though Alyosha (a HIGHER
 * priority than the weapon goal sitting right after her) hadn't been
 * touched yet, and her own window was WIDE OPEN there the whole time. A real
 * player prioritizing Alyosha over the weapon would keep pulling the
 * character banner (still earning Odette+Miko's shared pity/CR/roster) until
 * she's done, not abandon a currently-available higher-priority target for a
 * lower one — see FOCUS_RULES.md's own "no exceptions" framing of priority
 * order, which the MAX-only rule was quietly violating for exactly this shape.
 *
 * Fix: when a 4-star's own natal phase is ITSELF one of her named anchors
 * (not just contained in the [min,max] range some OTHER unrelated way — see
 * computeClosedFourStarGoalIdsForPhase's own range check for the different,
 * ACCRUAL-window question), block there instead of jumping to the latest
 * anchor. This differs from the old MAX-based answer in exactly one shape:
 * a 4-star anchored to MULTIPLE 5-stars where her own natal phase happens to
 * be the EARLIEST of them (not the latest, and not absent from her own
 * anchors) — every previously-fixed bug shape (ninth, twentieth, D1-D3) has
 * either a single anchor, or a natal phase that already coincides with the
 * latest anchor (D2), or a natal phase that isn't an anchor at all (the
 * twentieth bug) — all of those keep their existing, already-tested answer
 * unchanged (confirmed goal-by-goal against every named scenario in
 * exactEngine.test.ts / trace.survey.test.ts). A same-phase, LITERALLY
 * adjacent linked pair (e.g. `[Odette, Alyosha, Miko]` with no detour) is
 * also unaffected, since `buildPhases` already merges them into ONE Phase
 * object there — natal and every anchor phase are trivially identical.
 *
 * Blocking her own natal phase alone isn't sufficient by itself, though: once
 * that phase is (correctly) held open past Odette's own claim, an EXTRA
 * featured win landing during that wait (Odette's slot already full) must be
 * able to roll over onto Miko's still-open slot instead of vanishing as
 * "no effect" — see exactEngine.ts's `characterWindowPartnerByPhase`/
 * `carryPhaseLocalState` wiring (built on `computeCharacterWindowGoalsForPhase`
 * below) and simulate.ts's mirrored `isInSharedCharacterWindow` check, both of
 * which this fix depends on to be complete.
 */
function resolveFourStarBlockingPhase(goal: Goal, phaseIndexByGoalId: Map<string, number>): number | undefined {
  const anchors = goal.anchoredFiveStarGoalIds;
  const ownPhase = phaseIndexByGoalId.get(goal.id);
  if (!anchors || anchors.length === 0) return ownPhase;
  const anchorPhases = anchors.map((a) => phaseIndexByGoalId.get(a)).filter((x): x is number => x !== undefined);
  if (anchorPhases.length === 0) return ownPhase; // dangling anchor(s) — goalValidation.ts should have flagged this
  if (ownPhase === undefined) return Math.max(...anchorPhases);
  if (anchorPhases.includes(ownPhase)) return ownPhase;
  return Math.max(ownPhase, ...anchorPhases);
}

/**
 * Resolves EVERY persistent 4-star goal's blocking phase ONCE — see
 * resolveFourStarBlockingPhase — instead of the redundant, per-phase (or
 * per-goal) recomputation `computeBlockingFourStarGoalIdsForPhase`/
 * `computeFourStarBlockingPhase` used to each do independently (rebuilding
 * `buildPhaseIndexByGoalId` and re-deriving the same result once per caller,
 * even though a goal's own blocking phase never depends on which phase `p`
 * is being checked against). Callers needing "which phase does p block" or
 * "what's this one goal's own blocking phase" now just read this map once.
 */
export function computeFourStarBlockingPhaseByGoalId(phases: Phase[], fourStarGoals: Goal[]): Map<string, number | undefined> {
  const phaseIndexByGoalId = buildPhaseIndexByGoalId(phases);
  const result = new Map<string, number | undefined>();
  for (const goal of fourStarGoals) {
    if (goal.kind !== '4star_character' && goal.kind !== '4star_weapon') continue;
    result.set(goal.id, resolveFourStarBlockingPhase(goal, phaseIndexByGoalId));
  }
  return result;
}

/**
 * For one specific phase `p`, the 4-star goals whose BLOCKING phase — read
 * from `blockingPhaseByGoalId` (computeFourStarBlockingPhaseByGoalId's
 * output) — resolves to exactly `p`. This is what `exactEngine.ts`'s phase
 * loop and `simulate.ts`'s per-pull phase scan feed into their respective "is
 * this phase fully done" checks (`runPhaseDp`'s `phaseGoals`,
 * `blockingGoalIdsByPhase`) INSTEAD OF raw `Phase.goals` membership, which
 * never consulted anchors at all.
 */
export function computeBlockingFourStarGoalIdsForPhase(p: number, fourStarGoals: Goal[], blockingPhaseByGoalId: Map<string, number | undefined>): Set<string> {
  const blocking = new Set<string>();
  for (const goal of fourStarGoals) {
    if (blockingPhaseByGoalId.get(goal.id) === p) blocking.add(goal.id);
  }
  return blocking;
}

/**
 * For one specific phase (identified by its index `p` within `phases`), computes
 * which 4star_character/4star_weapon goals — from the given persistent goal list,
 * which spans every phase of this banner, not just this one — have their
 * copy-count window closed FOR THIS PHASE: `p` falls OUTSIDE the inclusive range
 * [earliest anchor's phase, latest anchor's phase]. That range has two distinct
 * edges, both real:
 *
 * - `p` AFTER every anchor's phase (the original, first-found case): every anchor
 *   is guaranteed already won by then, since a phase can't graduate without its own
 *   goals — including any anchor it contains — being satisfied. See
 *   goalTracking.ts's updateGoalTracking doc comment for why an anchor sharing THIS
 *   SAME phase never closes the window on its own.
 * - `p` BEFORE every anchor's phase (found during a later audit): none of the
 *   anchors have happened yet, so this banner's real-world rate-up roster for
 *   phase `p` structurally cannot include this item at all — it isn't just
 *   "not yet claimed," it isn't in the pool. This is now a perfectly ordinary,
 *   ALLOWED configuration (e.g. an item textually glued to an EARLIER phase than
 *   its only anchor, per resolveFourStarBlockingPhase above) — it correctly means
 *   the item just isn't featured on that earlier phase's own rate-up at all,
 *   without blocking that phase's graduation (blocking is resolved separately,
 *   see computeBlockingFourStarGoalIdsForPhase).
 * - An UNANCHORED goal has TWO genuinely different sub-cases, kept distinct
 *   (twentieth-reported-bug follow-up, 2026-08-21 — collapsing them into one
 *   rule was tried and found wrong): a DISCONNECTED goal (see
 *   computeDisconnectedFourStarGoalIds) now has her own isolated phase
 *   (buildPhases), so she's open ONLY there — closed everywhere else, same
 *   shape as the anchored case with `minAnchorPhase === maxAnchorPhase ===`
 *   her own phase. An UNAMBIGUOUS goal (only one candidate 5-star window
 *   anywhere, so nothing to disconnect FROM) keeps today's original
 *   convenience fallback — open everywhere, unchanged, since she stayed an
 *   ordinary member of that one real phase and can opportunistically accrue
 *   across every reoccurrence of the banner, same as any other unnamed-anchor
 *   4-star always has.
 *
 * Recomputed per phase (not once globally) because the same persistent item can be
 * open in one phase and closed in another as focus moves through the goal list.
 *
 * ONE EXCEPTION to the "after every anchor" edge, found by the user testing goal
 * lists in the dev server after this range check first shipped (ninth reported
 * bug): an item's OWN NATAL PHASE — the phase it's actually a member of, i.e.
 * (as of the phase-derived-blocking fix above) a BLOCKING member of via the MAX
 * rule whenever its own phase is the later one — must never be closed by this
 * edge, even when it falls after every anchor. Concretely: [Odette(char),
 * Homa(weapon), Alyosha(char, anchored=[Odette])] — Alyosha's own phase is the
 * LAST one (after the weapon detour), strictly after her only anchor (Odette's,
 * the first phase). Closing her window there means that phase — which contains
 * ONLY her — can never graduate past whatever she happened to accrue
 * opportunistically during Odette's own earlier phase, hard-ceiling the entire
 * "Odette + Homa + Alyosha" chain (and her own breakdown) the instant Homa
 * finishes, even though that last phase's entire reason to exist is pulling
 * toward her.
 */
export function computeClosedFourStarGoalIdsForPhase(phases: Phase[], p: number, persistentFourStarGoals: Goal[]): Set<string> {
  const phaseIndexByGoalId = buildPhaseIndexByGoalId(phases);
  // Recomputed from the flattened raw goal list (every goal belongs to
  // exactly one phase, so this losslessly reconstructs it) rather than
  // threaded through as a parameter — keeps this function's external
  // signature stable across every call site.
  const disconnectedIds = computeDisconnectedFourStarGoalIds(phases.flatMap((ph) => ph.goals));

  const closed = new Set<string>();
  for (const goal of persistentFourStarGoals) {
    if (goal.kind !== '4star_character' && goal.kind !== '4star_weapon') continue;
    const anchors = goal.anchoredFiveStarGoalIds;
    if (!anchors || anchors.length === 0) {
      // Disconnected (own isolated phase) -> open only there. Unambiguous
      // attach -> today's original fallback, open everywhere (unchanged).
      if (disconnectedIds.has(goal.id)) {
        if (phaseIndexByGoalId.get(goal.id) !== p) closed.add(goal.id);
      }
      continue;
    }
    const anchorPhases = anchors.map((a) => phaseIndexByGoalId.get(a)).filter((x): x is number => x !== undefined);
    if (anchorPhases.length === 0) continue; // no valid anchors resolved — leave open, goalValidation.ts should have already flagged this
    const minAnchorPhase = Math.min(...anchorPhases);
    const maxAnchorPhase = Math.max(...anchorPhases);
    if (p < minAnchorPhase) {
      closed.add(goal.id);
      continue;
    }
    if (p > maxAnchorPhase && phaseIndexByGoalId.get(goal.id) !== p) closed.add(goal.id);
  }
  return closed;
}

/**
 * Twenty-first reported bug (2026-08-30). For character-banner phase `p`, the
 * OTHER phase index it shares a real, simultaneous 5star_character FIFO
 * window with — i.e. phase `p` has exactly one own `5star_character` goal,
 * and it's explicitly linked (`Goal.linkedCharacterGoalId`, mutual) to a goal
 * living in a DIFFERENT phase (found by searching the whole `phases` array,
 * same pattern as `computeWeaponWindowGoalsForPhase` below). Returns
 * `undefined` for the overwhelming majority of phases: 0 or 2+ own
 * `5star_character` goals (2+ only happens when `buildPhases` already merged
 * a literally-adjacent linked pair into one Phase object, leaving nothing to
 * bridge), or a lone `5star_character` goal that isn't linked to anything
 * outside this phase.
 *
 * This solves a genuinely different problem than weapon-window linking: a
 * weapon pull's identity is directly observable (which physical weapon you
 * got), so `updateGoalTracking` never needs a FIFO to know which named goal a
 * weapon win satisfies — see `computeClosedFiveStarWeaponTargetIdsForPhase`'s
 * own doc comment. A featured CHARACTER win, by contrast, is identity-
 * AGNOSTIC (the banner config tracks only one currently-featured id), so
 * which of two linked 5-stars a win claims is resolved entirely by a
 * phase-local FIFO rank — and that FIFO normally resets every phase (see
 * goalTracking.ts's `PhaseLocalSpec` doc comment) because a later phase's
 * 5star_character goal is normally a genuinely separate, later win. A linked
 * pair is the one exception: the two goals ARE the same real-time window,
 * just split apart in priority order by an interleaved different-banner
 * detour (or another unlinked 5-star) — so a featured win landing during the
 * FIRST phase's own extra pulls (now correctly held open past its own claim
 * whenever a same-window 4-star is still short of target — see
 * `resolveFourStarBlockingPhase`'s own twenty-first-bug fix above) must be
 * able to roll over onto the SECOND phase's still-open slot instead of being
 * silently dropped as "no effect."
 */
export function computeCharacterWindowPartnerPhase(phases: Phase[], p: number): number | undefined {
  const own = phases[p].goals.filter((g) => g.kind === '5star_character');
  if (own.length !== 1) return undefined;
  const link = own[0].linkedCharacterGoalId;
  if (!link) return undefined;
  for (let q = 0; q < phases.length; q++) {
    if (q === p) continue;
    if (phases[q].goals.some((g) => g.id === link)) return q;
  }
  return undefined;
}

/**
 * The full, priority-ordered set of goals sharing phase `p`'s real
 * 5star_character window — phase `p`'s own goals plus its cross-phase
 * partner's, if `computeCharacterWindowPartnerPhase` finds one; otherwise
 * just `phases[p].goals` unchanged (the identity-preserving fast path
 * `exactEngine.ts` relies on to skip its own extra bookkeeping for the
 * common, non-window case).
 *
 * Sorted by each goal's position in the ORIGINAL goal list (via
 * `phases.flatMap`, which reconstructs it losslessly — the same technique
 * `computeClosedFourStarGoalIdsForPhase` above uses), not by which phase
 * happens to contain it: FIFO rank order is priority order, and phase `p`'s
 * own native goals are not always the earlier half of the pair (whichever of
 * the two phases is being asked, this function must return the SAME combined
 * list, in the SAME order, so both phases build an identical, compatible
 * `PhaseLocalSpec` shape — see exactEngine.ts's own doc comment on
 * `effectivePhaseGoals` for why that compatibility is what makes carrying
 * the FIFO code across the detour meaningful at all).
 */
export function computeCharacterWindowGoalsForPhase(phases: Phase[], p: number): Goal[] {
  const partner = computeCharacterWindowPartnerPhase(phases, p);
  if (partner === undefined) return phases[p].goals;
  const ids = new Set([...phases[p].goals, ...phases[partner].goals].map((g) => g.id));
  return phases.flatMap((ph) => ph.goals).filter((g) => ids.has(g.id));
}

/**
 * The 5star_weapon goal(s) that make up phase `p`'s real Epitomized Path window —
 * normally just phase `p`'s own 5star_weapon goal(s) (0-2, when explicitly linked
 * to each other and therefore already merged into one Phase by buildPhases), but
 * when phase `p` has exactly ONE own 5star_weapon goal that's explicitly linked
 * (Goal.linkedWeaponGoalId) to a goal living in a DIFFERENT phase, that partner is
 * included too — the two phases share one real window, split apart in priority
 * order by an intervening character-banner detour (or, symmetrically, by another
 * weapon-banner window — rejected by goalValidation.ts, see linkedWeaponGoalId's
 * doc comment). `own[0]` is always first in the result when present, preserving
 * the existing "first listed in THIS phase = chosen" precedence.
 *
 * Searches the WHOLE `phases` array (not just phase `p`) for the partner, since a
 * linked goal's own natal phase can be anywhere else in the list.
 */
function computeWeaponWindowGoalsForPhase(phases: Phase[], p: number): Goal[] {
  const own = phases[p].goals.filter((g) => g.kind === '5star_weapon');
  const result = [...own];
  for (const g of own) {
    if (g.linkedWeaponGoalId) {
      const partner = phases.flatMap((ph) => ph.goals).find((x) => x.id === g.linkedWeaponGoalId);
      if (partner && !result.some((r) => r.id === partner.id)) result.push(partner);
    }
  }
  return result;
}

/**
 * Whether a weapon-banner phase's own Fate Points must be reset to 0 on entry —
 * true exactly when this phase is a REOCCURRENCE of the weapon banner (some
 * earlier phase already used it) AND this phase's own weapon goal ISN'T
 * explicitly linked to the goal it's carrying state over from (i.e. it's a
 * genuinely NEW Epitomized Path selection, not the SAME real window continuing
 * across an interleaved character-banner detour — see linkedWeaponGoalId's own
 * doc comment and the thirteenth/fifteenth reported bugs). `guaranteed5` (the
 * standalone 75/25 pity) is UNAFFECTED either way — it always carries over,
 * same as pity5/guaranteed4 always have; only Fate Points are ever reset here.
 *
 * Both engines need this exact same condition at their own phase-boundary
 * handoff (exactEngine.ts's `resetWeaponFatePoints` call site, simulate.ts's
 * `resetFatePointsOnEntry`) — previously reimplemented independently in each,
 * which is exactly the failure mode (one copy fixed, the other not) behind
 * several of this file's own documented bug histories.
 *
 * A phase with ZERO `5star_weapon` goals is also exempt (twentieth-reported-bug
 * follow-up, 2026-08-21) — a disconnected `4star_weapon` goal's own isolated
 * phase (see buildPhases) has no weapon goal at all to select via Epitomized
 * Path, so there's no new selection happening here either; resetting would
 * wrongly wipe real Fate Point progress carried from an earlier phase for no
 * reason. Before this fix, `ownWeaponGoal` was `undefined` in this shape, and
 * `!undefined?.linkedWeaponGoalId` evaluates to `true` — a real, latent bug
 * this redesign makes newly, commonly reachable.
 */
export function isWeaponFatePointsResetOnEntry(phases: Phase[], p: number): boolean {
  const phase = phases[p];
  if (phase.banner !== 'weapon') return false;
  if (!phases.slice(0, p).some((earlier) => earlier.banner === 'weapon')) return false; // first use — nothing to reset
  const ownWeaponGoal = phase.goals.find((g) => g.kind === '5star_weapon');
  if (!ownWeaponGoal) return false; // no weapon goal here at all — nothing to (re)select
  return !ownWeaponGoal.linkedWeaponGoalId;
}

/**
 * For one specific phase, computes which 5star_weapon goals' target ids are
 * closed FOR THIS PHASE: any target whose own goal isn't part of phase `p`'s real
 * Epitomized Path window (see computeWeaponWindowGoalsForPhase — normally just
 * "isn't a member of phase p", UNLESS its goal is explicitly linked to one that
 * is). Unlike 4-star tracking, 5-star-weapon identity (chosen vs. other-featured)
 * needs no anchor field to know its window in the common case — a `5star_weapon`
 * goal is unambiguously tied to whichever single phase it's positioned in (each
 * phase has exactly one weapon banner) — UNLESS explicitly linked elsewhere (see
 * the fifteenth reported bug, 2026-08-19, and linkedWeaponGoalId's doc comment).
 *
 * Without this, a later phase's featured weapon (built into the one static
 * WeaponBannerConfig used across every weapon-banner phase — see
 * buildSimulationInput.ts) was reachable as a real pull outcome during an EARLIER,
 * unrelated weapon-banner phase, and — since 5-star-weapon tracking has no
 * per-pull gating at all otherwise — got silently marked "done" there.
 */
export function computeClosedFiveStarWeaponTargetIdsForPhase(phases: Phase[], p: number, allFiveStarWeaponGoals: Goal[]): Set<string> {
  const windowGoalIds = new Set(computeWeaponWindowGoalsForPhase(phases, p).map((g) => g.id));
  const closed = new Set<string>();
  for (const goal of allFiveStarWeaponGoals) {
    if (goal.kind !== '5star_weapon') continue;
    if (!windowGoalIds.has(goal.id)) closed.add(goal.targetId);
  }
  return closed;
}

/**
 * Pads real ids up to minCount with anonymous placeholder ids representing "some
 * other item you don't care about." Moved here (from state/buildSimulationInput.ts)
 * because pool construction is now phase-scoped and engine-internal — see
 * computeCharacterBannerConfigForPhase/computeWeaponBannerConfigForPhase below.
 * Placeholder ids don't need phase-namespacing: each phase's runPhaseDp call is
 * fully self-contained (its own adapter, its own config), so a placeholder never
 * leaks across phases or collides with a real goal's targetId.
 */
export function padIds(realIds: string[], minCount: number, placeholderPrefix: string): string[] {
  const total = Math.max(minCount, realIds.length);
  const ids = [...realIds];
  for (let i = realIds.length; i < total; i++) ids.push(`${placeholderPrefix}-${i}`);
  return ids;
}

/**
 * Computes phase `p`'s own character-banner rate-up pool — which named 4-star
 * character goals are actually part of THIS phase's real-world 3-slot roster,
 * padded with anonymous placeholders up to 3 (matching the real game exactly).
 *
 * FIXES a real bug: `featured4StarIds` used to be one static pool built once from
 * the WHOLE goal list and reused unchanged by every phase. `state/
 * buildSimulationInput.ts`'s old `padIds` only padded up to 3 when there were
 * FEWER than 3 real ids named; past that, the pool just grew to however many real
 * ids existed (4, 5, ...) with no ceiling — silently diluting every phase's
 * featured-4-star split below the correct 1/3, since no real phase ever actually
 * has more than 3 roster slots. `goalValidation.ts` used to work around this the
 * only way it could: a hard, GLOBAL cap of 3 four-star goals per banner across the
 * WHOLE list — which blocked the entirely realistic case of naming 4+ four-stars
 * split across 2-3 DIFFERENT phases, each individually still ≤3 active at once.
 *
 * Fixed by computing the pool fresh per phase instead: takes the COMPLEMENT of
 * computeClosedFourStarGoalIdsForPhase's output (rather than re-deriving anchor
 * logic), so this can never drift from the tested closing rules — there's only one
 * source of truth for "is this 4-star in play this phase."
 */
export function computeCharacterBannerConfigForPhase(
  phases: Phase[],
  p: number,
  allCharacterFourStarGoals: Goal[],
  featured5StarId: string,
): CharacterBannerConfig {
  const closed = computeClosedFourStarGoalIdsForPhase(phases, p, allCharacterFourStarGoals);
  const openIds = allCharacterFourStarGoals.filter((g) => !closed.has(g.id)).map((g) => g.targetId);
  return { featured5StarId, featured4StarIds: padIds(openIds, 3, 'other-4star-char') };
}

/**
 * Computes phase `p`'s own weapon-banner config: BOTH the chosen/other-featured
 * Epitomized Path identities AND the 4-star weapon rate-up pool, both scoped to
 * this phase specifically.
 *
 * FIXES a real, deeper bug than computeClosedFiveStarWeaponTargetIdsForPhase's
 * fix: `chosenWeaponId`/`otherFeaturedWeaponId` used to be `weapon5Goals[0]`/`[1]`
 * by GLOBAL priority position across the WHOLE goal list, reused unchanged by
 * every weapon-banner phase. Since transitionWeaponBanner's Fate Point guarantee
 * (weaponBanner.ts: `if (state.fatePoints === 1)`) always resolves to
 * `config.chosenWeaponId` — whichever identity that globally was — a 5star_weapon
 * goal that wasn't the very first one in the whole list could never benefit from a
 * Fate Point guarantee, in ANY phase, including its own, understating its true
 * odds. The earlier fix (computeClosedFiveStarWeaponTargetIdsForPhase) made
 * 5-star-weapon TRACKING phase-scoped, but didn't touch this underlying
 * probability model — a later phase's own weapon still couldn't win via Fate
 * Points even once tracking correctly recognized it as "in play."
 *
 * Fixed by reading straight off THIS phase's own goals (already priority-ordered)
 * — each phase has exactly one weapon banner, so "first/second 5star_weapon goal
 * IN THIS PHASE" is unambiguous and needs no anchor concept, mirroring
 * computeClosedFiveStarWeaponTargetIdsForPhase's own "always-on, no anchor needed"
 * reasoning.
 *
 * "First/second" is now resolved via computeWeaponWindowGoalsForPhase, not raw
 * `phases[p].goals` membership — see the fifteenth reported bug (2026-08-19):
 * when this phase has only ONE own 5star_weapon goal but it's explicitly linked
 * to a goal in a DIFFERENT phase (same real window, split apart by a character
 * detour in priority order), that partner becomes the "other" identity here too,
 * instead of an anonymous placeholder that could never actually be pulled toward
 * the partner's real target. `own[0]` (this phase's own goal) is always
 * "chosen" — unaffected by linking, since a phase's own weapon goal is always
 * the one actually being pursued there.
 *
 * The 4-star weapon pool fix is the same dilution fix as
 * computeCharacterBannerConfigForPhase, just for the weapon side (minCount 5).
 */
export function computeWeaponBannerConfigForPhase(phases: Phase[], p: number, allWeaponFourStarGoals: Goal[]): WeaponBannerConfig {
  const windowGoals = computeWeaponWindowGoalsForPhase(phases, p);
  const chosenWeaponId = windowGoals[0]?.targetId ?? 'chosen-weapon';
  const otherFeaturedWeaponId = windowGoals[1]?.targetId ?? 'other-featured-weapon';
  const closed = computeClosedFourStarGoalIdsForPhase(phases, p, allWeaponFourStarGoals);
  const openIds = allWeaponFourStarGoals.filter((g) => !closed.has(g.id)).map((g) => g.targetId);
  return { chosenWeaponId, otherFeaturedWeaponId, featured4WeaponIds: padIds(openIds, 5, 'other-4star-weapon') };
}

/**
 * Epitomized Path retarget — fourteenth reported bug (2026-08-19). A phase with
 * TWO named `5star_weapon` goals models one real weapon-banner window with both
 * of its event weapons chased in priority order: a rational player, once the
 * first (higher-priority) one is claimed, immediately re-selects their
 * Epitomized Path to the second — real Genshin mechanics confirm switching your
 * selection is a normal, expected action, not a corner case. Before this fix,
 * `computeWeaponBannerConfigForPhase`'s chosen/other assignment was static for
 * the WHOLE phase, so a Fate Point earned after the first weapon was claimed
 * could never benefit the second — it was permanently stuck on the organic
 * 37.5%/50% roll alone, never the "guaranteed within 2 five-star pulls" bound
 * Fate Points otherwise provide.
 *
 * Returns `undefined` when the phase's real EP window (computeWeaponWindowGoalsForPhase,
 * which — since the fifteenth reported bug — includes a cross-phase LINKED
 * partner, not just this phase's own goals) doesn't have exactly 2 members (the
 * only shape a real weapon banner ever has) — callers should treat `undefined`
 * as "no retarget needed," matching every phase before this fix. This is what
 * makes this ALREADY-GENERIC retarget machinery (built for the fourteenth
 * reported bug, keyed on a banner-wide persistent-vector bit lookup in
 * phaseDp.ts, never on phase-local state) transparently apply to the
 * cross-phase-linked case too, with no changes needed there: it fires whenever
 * a phase's own weapon goal, ALREADY claimed, has more of that same phase's own
 * goals still outstanding (e.g. an anchored 4-star weapon goal sharing it) — the
 * remaining pulls correctly retarget toward whichever goal is windowGoals[1],
 * cross-phase partner or same-phase sibling alike.
 *
 * The returned config is the SAME as `computeWeaponBannerConfigForPhase`'s own
 * output but with `chosenWeaponId`/`otherFeaturedWeaponId` swapped — the 4-star
 * weapon pool is unaffected by which of the two is currently "chosen", so it's
 * reused unchanged.
 */
export function computeWeaponBannerConfigAfterFirstClaimedForPhase(
  phases: Phase[],
  p: number,
  allWeaponFourStarGoals: Goal[],
): WeaponBannerConfig | undefined {
  if (computeWeaponWindowGoalsForPhase(phases, p).length !== 2) return undefined;
  const base = computeWeaponBannerConfigForPhase(phases, p, allWeaponFourStarGoals);
  return { ...base, chosenWeaponId: base.otherFeaturedWeaponId, otherFeaturedWeaponId: base.chosenWeaponId };
}
