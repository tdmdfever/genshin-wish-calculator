import { useEffect, useRef, useState } from 'react';
import type { SimulationInput, SimulationResult } from '../engine/types';
import { sliceSimulationResult } from '../engine/sliceResult';
import type { WorkerRequest, WorkerResponse } from '../engine/worker';

/**
 * The subset of `SimulationInput` that determines the exact engine's output at
 * every pull count — everything except `pullBudget` itself (the dimension this
 * cache exists to avoid recomputing across) and goal names (they only label the
 * result — see present()). Used as the cache key below.
 */
function cacheKeyFor(input: SimulationInput): string {
  return JSON.stringify({
    goals: input.goals.map(({ name: _name, ...rest }) => rest),
    characterBanner: input.characterBanner,
    weaponBanner: input.weaponBanner,
    crModelId: input.crModelId,
    crParams: input.crParams,
  });
}

/**
 * A computed result as it should be shown for `input`: cut to its pull budget and labelled with its
 * current goal names, so renaming a goal (or lowering the budget) never needs a recompute. Labels
 * are built the way exactEngine.ts builds them.
 */
function present(result: SimulationResult, input: SimulationInput): SimulationResult {
  const sliced = sliceSimulationResult(result, input.pullBudget);
  const nameById = new Map(input.goals.map((g) => [g.id, g.name]));
  return {
    ...sliced,
    series: sliced.series.map((s) => ({ ...s, label: s.goalIds.map((id) => nameById.get(id) ?? id).join(' + ') })),
    breakdowns: sliced.breakdowns.map((b) => ({ ...b, goalName: nameById.get(b.goalId) ?? b.goalName })),
  };
}

/** Debounced hook that runs the exact simulation in a Web Worker whenever `input` changes. */
export function useSimulation(input: SimulationInput, debounceMs = 300) {
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  // Whether the worker is currently crunching a request whose response hasn't
  // arrived yet — see spawnWorker's own comment on why this matters.
  const inFlightRef = useRef(false);
  // The largest-budget result computed so far for a given (goals, banner
  // state, CR settings) key — see sliceSimulationResult's own doc comment for
  // why shrinking the pull budget can be served from this instead of a full
  // worker recompute. `pendingKeyRef`/`pendingMaxPullsRef` record which key
  // and budget a currently in-flight worker request is FOR, so `handleMessage`
  // knows what to store the response under once it lands (it can't just reuse
  // `input`, which may have already changed again by then).
  const cacheRef = useRef<{ key: string; maxPulls: number; result: SimulationResult } | null>(null);
  const pendingKeyRef = useRef<string>('');
  const pendingMaxPullsRef = useRef(0);
  // The latest input, for labelling a response that lands after further renames.
  const latestInputRef = useRef(input);
  latestInputRef.current = input;

  function handleMessage(event: MessageEvent<WorkerResponse>) {
    inFlightRef.current = false;
    if (event.data.requestId !== requestIdRef.current) return;
    cacheRef.current = { key: pendingKeyRef.current, maxPulls: pendingMaxPullsRef.current, result: event.data.result };
    // Show it only if it still answers the latest input (a changed input has its own request coming).
    const latest = latestInputRef.current;
    if (latest.goals.length > 0 && cacheKeyFor(latest) === pendingKeyRef.current && pendingMaxPullsRef.current >= latest.pullBudget) {
      setResult(present(event.data.result, latest));
      setIsRunning(false);
    }
  }

  function spawnWorker(): Worker {
    const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = handleMessage;
    return worker;
  }

  /**
   * Makes any request still in flight obsolete: bumping the request id means its response is
   * ignored if it arrives, and if the worker is still crunching it, the worker is replaced. The
   * worker runs `runExactSimulation` synchronously on its single thread, so a later postMessage
   * would otherwise wait behind the obsolete computation. A Worker can be killed mid-computation,
   * unlike the main thread.
   */
  function cancelInFlight() {
    requestIdRef.current += 1;
    if (inFlightRef.current) {
      workerRef.current?.terminate();
      workerRef.current = spawnWorker();
      inFlightRef.current = false;
    }
  }

  useEffect(() => {
    workerRef.current = spawnWorker();
    return () => workerRef.current?.terminate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stringify so the effect only re-fires when the input's actual content changes,
  // not merely because the caller rebuilt a fresh object this render.
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    if (input.goals.length === 0) {
      // Also covers an invalid goal list (App passes no goals then): without cancelling, a result
      // for the previous list could still land after this and be shown.
      cancelInFlight();
      setResult(null);
      setIsRunning(false);
      return;
    }

    const key = cacheKeyFor(input);
    const cached = cacheRef.current;
    if (cached && cached.key === key && cached.maxPulls >= input.pullBudget) {
      // A pull-budget DECREASE against an already-computed larger budget —
      // sliceSimulationResult (mostly, see its own doc comment for the tiny,
      // reviewed exception) doesn't need to touch the worker or the DP at
      // all. This is what makes dragging the pull-budget field down feel
      // instant instead of re-paying the full recompute cost every time.
      cancelInFlight();
      setResult(present(cached.result, input));
      setIsRunning(false);
      return;
    }

    if (inFlightRef.current && pendingKeyRef.current === key && pendingMaxPullsRef.current >= input.pullBudget) {
      // Only names (or a smaller budget) changed while the answer is already being computed: let it
      // finish — handleMessage labels it with the latest input.
      setIsRunning(true);
      return;
    }

    setIsRunning(true);
    const timeout = setTimeout(() => {
      cancelInFlight();
      inFlightRef.current = true;
      pendingKeyRef.current = key;
      pendingMaxPullsRef.current = input.pullBudget;
      const request: WorkerRequest = { requestId: requestIdRef.current, input };
      workerRef.current?.postMessage(request);
    }, debounceMs);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, debounceMs]);

  return { result, isRunning };
}
