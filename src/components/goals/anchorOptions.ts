import { buildPhases, computeCharacterWindowGoalsForPhase, computeCharacterWindowPartnerPhase } from '../../engine/phases';
import type { Goal } from '../../engine/types';

/** One "available on" checkbox for a 4★ character: every 5★ character goal of one real phase. */
export interface CharacterAnchorGroup {
  ids: string[];
  label: string;
}

/**
 * The character 4★ anchor options, one per phase rather than one per 5★, so a phase's two
 * simultaneous banners (Goal.linkedCharacterGoalId) are picked together — they always share
 * one 4★ roster, so a partial pick would be invalid. A linked pair split apart in the list by
 * a detour is still one phase (computeCharacterWindowPartnerPhase), so it folds into one option.
 */
export function computeCharacterAnchorGroups(goals: Goal[]): CharacterAnchorGroup[] {
  const phases = buildPhases(goals);
  const groups: CharacterAnchorGroup[] = [];
  const seen = new Set<number>();
  phases.forEach((phase, p) => {
    if (phase.banner !== 'character' || seen.has(p)) return;
    seen.add(p);
    const partner = computeCharacterWindowPartnerPhase(phases, p);
    const fiveStars =
      partner !== undefined
        ? computeCharacterWindowGoalsForPhase(phases, p).filter((g) => g.kind === '5star_character')
        : phase.goals.filter((g) => g.kind === '5star_character');
    if (partner !== undefined) seen.add(partner);
    if (fiveStars.length === 0) return;
    groups.push({ ids: fiveStars.map((g) => g.id), label: fiveStars.map((g) => g.name).join(' + ') });
  });
  return groups;
}

/**
 * The anchors a 4★ that hasn't been given any should show as checked: the only candidate when
 * there is exactly one (the engine attaches an unanchored 4★ to it), otherwise none. Keeps the
 * checkboxes matching what the engine actually computes for a never-touched goal.
 */
export function defaultAnchors(kind: Goal['kind'], characterAnchorGroups: CharacterAnchorGroup[], fiveStarWeaponGoals: Goal[]): string[] {
  if (kind === '4star_character') return characterAnchorGroups.length === 1 ? characterAnchorGroups[0].ids : [];
  if (kind === '4star_weapon') return fiveStarWeaponGoals.length === 1 ? [fiveStarWeaponGoals[0].id] : [];
  return [];
}

/** How many of the character anchor groups are fully selected by `anchors`. */
export function countSelectedGroups(characterAnchorGroups: CharacterAnchorGroup[], anchors: string[]): number {
  return characterAnchorGroups.filter((g) => g.ids.every((id) => anchors.includes(id))).length;
}
