/**
 * Provider Store — manages provider/model selection state.
 */

import { create } from "zustand";

interface ProviderConfig {
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
  setActiveModel: (model: string | null) => void;
}

export const useProviderStore = create<ProviderState>((set) => ({
  providers: [],
  activeModel: null,
  setActiveModel: (model) => set({ activeModel: model }),
}));
