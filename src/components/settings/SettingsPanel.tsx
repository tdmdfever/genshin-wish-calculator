import { useAppState } from '../../state/AppStateContext';
import { NumberField } from '../common/NumberField';

export function SettingsPanel() {
  const { state, dispatch } = useAppState();

  return (
    <fieldset className="banner-form">
      <legend>Settings</legend>

      <label className="field">
        <span>Pull budget (total wishes available)</span>
        <NumberField value={state.pullBudget} min={0} max={2000} onChange={(n) => dispatch({ type: 'SET_PULL_BUDGET', value: n })} />
      </label>

      <label className="field">
        <span>
          Capturing Radiance model
          <span className="hint"> — HoYoverse has never published the real formula; both are community estimates</span>
        </span>
        <select value={state.crModelId} onChange={(e) => dispatch({ type: 'SET_CR_MODEL', value: e.target.value as 'A' | 'B' })}>
          <option value="A">Hypothesis A — OneBST 4M-pull analysis (boost starts at 2 losses)</option>
          <option value="B">Hypothesis B — genshin-wishes.com formula (boost starts at 1 loss)</option>
        </select>
      </label>

      {state.crModelId === 'A' && (
        <label className="field">
          <span>
            Counter=2 total win rate (%)
            <span className="hint"> — community estimate is 52–60%, default 55%</span>
          </span>
          <NumberField
            value={Math.round(state.crParams.r2TotalWinRate * 100)}
            min={50}
            max={100}
            onChange={(n) => dispatch({ type: 'SET_CR_PARAMS', patch: { r2TotalWinRate: n / 100 } })}
          />
        </label>
      )}
    </fieldset>
  );
}
