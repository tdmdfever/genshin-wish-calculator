import type { BannerKind, Goal, GoalKind } from './types';

/**
 * The per-kind rules every layer needs — which banner a kind is pulled on, what a 4★ goal's
 * level means in copies, how levels are labelled — in one place, so the engine, the validator
 * and the UI can't drift apart on them.
 */

export type FourStarKind = '4star_character' | '4star_weapon';

export const KIND_LABELS: Record<GoalKind, string> = {
  '5star_character': '5★ character',
  '4star_character': '4★ character',
  '5star_weapon': '5★ weapon',
  '4star_weapon': '4★ weapon',
};

export function bannerOfKind(kind: GoalKind): BannerKind {
  return kind === '5star_weapon' || kind === '4star_weapon' ? 'weapon' : 'character';
}

export function isFourStarKind(kind: GoalKind): kind is FourStarKind {
  return kind === '4star_character' || kind === '4star_weapon';
}

/** The levels a 4★ goal can wait for: C0-C6 for a character, R1-R5 for a weapon. */
export const LEVEL_OPTIONS: Record<FourStarKind, number[]> = {
  '4star_character': [0, 1, 2, 3, 4, 5, 6],
  '4star_weapon': [1, 2, 3, 4, 5],
};

/** "C2" for a character, "R3" for a weapon. */
export function levelLabel(kind: FourStarKind, level: number): string {
  return kind === '4star_character' ? `C${level}` : `R${level}`;
}

/** The level a new 4★ goal waits for: its first copy, which is C0 for a character and R1 for a weapon. */
export function defaultTargetLevel(kind: FourStarKind): number {
  return kind === '4star_character' ? 0 : 1;
}

/** A 4★ goal's target level, with the default applied when it isn't set (0 for a 5★ goal, which has none). */
export function targetLevelOf(goal: Goal): number {
  return goal.targetLevel ?? (isFourStarKind(goal.kind) ? defaultTargetLevel(goal.kind) : 0);
}

/**
 * Copies needed for a goal to count as done: C<n> takes n+1 copies (C0 is the first), R<n>
 * takes n (R1 is the first). A 5★ goal is done on its one copy. Called on the DP's hot path.
 */
export function copiesNeeded(goal: Goal): number {
  if (goal.kind === '4star_character') return targetLevelOf(goal) + 1;
  if (goal.kind === '4star_weapon') return targetLevelOf(goal);
  return 1;
}

/**
 * How many distinct phases a 4★ can be anchored to: a phase runs two simultaneous character
 * banners (sharing one 4★ roster) but only one weapon banner.
 */
export const MAX_ANCHOR_PHASES: Record<FourStarKind, number> = { '4star_character': 2, '4star_weapon': 1 };
