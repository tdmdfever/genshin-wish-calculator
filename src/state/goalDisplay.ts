import type { Goal } from '../engine/types';

/**
 * The name a goal is shown under everywhere (goal list, chart legend and tooltip, table, breakdown
 * panel, trace). A 4★ goal is just its name until it waits for more than the base copy, then it
 * carries the level: "Xingqiu (C2)" for a character, "Sacrificial Sword (R3)" for a weapon (a
 * weapon starts at R1, so R1 is the "nothing extra" case, the way C0 is for a character).
 * 5★ goals are always just their name.
 */
export function goalDisplayName(goal: Goal): string {
  const level = goal.targetLevel ?? 0;
  if (goal.kind === '4star_character' && level > 0) return `${goal.name} (C${level})`;
  if (goal.kind === '4star_weapon' && level > 1) return `${goal.name} (R${level})`;
  return goal.name;
}

/** The engine only reads `name` to build labels, so passing it the display name is what puts the
 * suffix on every output without the engine knowing about it. */
export function withDisplayNames(goals: Goal[]): Goal[] {
  return goals.map((g) => {
    const name = goalDisplayName(g);
    return name === g.name ? g : { ...g, name };
  });
}
