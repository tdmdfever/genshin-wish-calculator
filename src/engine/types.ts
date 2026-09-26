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
  pity5: number; // 0-76 (a 5-star is certain on pull 77)
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
  /**
   * The item identity pull outcomes are matched against. The app sets it to the goal's own id
   * (AppStateContext.tsx's ADD_GOAL), since per-phase banner configs are built from goals.
   */
  targetId: string;
  /**
   * 4★ goals only: the constellation (0-6) or refinement (1-5) at which the goal counts as done
   * for priority/banner-focus purposes (goalKinds.ts's copiesNeeded). Defaults to the first copy:
   * C0 / R1. The breakdown panel always shows every level regardless. 5★ goals have no level —
   * chasing a second copy is a second goal (5★ character matching is identity-agnostic, see
   * simulate.ts's goalMatchesOutcome).
   */
  targetLevel?: number;
  /**
   * 4★ goals only: which same-banner 5★ goal(s) this item is rate-up alongside — i.e. which
   * real phase(s) it's available in. Up to 2 phases for a 4★ character, 1 for a 4★ weapon
   * (goalKinds.ts's MAX_ANCHOR_PHASES).
   *
   * Real structure this models: one Genshin phase (~3 weeks) runs two simultaneous 5★ character
   * banners sharing one 3-slot 4★ roster, plus one weapon banner featuring both its 5★ weapons.
   * Other phases have their own, generally different, rosters (e.g. Genshin 4.5: phase 1
   * {Chiori, Itto} shared {Gorou, Dori, Yun Jin}; phase 2 {Neuvillette, Kazuha} shared {Yanfei,
   * Barbara, Xingqiu}).
   *
   * - `undefined` (never set): attached to the one candidate window when there is exactly one;
   *   with 2+ candidate windows it's "disconnected" and gets its own isolated phase at its own
   *   priority position (phases.ts's computeDisconnectedFourStarGoalIds / buildPhases).
   * - `[]` (explicit empty): always disconnected, even with a single candidate.
   * - Non-empty: the item's copies accrue only in phases within the inclusive range spanned by
   *   its anchors' phases (phases.ts's computeClosedFourStarGoalIdsForPhase — outside that range
   *   it isn't on the roster), except that its own natal phase is never closed. Within a phase
   *   holding two linked 5★ characters, accrual follows the current patch focus
   *   (goalTracking.ts's isFourStarWindowOpenInPhase), and a 4★ anchored only to the first 5★
   *   also holds back the second one's claim until her target is met
   *   (isNextFiveStarClaimBlocked) — otherwise "anchored to one banner" and "anchored to both"
   *   would compute identical odds whenever both banners share a phase.
   *
   * Copy counts themselves are persistent across every phase of a banner (goalTracking.ts's
   * PersistentSpec); anchoring only gates when they can grow. goalValidation.ts enforces the
   * structural rules (anchors exist, cover every 5★ of a shared phase, no other same-kind 5★
   * between an item and its anchors, per-phase roster size).
   */
  anchoredFiveStarGoalIds?: string[];
  /**
   * 5★ weapon goals only: the OTHER 5★ weapon goal on the same real weapon banner (shared
   * Epitomized Path, shared Fate Point progress, either can drop while chasing the other).
   * Explicit rather than inferred from adjacency, because adjacency is wrong both ways: a real
   * phase naturally interleaves [Odette, OdetteWeapon, Raiden, RaidenWeapon] (the two weapons
   * share one banner despite not being adjacent), and two adjacent weapon goals may be two
   * separate banners. Absence means "different banner" — buildPhases splits even an adjacent
   * unlinked pair.
   *
   * Symmetric (A→B implies B→A) and single-partner (a weapon banner features 2 event weapons);
   * goalValidation.ts also rejects another weapon-banner phase between a linked pair, which is
   * what lets both engines skip the Fate Point reset when a linked pair's second phase starts
   * (phases.ts's isWeaponFatePointsResetOnEntry) without tracking where a Fate Point came from.
   */
  linkedWeaponGoalId?: string;
  /**
   * 5★ character goals only: the OTHER 5★ character goal running SIMULTANEOUSLY in the same
   * real phase. Unlike linkedWeaponGoalId this is two separate banners, not one: each has its
   * own 50/50 (you can't lose one to the other), but they share pity/guaranteed5/crCounter
   * (switching banners doesn't reset pity) and the 4★ roster. Featured wins are claimed FIFO in
   * priority order, since 5★ character matching is identity-agnostic. Absence means "a
   * separate, later phase" — so chasing 3+ unrelated 5★s in a row is expressible.
   *
   * Symmetric and single-partner (a phase runs at most 2 character banners). The pair may have
   * 4★ or weapon-banner goals between them in priority order (a phase's weapon banner runs
   * concurrently), but no other 5★ character goal (goalValidation.ts). A pair split by a detour
   * stays two Phase objects but still shares one FIFO window
   * (phases.ts's computeCharacterWindowPartnerPhase). No reset is needed between phases:
   * character pity always carries over, linked or not.
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
 * CharacterBannerConfig/WeaponBannerConfig aren't part of this input: featured pools and Epitomized
 * Path identities are derived per phase from `goals` (phases.ts's
 * computeCharacterBannerConfigForPhase/computeWeaponBannerConfigForPhase). `featured5StarId` is the
 * one global scalar — 5★ character matching is identity-agnostic, so it only labels an outcome.
 */
export interface SimulationInput {
  pullBudget: number;
  characterBanner: { state: CharacterBannerState; featured5StarId: string };
  weaponBanner: { state: WeaponBannerState };
  crModelId: CRHypothesisId;
  crParams: CRParams;
  goals: Goal[]; // priority order
  /** Monte Carlo only (simulate.ts's runSimulation, a test tool) — the exact engine ignores both. */
  trialCount?: number;
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
