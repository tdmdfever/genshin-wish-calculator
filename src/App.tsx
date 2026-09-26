import { useState } from 'react';
import './App.css';
import { CharacterBannerForm } from './components/banners/CharacterBannerForm';
import { WeaponBannerForm } from './components/banners/WeaponBannerForm';
import { GoalForm } from './components/goals/GoalForm';
import { GoalList } from './components/goals/GoalList';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { ResultsChart } from './components/results/ResultsChart';
import { BreakdownPanel } from './components/results/BreakdownPanel';
import { TracePanel } from './components/trace/TracePanel';
import { AppStateProvider } from './state/AppStateContext';
import { useAppState } from './state/useAppState';
import { buildSimulationInput } from './state/buildSimulationInput';
import { useSimulation } from './state/useSimulation';
import { validateGoals } from './engine/goalValidation';

function Calculator() {
  const { state } = useAppState();
  const validationErrors = validateGoals(state.goals);
  // An invalid goal list (see GoalList's inline errors) would produce misleading
  // odds, so don't even run the simulation on it — just show nothing until fixed.
  const input = buildSimulationInput(validationErrors.length > 0 ? { ...state, goals: [] } : state);
  const { result, isRunning } = useSimulation(input);
  // Unlike `input` above, NOT gated to an empty goal list when invalid — the
  // trace panel disables itself (disabledReason) and says why.
  const traceInput = buildSimulationInput(state);
  // Shared with ResultsChart so the breakdown panel stays synced to whatever pull
  // count is active there (hover or the full-budget default).
  const [activeIdx, setActiveIdx] = useState(0);
  // A shorter result (smaller pull budget) renders once before ResultsChart's effect resets
  // activeIdx — clamp so that frame doesn't index past the end of the arrays.
  const shownIdx = result ? Math.min(activeIdx, result.pullCounts.length - 1) : 0;

  return (
    <div className="app">
      <header className="app-header">
        <h1>Genshin Impact Wish Calculator</h1>
        <p>Enter your pity, add goals in priority order, and see your odds over your next pulls.</p>
      </header>

      <p className="app-disclaimer">
        Pity, 50/50, and Epitomized Path mechanics are community-verified. Capturing Radiance has never been
        officially documented by HoYoverse — both models offered here (see Settings) are community estimates, not
        confirmed rates. Odds shown are computed exactly (no simulation sampling). Curious how it works? Read the{' '}
        {/* A static page in public/, so it needs the app's base path (/ in dev, /genshin-wish-calculator/ deployed).
            New tab: the goal list you have built is not saved, so leaving this page would lose it. */}
        <a href={`${import.meta.env.BASE_URL}wish-engine-internals.html`} target="_blank" rel="noreferrer noopener">
          Illustrated Explainer &rarr;
        </a>
      </p>

      <section className="section">
        <h2>Your goals, in priority order</h2>
        <GoalList />
        <GoalForm />
      </section>

      <div className="banners-row">
        <CharacterBannerForm />
        <WeaponBannerForm />
      </div>

      <SettingsPanel />

      <section className="section">
        <h2>Odds over your pulls</h2>
        {validationErrors.length > 0 ? (
          <p className="app-disclaimer">Fix the goal list errors above (highlighted in red) to see your odds.</p>
        ) : (
          <>
            <ResultsChart result={result} goals={state.goals} isRunning={isRunning} activeIdx={shownIdx} onActiveIdxChange={setActiveIdx} />
            {result && (
              <BreakdownPanel breakdowns={result.breakdowns} goals={state.goals} activeIdx={shownIdx} activePull={result.pullCounts[shownIdx]} />
            )}
          </>
        )}
      </section>

      <TracePanel
        input={traceInput}
        disabledReason={state.goals.length === 0 ? 'no-goals' : validationErrors.length > 0 ? 'invalid-goals' : undefined}
      />
    </div>
  );
}

function App() {
  return (
    <AppStateProvider>
      <Calculator />
    </AppStateProvider>
  );
}

export default App;
