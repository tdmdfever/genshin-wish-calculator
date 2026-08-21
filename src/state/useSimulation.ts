import { useEffect, useRef, useState } from 'react';
import type { SimulationInput, SimulationResult } from '../engine/types';
import { sliceSimulationResult } from '../engine/sliceResult';
import type { WorkerRequest, WorkerResponse } from '../engine/worker';

/**
 * The subset of `SimulationInput` that determines the exact engine's output at
 * every pull count — everything except `pullBudget` itself (the dimension this
 * cache exists to avoid recomputing across) and `trialCount`/`seed` (read only
 * by the Monte Carlo engine, never by `runExactSimulation` — see
 * exactEngine.ts's own destructuring of `input`). Used as the cache key below.
 */
function cacheKeyFor(input: SimulationInput): string {
  return JSON.stringify({
    goals: input.goals,
    characterBanner: input.characterBanner,
    weaponBanner: input.weaponBanner,
    crModelId: input.crModelId,
    crParams: input.crParams,
  });
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

  function handleMessage(event: MessageEvent<WorkerResponse>) {
    inFlightRef.current = false;
    if (event.data.requestId === requestIdRef.current) {
      setResult(event.data.result);
      setIsRunning(false);
      cacheRef.current = { key: pendingKeyRef.current, maxPulls: pendingMaxPullsRef.current, result: event.data.result };
    }
  }

  function spawnWorker(): Worker {
    const worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = handleMessage;
    return worker;
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
      requestIdRef.current += 1; // invalidate any still-in-flight older worker response
      if (inFlightRef.current) {
        // That in-flight computation's result is about to be superseded by
        // this cache hit and would just be discarded on arrival (requestId
        // won't match) — free the worker now instead of leaving it to grind
        // through a computation nothing needs, same reasoning as the
        // terminate-and-respawn fix below.
        workerRef.current?.terminate();
        workerRef.current = spawnWorker();
        inFlightRef.current = false;
      }
      setResult(sliceSimulationResult(cached.result, input.pullBudget));
      setIsRunning(false);
      return;
    }

    setIsRunning(true);
    const timeout = setTimeout(() => {
      requestIdRef.current += 1;
      // The worker's own `onmessage` runs `runExactSimulation` SYNCHRONOUSLY
      // on its single thread — a second postMessage while one is still
      // running just queues behind it, wasting the full time of the now-
      // obsolete computation before the new one even starts (found live:
      // deleting a goal right after adding one took LONGER than entering the
      // resulting shorter list from scratch, since the stale, discarded
      // computation for the longer list had to finish first). Terminating
      // and replacing the worker whenever it's still crunching an old
      // request immediately frees it up for the new one instead of waiting
      // it out — a Worker can be killed mid-computation, unlike the main
      // thread.
      if (inFlightRef.current) {
        workerRef.current?.terminate();
        workerRef.current = spawnWorker();
      }
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
