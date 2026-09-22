import { useRef, useState } from 'react';

/**
 * A goal's name, editable in place: it looks like plain text until hovered or focused. While it
 * has focus it shows (and edits) the goal's own name; otherwise it shows `displayName`, which
 * may carry the "(C2)" suffix. The change is applied on Enter or when focus leaves, not per
 * keystroke (each change recomputes the odds); Escape puts the old name back.
 */
export function GoalNameInput({ name, displayName, onCommit }: { name: string; displayName: string; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const focused = draft !== null;
  // Escape blurs the input, and blur commits; this tells that blur to throw the draft away instead.
  const cancelled = useRef(false);

  function commit() {
    const next = (draft ?? '').trim();
    if (!cancelled.current && next && next !== name) onCommit(next);
    cancelled.current = false;
    setDraft(null);
  }

  return (
    <input
      className="goal-name-input"
      type="text"
      aria-label="Goal name"
      title="Click to rename"
      value={focused ? draft : displayName}
      onFocus={() => setDraft(name)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
    />
  );
}
