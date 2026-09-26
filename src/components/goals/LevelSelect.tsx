import { LEVEL_OPTIONS, levelLabel, type FourStarKind } from '../../engine/goalKinds';

/** The constellation (C0-C6) or refinement (R1-R5) a 4★ goal waits for — used by the Add form and each goal row. */
export function LevelSelect({ kind, value, onChange }: { kind: FourStarKind; value: number; onChange: (level: number) => void }) {
  return (
    <select
      className="level-select"
      aria-label={kind === '4star_character' ? 'Constellation to wait for' : 'Refinement to wait for'}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {LEVEL_OPTIONS[kind].map((level) => (
        <option key={level} value={level}>
          {levelLabel(kind, level)}
        </option>
      ))}
    </select>
  );
}
