/**
 * Provider Store — manages provider/model selection state.
 */

import { create } from "zustand";

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models: string[];
  defaultModel?: string;
  isDefault?: boolean;
}

interface ProviderState {
  providers: ProviderConfig[];
  activeModel: string | null;
  setProviders: (providers: ProviderConfig[]) => void;
  setActiveModel: (model: string | null) => void;
}

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [],
  activeModel: null,
  setProviders: (providers) => set({ providers }),
  setActiveModel: (model) => set({ activeModel: model }),
}));
