export type CRCounter = 0 | 1 | 2 | 3;
export type BannerKind = 'character' | 'weapon';
export type GoalKind = '5star_character' | '5star_weapon' | '4star_character' | '4star_weapon';
export type CRHypothesisId = 'A' | 'B';

/** Outcome of a single pull, banner-agnostic. */
export type PullOutcome =
  | { rarity: 3 }
  | { rarity: 4; kind: 'featured'; itemId: string }
  | { rarity: 4; kind: 'standard' }
  | { rarity: 5; kind: 'featured'; itemId: string }
  | { rarity: 5; kind: 'featured_other'; itemId: string } // weapon banner: other featured (not chosen path)
  | { rarity: 5; kind: 'standard' };

export interface CharacterBannerState {
  pity5: number; // pulls since last 5-star, 0-89
  guaranteed5: boolean;
  crCounter: CRCounter;
  pity4: number; // pulls since last 4-star, 0-9
  guaranteed4: boolean;
}

export interface CharacterBannerConfig {
  featured5StarId: string;
  featured4StarIds: string[]; // typically 3
}

export interface WeaponBannerState {
  pity5: number; // 0-79
  /**
   * Whether the NEXT 5-star weapon is guaranteed to be one of the 2 event
   * (featured) weapons — the weapon banner's own 75/25 pity mechanic,
   * structurally parallel to the character banner's `guaranteed5` (its
   * 50/50). Set true after a "standard" (off-banner) 5-star weapon; consumed
   * (reset false) the next time ANY 5-star weapon drops, regardless of which
   * branch (this flag's own 50/50, or a fate point overriding it entirely —
   * see weaponBanner.ts). Genuinely independent of `fatePoints` below: it
   * carries across weapon-banner phases (a pity mechanic, not tied to a
   * specific phase's Epitomized Path selection), whereas `fatePoints` resets
   * every phase — see exactEngine.ts/simulate.ts for where that reset lives.
   */
  guaranteed5: boolean;
  /**
   * Epitomized Path: earned (set to 1) by obtaining a 5-star weapon that
   * ISN'T your chosen one (the OTHER event weapon, or a standard weapon).
   * Once 1, it fully overrides the next 5-star to be 100% your chosen weapon
   * — this takes priority over `guaranteed5` above (which only matters on its
   * own once fatePoints has reset, e.g. across a phase boundary — see
   * weaponBanner.ts's doc comment on transitionWeaponBanner for the full
   * combination table). Resets to 0 at the start of every NEW weapon-banner
   * phase (Epitomized Path is a per-phase selection), unlike `guaranteed5`.
   */
  fatePoints: 0 | 1;
  pity4: number; // 0-9
  guaranteed4: boolean;
}

export interface WeaponBannerConfig {
  chosenWeaponId: string;
  otherFeaturedWeaponId: string;
  featured4WeaponIds: string[]; // typically 5
}

export interface Goal {
  id: string;
  name: string;
  kind: GoalKind;
  banner: BannerKind;
  /** Featured item id this goal maps to (character/weapon id from the relevant banner config). */
  targetId: string;
  /**
   * Only meaningful for 4star_character/4star_weapon: the constellation (0-6) or
   * refinement (1-5) level at which this goal counts as "done" for priority/
   * banner-focus purposes. Defaults: 0 for character (first copy = C0), 1 for
   * weapon (first copy = R1). Ignored for 5star_* kinds — see the identity-agnostic
   * matching note on goalMatchesOutcome in simulate.ts for why those use separate
   * sequential goals instead of a target level.
   */
  targetLevel?: number;
  /**
   * Which 5-star goal(s) on the SAME banner this item remains available through.
   * Meaningful for 4star_character (references 5star_character goals, max 2) and
   * 4star_weapon (references 5star_weapon goals, max 1).
   *
   * Real structure this models: one Genshin PHASE (~3 weeks) runs TWO simultaneous
   * 5-star character banners sharing the same 3 featured 4-star characters, plus
   * ONE 5-star weapon banner featuring BOTH its 5-star weapons (Epitomized Path
   * choice between them). A DIFFERENT phase (earlier or later) has its own,
   * generally different, roster for both — verified against real patch data (e.g.
   * Genshin 4.5: Phase 1 {Chiori, Itto} shared {Gorou, Dori, Yun Jin}; Phase 2
   * {Neuvillette, Kazuha} shared a different {Yanfei, Barbara, Xingqiu}, zero
   * overlap). So: up to 2 independent anchor points for a 4-star character (one per
   * simultaneous character banner it might be rate-up on), but only 1 for a 4-star
   * weapon (one weapon banner per phase — referencing either of its two
   * 5star_weapon goals is enough to identify "this phase's weapon window").
   *
   * Required whenever the goal list has 2+ 5star_character goals (for
   * 4star_character) or 2+ DISTINCT weapon-banner phases (for 4star_weapon) —
   * otherwise the engine can't know which phase(s) the item belongs to; optional
   * (unrestricted) otherwise. See goalValidation.ts for the "no other same-kind
   * 5-star goal may sit between an item and its anchor(s)" and "an item's own
   * phase must not precede its earliest anchor's phase" rules this is paired with.
   *
   * Copy-count tracking for 4-star goals is PERSISTENT — it carries across every
   * phase of a banner, not just a goal's own phase, since multiple 4-stars
   * genuinely coexist and can drop on any pull of that banner (see
   * goalTracking.ts's PersistentSpec). Anchoring gates whether THIS item's copies
   * keep counting during a GIVEN phase: closed whenever that phase falls OUTSIDE
   * the inclusive range spanned by the item's anchors' own phases — whether the
   * phase comes strictly AFTER every anchor (guaranteed already resolved, since a
   * phase can't graduate without its own goals — including any anchor it contains —
   * being satisfied) or strictly BEFORE every anchor (none of them have happened
   * yet, so the item structurally isn't in that phase's real-world rate-up pool at
   * all — an item positioned earlier in priority than all of its anchors used to
   * silently accrue copies before its anchor's phase could possibly start). See
   * phases.ts's computeClosedFourStarGoalIdsForPhase, recomputed per phase since
   * the same item can be open in one phase and closed in another as focus moves
   * through the goal list. An anchor sharing the SAME phase never closes the window
   * there, even after it's won mid-phase — that phase structurally can't graduate
   * until the item is also done, which already produces "keep pulling until the
   * anchored copy target, then move on." Checking anchor status live (per-pull)
   * instead of per-phase would incorrectly freeze the count the instant the anchor
   * dropped, even within the same banner-focus run.
   *
   * When multiple 5star_character goals share one phase, anchoring must ALSO gate
   * the next 5-star's own win-claim (goalTracking.ts's isNextFiveStarClaimBlocked),
   * not just 4-star copy accrual: a 4-star anchored to only the first of two
   * same-phase 5-stars has to delay that second 5-star from being claimed until its
   * own target is met — otherwise "anchored to one banner" and "anchored to both"
   * would compute identical odds whenever both banners land in the same phase,
   * since a featured win would be claimed by whichever 5-star is next in FIFO order
   * regardless of the 4-star's anchor status. 5-star weapons don't need this: their
   * identity is resolved directly per pull (chosen vs. other-featured vs.
   * standard), never FIFO-claimed, so there's no analogous same-phase ambiguity.
   *
   * 5star_weapon identity tracking (chosen vs. other-featured) needs NO anchor
   * field at all when its window is just its own natal phase — but see
   * linkedWeaponGoalId below for the case where two 5star_weapon goals share one
   * real window despite NOT being phase-adjacent (or vice versa).
   */
  anchoredFiveStarGoalIds?: string[];
  /**
   * Meaningful only on 5star_weapon goals. Points at the OTHER 5star_weapon goal
   * that shares this SAME real weapon-banner window (shared Epitomized Path pool,
   * shared Fate Point progress, opportunistic crediting either direction) —
   * decoupled from priority-list adjacency and therefore possibly from
   * Phase-object membership too. See phases.ts's computeWeaponWindowGoalsForPhase.
   *
   * Fifteenth reported bug (2026-08-19): "same real window" used to be INFERRED
   * purely from adjacency (two 5star_weapon goals merged into one Phase iff
   * adjacent in priority order) — wrong in both directions. Priority order can
   * naturally interleave a phase's two simultaneous character banners with that
   * SAME phase's one shared weapon banner's two weapons (e.g. [Odette,
   * OdetteWeapon, Raiden, RaidenWeapon] — Odette/Raiden share one real phase,
   * and so do OdetteWeapon/RaidenWeapon), which buildPhases used to split into 4
   * unrelated phases, silently denying the second weapon any opportunistic
   * crediting or Fate Point benefit from the first's pulls. Conversely, two
   * ADJACENT 5star_weapon goals (e.g. already own both characters, pulling for
   * each weapon banner in sequence) used to always be forced into one shared
   * window, even when they're genuinely on two different real phases with no
   * sharing at all.
   *
   * Symmetric: if A.linkedWeaponGoalId === B.id then B.linkedWeaponGoalId must
   * === A.id (validated in goalValidation.ts). Absence means "different window"
   * — there is NO adjacency-based default anymore; this is a deliberate behavior
   * change from before this fix (an adjacent, unlinked pair now gets split into
   * two separate phases by buildPhases, not merged). At most one partner (a real
   * weapon banner never features more than 2 event weapons), enforced
   * structurally by this being a single id, not an array — goalValidation.ts
   * additionally rejects a natal phase with more than one OTHER 5star_weapon
   * goal in it, and rejects any OTHER weapon-banner phase (of any composition)
   * sandwiched between a linked pair's two natal phases — the latter is what
   * keeps exactEngine.ts's/simulate.ts's Fate-Point-reset-skip-when-linked fix
   * (see exactEngine.ts's resetWeaponFatePoints) sound without needing to track
   * which specific phase a carried-over Fate Point came from.
   */
  linkedWeaponGoalId?: string;
  /**
   * Meaningful only on 5star_character goals. Points at the OTHER 5star_character
   * goal that shares this SAME real phase — i.e. the two are SIMULTANEOUS: two
   * separate character banners running at once, sharing pity/guarantee5/crCounter
   * state and the same 3-slot featured-4-star roster, with featured wins claimed
   * FIFO by priority order (since 5star_character matching is identity-agnostic —
   * see the note on this near computeCurrentFocusRank in goalTracking.ts).
   *
   * CRITICAL DISTINCTION FROM linkedWeaponGoalId, per the user's explicit
   * correction (2026-08-19): this does NOT mean "the same banner." On the weapon
   * side, "same window" means one literal banner with two items you can get in
   * either order (opportunistic crediting either direction). On the character
   * side, "same phase" means TWO DISTINCT BANNERS running concurrently — you
   * cannot lose your 50/50 to "the other character," because there's no such
   * thing as a shared 50/50 across them; each is its own banner. What they share
   * is the underlying pity/CR state (a shared, real Genshin mechanic: switching
   * which of two simultaneous character banners you pull on does not reset your
   * pity) and the 4-star rate-up roster.
   *
   * Sixteenth reported bug (2026-08-19): "same real phase" used to be INFERRED
   * purely from priority-list adjacency (two 5star_character goals merged into
   * one Phase iff adjacent) — wrong for exactly the reason the fifteenth bug's
   * weapon-side fix was wrong: adjacency is neither necessary (not applicable
   * here — see below) nor sufficient. A user wanting to chase THREE OR MORE
   * 5-stars in a row, from three unrelated sequential phases, with no weapon
   * detour between them, had no way to say "these are NOT simultaneous" — every
   * adjacent run of 5star_character goals was forced into one shared phase,
   * incorrectly triggering "too many 5-stars share one phase" (only 2 real
   * simultaneous banners exist) and forcing any 4-star anchored to just one of
   * them to be rejected ("must be anchored to all of them").
   *
   * Symmetric: if A.linkedCharacterGoalId === B.id then B.linkedCharacterGoalId
   * must === A.id (validated in goalValidation.ts). Absence means "different,
   * sequential phase" — no adjacency-based default. At most one partner (at most
   * 2 simultaneous character banners run per real phase), enforced structurally
   * by this being a single id.
   *
   * A linked pair must have no OTHER 5star_character goal between them in
   * priority order — validated in goalValidation.ts. This isn't a shortcut:
   * two banners that are genuinely simultaneous share one continuous
   * real-world pull window, so a DIFFERENT, unrelated character banner
   * prioritized between them wouldn't correspond to anything achievable in
   * the actual game. A 4star_character goal between them, however, IS fine —
   * that's exactly what same-phase anchoring models (e.g. [Odette,
   * Alyosha(anchored to both), Miko]), not a separate window — and so is a
   * WEAPON-banner goal, which does NOT break the link either: a real phase's
   * one shared weapon banner runs fully concurrently with both of its
   * character banners (e.g. [Odette, OdetteWeapon, Raiden, RaidenWeapon] with
   * Odette<->Raiden linked is a real, valid shape). Unlike the weapon fix,
   * buildPhases never merges a linked pair separated by a weapon-banner goal
   * into one literal Phase object (a Phase is always one contiguous
   * SAME-BANNER run) — it doesn't need to, since character pity carries over
   * unconditionally between ANY two same-banner phases regardless of merging
   * (see below), so goalValidation.ts's check walks priority-list position
   * directly instead of relying on buildPhases having merged anything.
   *
   * No analogous Fate-Points-style reset-on-phase-boundary concern exists here:
   * unlike weapon Epitomized Path (a per-phase SELECTION that resets), character
   * pity/guaranteed5/crCounter is a pure account-persistent pity mechanic that
   * ALWAYS carries over between ANY two character-banner phases in real Genshin,
   * linked or not — so the existing unconditional carry-over in exactEngine.ts/
   * simulate.ts already does the right thing with no special-casing needed.
   */
  linkedCharacterGoalId?: string;
}

/** One possible resolution of a 50/50 (or Capturing-Radiance-eligible) roll, with the counter it leads to. */
export interface CRTransition {
  probability: number;
  result: 'win_normal' | 'win_capturing_radiance' | 'loss';
  nextR: CRCounter;
}

export interface CRParams {
  /** Hypothesis A only: total chance of getting the featured character while at counter=2. Default 0.55. */
  r2TotalWinRate: number;
}

export interface CRModel {
  id: CRHypothesisId;
  /** Must return transitions whose probabilities sum to 1. */
  resolve50_50(r: CRCounter, params: CRParams): CRTransition[];
}

/** One (probability, outcome, nextState) branch of a banner's per-pull transition. */
export interface Transition<TState> {
  probability: number;
  outcome: PullOutcome;
  nextState: TState;
}

/**
 * Note: CharacterBannerConfig/WeaponBannerConfig (defined above) are NOT part of
 * this input — the featured pools/identities they hold are computed fresh PER
 * PHASE, inside the engine, from `goals` (see phases.ts's
 * computeCharacterBannerConfigForPhase/computeWeaponBannerConfigForPhase). A
 * static, banner-wide config used to live here and get reused unchanged by every
 * phase, which caused two real bugs (weapon Epitomized Path identity never
 * benefiting a later phase's own goal; 4-star pools silently diluting past 3/5
 * real names) — see CLAUDE.md. `featured5StarId` is the one genuinely global
 * scalar (5-star-character matching is identity-agnostic, so it never needs
 * phase-scoping — it only labels an outcome shape, never gates tracking).
 */
export interface SimulationInput {
  pullBudget: number;
  characterBanner: { state: CharacterBannerState; featured5StarId: string };
  weaponBanner: { state: WeaponBannerState };
  crModelId: CRHypothesisId;
  crParams: CRParams;
  goals: Goal[]; // priority order
  trialCount: number;
  seed?: number;
}

export interface SimulationSeries {
  prefixLength: number;
  goalIds: string[];
  label: string;
  probabilities: number[]; // aligned with pullCounts
}

/** Full constellation/refinement-level breakdown for one 4-star goal, shown
 * regardless of that goal's own chosen targetLevel — e.g. even if you only need
 * C1, this still reports the odds of ending up at C0 through C6. */
export interface LevelBreakdownSeries {
  goalId: string;
  goalName: string;
  /** e.g. ["C0","C1",...,"C6"] for a character goal, or ["R1",...,"R5"] for a weapon goal. */
  levelLabels: string[];
  /** levelProbabilities[i][pullIndex] = P(reached levelLabels[i] by that pull), aligned with pullCounts. */
  levelProbabilities: number[][];
}

export interface SimulationResult {
  pullCounts: number[];
  series: SimulationSeries[];
  breakdowns: LevelBreakdownSeries[];
  meta: { elapsedMs: number; engine: 'exact' | 'monte-carlo'; trialsRun?: number };
}
