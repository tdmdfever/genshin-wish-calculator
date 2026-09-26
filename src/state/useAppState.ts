import { createContext, useContext } from 'react';
import type { Action, AppState } from './AppStateContext';

// Kept out of AppStateContext.tsx so that file exports only its component (React fast refresh).
export const AppStateContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
