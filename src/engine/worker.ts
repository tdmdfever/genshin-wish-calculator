import { runExactSimulation } from './exactEngine';
import type { SimulationInput, SimulationResult } from './types';

export interface WorkerRequest {
  requestId: number;
  input: SimulationInput;
}

export interface WorkerResponse {
  requestId: number;
  result: SimulationResult;
}

// The exact phase-based engine (exactEngine.ts) is the live runtime engine — exact
// probabilities, no trial count, no sampling noise. runSimulation (Monte Carlo) is
// kept only as a testing/cross-validation tool, not called from the shipped app.
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const { requestId, input } = event.data;
  const result = runExactSimulation(input);
  const response: WorkerResponse = { requestId, result };
  (self as unknown as Worker).postMessage(response);
};
