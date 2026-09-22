import { useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

// Set inline, and only while a drag is live. As a CSS class it made the row that had slid aside
// animate a second time when the drop re-ordered the list (it jumped, then eased into place).
const SLIDE = 'transform 150ms ease';

interface DragState {
  id: string;
  from: number;
  to: number;
  dy: number;
}

interface Geometry {
  tops: number[];
  heights: number[];
  gap: number;
  startY: number;
}

/**
 * Drag-to-reorder for a vertical list, driven by a handle on each row. It uses pointer events
 * rather than HTML5 drag-and-drop so it also works by touch (phones, iPads). While a row is held,
 * it follows the pointer and the rows it passes slide out of its way; letting go asks
 * `onReorder` to move it to the slot it is hovering. The handle is also a keyboard control:
 * ArrowUp / ArrowDown move the row one place.
 */
export function useDragReorder(ids: string[], onReorder: (id: string, toIndex: number) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const geometry = useRef<Geometry | null>(null);

  /** Ref callback for each row's element. */
  function rowRef(id: string) {
    return (el: HTMLElement | null) => {
      if (el) rowEls.current.set(id, el);
      else rowEls.current.delete(id);
    };
  }

  function onPointerDown(id: string, idx: number, e: PointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    const rects = ids.map((i) => rowEls.current.get(i)?.getBoundingClientRect());
    if (rects.some((r) => !r)) return;
    const tops = rects.map((r) => r!.top);
    const heights = rects.map((r) => r!.height);
    const gap = ids.length > 1 ? tops[1] - (tops[0] + heights[0]) : 0;
    geometry.current = { tops, heights, gap, startY: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id, from: idx, to: idx, dy: 0 });
  }

  function onPointerMove(e: PointerEvent<HTMLElement>) {
    const g = geometry.current;
    if (!drag || !g) return;
    const last = ids.length - 1;
    // keep the held row inside the list
    const minDy = g.tops[0] - g.tops[drag.from];
    const maxDy = g.tops[last] + g.heights[last] - (g.tops[drag.from] + g.heights[drag.from]);
    const dy = Math.max(minDy, Math.min(maxDy, e.clientY - g.startY));
    // Rows have different heights, so a row's slot changes by its EDGES, not its centre: moving
    // down it passes a row once its bottom edge crosses that row's centre, moving up once its top
    // edge does. (Comparing centres could never reach the last slot for a row taller than the last.)
    const top = g.tops[drag.from] + dy;
    const bottom = top + g.heights[drag.from];
    let to = drag.from;
    for (let j = drag.from + 1; j < ids.length; j++) if (g.tops[j] + g.heights[j] / 2 < bottom) to = j;
    for (let j = drag.from - 1; j >= 0; j--) if (g.tops[j] + g.heights[j] / 2 > top) to = j;
    setDrag({ ...drag, to, dy });
  }

  function finish(commit: boolean) {
    if (commit && drag && drag.to !== drag.from) onReorder(drag.id, drag.to);
    geometry.current = null;
    setDrag(null);
  }

  function onKeyDown(id: string, idx: number, e: KeyboardEvent<HTMLElement>) {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const to = idx + (e.key === 'ArrowUp' ? -1 : 1);
    if (to < 0 || to >= ids.length) return;
    onReorder(id, to);
    // the row is re-inserted by the reorder, which can drop focus; put it back
    requestAnimationFrame(() => rowEls.current.get(id)?.querySelector<HTMLElement>('.goal-drag-handle')?.focus());
  }

  /** Props for a row's drag handle. */
  function handleProps(id: string, idx: number) {
    return {
      onPointerDown: (e: PointerEvent<HTMLElement>) => onPointerDown(id, idx, e),
      onPointerMove,
      onPointerUp: () => finish(true),
      onPointerCancel: () => finish(false),
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKeyDown(id, idx, e),
    };
  }

  /** Inline style for a row: the held row follows the pointer, rows in its way slide aside. */
  function rowStyle(id: string, idx: number): CSSProperties | undefined {
    const g = geometry.current;
    if (!drag || !g) return undefined;
    if (id === drag.id) return { transform: `translateY(${drag.dy}px)` };
    const step = g.heights[drag.from] + g.gap;
    if (drag.from < drag.to && idx > drag.from && idx <= drag.to) return { transform: `translateY(${-step}px)`, transition: SLIDE };
    if (drag.from > drag.to && idx >= drag.to && idx < drag.from) return { transform: `translateY(${step}px)`, transition: SLIDE };
    return { transition: SLIDE };
  }

  return { dragId: drag?.id ?? null, rowRef, handleProps, rowStyle };
}
