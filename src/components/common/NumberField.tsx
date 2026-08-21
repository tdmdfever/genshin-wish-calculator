import { useEffect, useRef, useState } from 'react';

interface NumberFieldProps {
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  id?: string;
}

/**
 * A number input that lets you freely clear and retype instead of snapping back to
 * the clamped value on every keystroke (the problem with a plain controlled
 * `<input type="number">`: clearing it briefly parses to 0, which a naive clamp
 * immediately re-renders back over whatever you were about to type). Invalid input
 * is held as free text with an inline error until it resolves to a valid number, at
 * which point it's committed via onChange; blurring on an invalid value reverts to
 * the last committed value.
 */
export function NumberField({ value, min, max, onChange, id }: NumberFieldProps) {
  const [raw, setRaw] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const isFocused = useRef(false);

  useEffect(() => {
    if (!isFocused.current) setRaw(String(value));
  }, [value]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const text = e.target.value;
    setRaw(text);

    if (text.trim() === '') {
      setError('Required');
      return;
    }
    const n = Number(text);
    if (Number.isNaN(n)) {
      setError('Must be a number');
      return;
    }
    if (n < min) {
      setError(`Must be at least ${min}`);
      return;
    }
    if (n > max) {
      setError(`Must be at most ${max}`);
      return;
    }
    setError(null);
    onChange(n);
  }

  function handleFocus() {
    isFocused.current = true;
  }

  function handleBlur() {
    isFocused.current = false;
    if (error) {
      setRaw(String(value));
      setError(null);
    }
  }

  return (
    <div className="number-field">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={raw}
        onChange={handleChange}
        onFocus={handleFocus}
        onBlur={handleBlur}
        className={error ? 'has-error' : undefined}
        aria-invalid={error ? true : undefined}
      />
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}
