import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import { DEFAULT_CR_PARAMS } from '../engine/capturingRadiance';
import { findFlankingLinkedPair } from '../engine/phases';
import type { CharacterBannerState, CRHypothesisId, CRParams, Goal, GoalKind, WeaponBannerState } from '../engine/types';

/**
 * Only `featured5StarId` survives as UI-configurable state — every other
 * "featured pool" value (4-star ids, weapon Epitomized Path identities) is now
 * derived PER PHASE inside the engine from the goal list itself (see phases.ts's
 * computeCharacterBannerConfigForPhase/computeWeaponBannerConfigForPhase), not
 * stored here. `featured5StarId` is the one genuinely global scalar: 5-star-
 * character matching is identity-agnostic, so it never needs phase-scoping.
 */
export interface AppState {
  characterBanner: { state: CharacterBannerState; config: { featured5StarId: string } };
  weaponBanner: { state: WeaponBannerState };
  goals: Goal[];
  pullBudget: number;
  crModelId: CRHypothesisId;
  crParams: CRParams;
  trialCount: number;
  seed?: number;
}

export const initialAppState: AppState = {
  characterBanner: {
    state: { pity5: 0, guaranteed5: false, crCounter: 0, pity4: 0, guaranteed4: false },
    config: { featured5StarId: 'featured-5star' },
  },
  weaponBanner: {
    state: { pity5: 0, guaranteed5: false, fatePoints: 0, pity4: 0, guaranteed4: false },
  },
  goals: [],
  pullBudget: 90,
  crModelId: 'A',
  crParams: DEFAULT_CR_PARAMS,
  trialCount: 200_000,
};

type Action =
  | { type: 'SET_CHAR_STATE'; patch: Partial<CharacterBannerState> }
  | { type: 'SET_WEAPON_STATE'; patch: Partial<WeaponBannerState> }
  | { type: 'SET_PULL_BUDGET'; value: number }
  | { type: 'SET_CR_MODEL'; value: CRHypothesisId }
  | { type: 'SET_CR_PARAMS'; patch: Partial<CRParams> }
  | { type: 'SET_TRIAL_COUNT'; value: number }
  | { type: 'SET_SEED'; value: number | undefined }
  | {
      type: 'ADD_GOAL';
      name: string;
      kind: GoalKind;
      targetLevel?: number;
      anchoredFiveStarGoalIds?: string[];
      linkedWeaponGoalId?: string;
      linkedCharacterGoalId?: string;
    }
  | { type: 'REMOVE_GOAL'; id: string }
  | { type: 'MOVE_GOAL'; id: string; direction: 'up' | 'down' }
  | { type: 'SET_GOAL_TARGET_LEVEL'; id: string; targetLevel: number }
  | { type: 'SET_GOAL_ANCHORS'; id: string; anchoredFiveStarGoalIds: string[] }
  | { type: 'SET_GOAL_WEAPON_LINK'; id: string; linkedWeaponGoalId: string | undefined }
  | { type: 'SET_GOAL_CHARACTER_LINK'; id: string; linkedCharacterGoalId: string | undefined };

/**
 * Applies a symmetric link field (linkedWeaponGoalId or linkedCharacterGoalId)
 * atomically: clears the acting goal's OLD partner's back-link (if any and
 * different from the new target), clears the NEW target's own old partner's
 * back-link too (defensive), then sets (or clears) both sides of the new
 * relationship. Shared by SET_GOAL_WEAPON_LINK and SET_GOAL_CHARACTER_LINK,
 * which apply the identical atomic-update shape to two different fields.
 */
function applySymmetricLink(goals: Goal[], field: 'linkedWeaponGoalId' | 'linkedCharacterGoalId', actingId: string, newPartnerId: string | undefined): Goal[] {
  const acting = goals.find((g) => g.id === actingId);
  const oldPartnerId = acting?.[field];
  const newPartnerOldLink = newPartnerId ? goals.find((g) => g.id === newPartnerId)?.[field] : undefined;
  const linked = goals.map((g) => {
    if (g.id === actingId) return { ...g, [field]: newPartnerId };
    if (newPartnerId && g.id === newPartnerId) return { ...g, [field]: actingId };
    if (oldPartnerId && g.id === oldPartnerId && g.id !== newPartnerId) return { ...g, [field]: undefined };
    if (newPartnerOldLink && g.id === newPartnerOldLink && g.id !== actingId) return { ...g, [field]: undefined };
    return g;
  });
  if (!newPartnerId) return linked;

  // Reconcile any 4-star goal whose own anchors are now stale against the
  // newly-merged pair — found live: linking Odette+Miko left Alyosha's
  // pre-existing `anchoredFiveStarGoalIds: [Odette.id]` (valid while they
  // were separate, sequential phases) silently invalid the instant they
  // became simultaneous, with a validation error but no fix applied
  // automatically. Two triggers, both auto-extended to include BOTH ids
  // (union with whatever she already has, never removing anything):
  // (1) she's structurally FORCED onto this pair (findFlankingLinkedPair —
  // see its own doc comment for why disconnection/partial-anchor becomes
  // impossible), or (2) her EXISTING anchors already touch exactly one side
  // of the pair (a stale partial match, regardless of her own position).
  return linked.map((g) => {
    if (g.kind !== '4star_character' && g.kind !== '4star_weapon') return g;
    const flanking = findFlankingLinkedPair(linked, g.id);
    const isFlankedByThisPair = flanking && flanking.includes(actingId) && flanking.includes(newPartnerId);
    const anchors = g.anchoredFiveStarGoalIds;
    const touchesExactlyOneSide = !!anchors && (anchors.includes(actingId) !== anchors.includes(newPartnerId));
    if (!isFlankedByThisPair && !touchesExactlyOneSide) return g;
    const merged = new Set([...(anchors ?? []), actingId, newPartnerId]);
    return { ...g, anchoredFiveStarGoalIds: [...merged] };
  });
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_CHAR_STATE':
      return { ...state, characterBanner: { ...state.characterBanner, state: { ...state.characterBanner.state, ...action.patch } } };
    case 'SET_WEAPON_STATE':
      return { ...state, weaponBanner: { ...state.weaponBanner, state: { ...state.weaponBanner.state, ...action.patch } } };
    case 'SET_PULL_BUDGET':
      return { ...state, pullBudget: action.value };
    case 'SET_CR_MODEL':
      return { ...state, crModelId: action.value };
    case 'SET_CR_PARAMS':
      return { ...state, crParams: { ...state.crParams, ...action.patch } };
    case 'SET_TRIAL_COUNT':
      return { ...state, trialCount: action.value };
    case 'SET_SEED':
      return { ...state, seed: action.value };
    case 'ADD_GOAL': {
      const id = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      // A goal's own id doubles as its "featured item" identity (see
      // buildSimulationInput), so the banner's featured-pool config never needs
      // separate manual setup — adding a goal is enough to name it.
      const goal: Goal = {
        id,
        name: action.name,
        kind: action.kind,
        banner: action.kind === '5star_weapon' || action.kind === '4star_weapon' ? 'weapon' : 'character',
        targetId: id,
        targetLevel: action.targetLevel,
        anchoredFiveStarGoalIds: action.anchoredFiveStarGoalIds,
        linkedWeaponGoalId: action.linkedWeaponGoalId,
        linkedCharacterGoalId: action.linkedCharacterGoalId,
      };
      // Both link fields are symmetric (see types.ts's doc comments) — if this
      // new goal links to an existing one, that existing goal's own field must
      // be set to point back, atomically, same as the SET_GOAL_*_LINK cases
      // below. applySymmetricLink handles the "acting goal doesn't exist yet"
      // case fine (acting/oldPartnerId just come back undefined).
      let goals = state.goals;
      if (action.linkedWeaponGoalId) goals = applySymmetricLink([...goals, goal], 'linkedWeaponGoalId', id, action.linkedWeaponGoalId);
      else if (action.linkedCharacterGoalId) goals = applySymmetricLink([...goals, goal], 'linkedCharacterGoalId', id, action.linkedCharacterGoalId);
      else goals = [...goals, goal];
      return { ...state, goals };
    }
    case 'REMOVE_GOAL': {
      const remaining = state.goals.filter((g) => g.id !== action.id);
      // Clean up any dangling references to the removed goal instead of leaving
      // them in place — a stale linkedCharacterGoalId/linkedWeaponGoalId or an
      // anchoredFiveStarGoalIds entry pointing at a goal that no longer exists
      // produces a validation error with no way to resolve it short of
      // re-adding the deleted goal. Unlinking/un-anchoring is always safe: the
      // remaining goal just falls back to "not linked" / "anchored to fewer
      // 5-stars" (or unanchored entirely), which may itself need a fresh anchor
      // selection, but that's a normal, fixable validation state instead of a
      // dead end.
      const goals = remaining.map((g) => ({
        ...g,
        linkedCharacterGoalId: g.linkedCharacterGoalId === action.id ? undefined : g.linkedCharacterGoalId,
        linkedWeaponGoalId: g.linkedWeaponGoalId === action.id ? undefined : g.linkedWeaponGoalId,
        anchoredFiveStarGoalIds: g.anchoredFiveStarGoalIds?.filter((id) => id !== action.id),
      }));
      return { ...state, goals };
    }
    case 'MOVE_GOAL': {
      const idx = state.goals.findIndex((g) => g.id === action.id);
      if (idx === -1) return state;
      const swapWith = action.direction === 'up' ? idx - 1 : idx + 1;
      if (swapWith < 0 || swapWith >= state.goals.length) return state;
      const goals = [...state.goals];
      [goals[idx], goals[swapWith]] = [goals[swapWith], goals[idx]];
      return { ...state, goals };
    }
    case 'SET_GOAL_TARGET_LEVEL':
      return { ...state, goals: state.goals.map((g) => (g.id === action.id ? { ...g, targetLevel: action.targetLevel } : g)) };
    case 'SET_GOAL_ANCHORS':
      return {
        ...state,
        goals: state.goals.map((g) => (g.id === action.id ? { ...g, anchoredFiveStarGoalIds: action.anchoredFiveStarGoalIds } : g)),
      };
    case 'SET_GOAL_WEAPON_LINK':
      return { ...state, goals: applySymmetricLink(state.goals, 'linkedWeaponGoalId', action.id, action.linkedWeaponGoalId) };
    case 'SET_GOAL_CHARACTER_LINK':
      return { ...state, goals: applySymmetricLink(state.goals, 'linkedCharacterGoalId', action.id, action.linkedCharacterGoalId) };
    default:
      return state;
  }
}

const AppStateContext = createContext<{ state: AppState; dispatch: React.Dispatch<Action> } | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialAppState);
  const value = useMemo(() => ({ state, dispatch }), [state]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used within an AppStateProvider');
  return ctx;
}
