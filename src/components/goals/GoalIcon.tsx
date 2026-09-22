import type { GoalKind } from '../../engine/types';

/** Small marker at the start of a priority-list row: a head-and-shoulders silhouette for a
 * character, a sword for a weapon. It draws in `currentColor`, so the row's `data-tone` (gold for
 * 5★, lavender for 4★) colours it. Decorative: the kind is also spelled out in text. */
export function GoalIcon({ kind }: { kind: GoalKind }) {
  const isCharacter = kind === '5star_character' || kind === '4star_character';
  return (
    <svg className="goal-icon" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
      {isCharacter ? (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M3.5 21c0-4.6 3.8-7.5 8.5-7.5s8.5 2.9 8.5 7.5z" />
        </>
      ) : (
        <g transform="rotate(45 12 12)">
          {/* a sword pointing up-right: blade, cross-guard, grip, pommel */}
          <path d="M12 0.5 15 4.5V14H9V4.5z" />
          <rect x="6" y="14.5" width="12" height="2.6" rx="1.3" />
          <rect x="10.7" y="17" width="2.6" height="4" />
          <circle cx="12" cy="22.2" r="1.5" />
        </g>
      )}
    </svg>
  );
}
