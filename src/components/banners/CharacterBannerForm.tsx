import { useState } from 'react';
import { useAppState } from '../../state/AppStateContext';
import { NumberField } from '../common/NumberField';
import type { CRCounter } from '../../engine/types';

export function CharacterBannerForm() {
  const { state, dispatch } = useAppState();
  const { pity5, guaranteed5, crCounter, pity4, guaranteed4 } = state.characterBanner.state;
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <fieldset className="banner-form">
      <legend>Character Event Wish</legend>

      <label className="field">
        <span>Current pity (pulls since last 5★)</span>
        <NumberField value={pity5} min={0} max={89} onChange={(n) => dispatch({ type: 'SET_CHAR_STATE', patch: { pity5: n } })} />
      </label>

      <label className="field field-checkbox">
        <input
          type="checkbox"
          checked={guaranteed5}
          onChange={(e) => dispatch({ type: 'SET_CHAR_STATE', patch: { guaranteed5: e.target.checked } })}
        />
        <span>Next 5★ is guaranteed featured (already lost a 50/50)</span>
      </label>

      <label className="field">
        <span>
          Capturing Radiance counter
          <span className="hint"> — consecutive 50/50 losses since it last reset</span>
        </span>
        <select
          value={crCounter}
          disabled={guaranteed5}
          onChange={(e) => dispatch({ type: 'SET_CHAR_STATE', patch: { crCounter: Number(e.target.value) as CRCounter } })}
        >
          <option value={0}>0 (no recent losses)</option>
          <option value={1}>1 loss</option>
          <option value={2}>2 losses</option>
          <option value={3}>3 losses (guaranteed next)</option>
        </select>
      </label>

      <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? 'Hide' : 'Show'} advanced (4★ pity)
      </button>
      {showAdvanced && (
        <div className="advanced-section" data-tone="4star">
          <label className="field">
            <span>4★ pity (pulls since last 4★)</span>
            <NumberField value={pity4} min={0} max={9} onChange={(n) => dispatch({ type: 'SET_CHAR_STATE', patch: { pity4: n } })} />
          </label>
          <label className="field field-checkbox">
            <input
              type="checkbox"
              checked={guaranteed4}
              onChange={(e) => dispatch({ type: 'SET_CHAR_STATE', patch: { guaranteed4: e.target.checked } })}
            />
            <span>Next 4★ is guaranteed featured</span>
          </label>
        </div>
      )}
    </fieldset>
  );
}
