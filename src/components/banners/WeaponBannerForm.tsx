import { useState } from 'react';
import { useAppState } from '../../state/AppStateContext';
import { NumberField } from '../common/NumberField';

export function WeaponBannerForm() {
  const { state, dispatch } = useAppState();
  const { pity5, guaranteed5, fatePoints, pity4, guaranteed4 } = state.weaponBanner.state;
  const [showAdvanced, setShowAdvanced] = useState(false);

  return (
    <fieldset className="banner-form">
      <legend>Weapon Event Wish</legend>

      <label className="field">
        <span>Current pity (pulls since last 5★)</span>
        <NumberField value={pity5} min={0} max={79} onChange={(n) => dispatch({ type: 'SET_WEAPON_STATE', patch: { pity5: n } })} />
      </label>

      <label className="field field-checkbox">
        <input
          type="checkbox"
          checked={guaranteed5}
          onChange={(e) => dispatch({ type: 'SET_WEAPON_STATE', patch: { guaranteed5: e.target.checked } })}
        />
        <span>
          Last 5★ weapon was standard (off-banner)
          <span className="hint"> — next 5★ weapon guaranteed to be one of the two event weapons (could be either)</span>
        </span>
      </label>

      <label className="field field-checkbox">
        <input
          type="checkbox"
          checked={fatePoints === 1}
          onChange={(e) => dispatch({ type: 'SET_WEAPON_STATE', patch: { fatePoints: e.target.checked ? 1 : 0 } })}
        />
        <span>
          Have 1 Fate Point
          <span className="hint"> — next 5★ weapon guaranteed to be your chosen path weapon (overrides the guarantee above)</span>
        </span>
      </label>

      <button type="button" className="advanced-toggle" onClick={() => setShowAdvanced((v) => !v)}>
        {showAdvanced ? 'Hide' : 'Show'} advanced (4★ pity)
      </button>
      {showAdvanced && (
        <div className="advanced-section">
          <label className="field">
            <span>4★ pity (pulls since last 4★)</span>
            <NumberField value={pity4} min={0} max={9} onChange={(n) => dispatch({ type: 'SET_WEAPON_STATE', patch: { pity4: n } })} />
          </label>
          <label className="field field-checkbox">
            <input
              type="checkbox"
              checked={guaranteed4}
              onChange={(e) => dispatch({ type: 'SET_WEAPON_STATE', patch: { guaranteed4: e.target.checked } })}
            />
            <span>Next 4★ is guaranteed featured</span>
          </label>
        </div>
      )}
    </fieldset>
  );
}
