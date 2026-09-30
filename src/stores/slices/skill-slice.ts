/**
 * Skills slice — skill definitions + panel toggle.
 */
import type { StateCreator } from "zustand";
import type { Skill } from "../helix-types";
import { generateId } from "@/lib/format";

export interface SkillSlice {
  skills: Skill[];
  showSkillPanel: boolean;
  /** 面板切换时跳到指定 tab / 预填搜索词 */
  skillPanelRequest: {
    tab: "plugins" | "skills";
    query?: string;
    ts: number;
  };
  openSkillPanelTab: (tab: "plugins" | "skills", query?: string) => void;
  addSkill: (skill: Omit<Skill, "id" | "createdAt">) => string;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
  removeSkill: (skillId: string) => void;
  toggleSkillPanel: () => void;
}

export const createSkillSlice: StateCreator<SkillSlice, [], [], SkillSlice> = (
  set,
) => ({
  skills: [],
  showSkillPanel: false,
  skillPanelRequest: { tab: "plugins", ts: 0 },
  openSkillPanelTab: (tab, query) =>
    set((s) => ({
      showSkillPanel: true,
      skillPanelRequest: { tab, query, ts: s.skillPanelRequest.ts + 1 },
    })),

  addSkill: (skill) => {
    const id = generateId();
    set((state) => ({
      skills: [...state.skills, { ...skill, id, createdAt: Date.now() }],
    }));
    return id;
  },
  updateSkill: (skillId, updates) =>
    set((state) => ({
      skills: state.skills.map((s) =>
        s.id === skillId ? { ...s, ...updates } : s,
      ),
    })),
  removeSkill: (skillId) =>
    set((state) => ({
      skills: state.skills.filter((s) => s.id !== skillId || s.isBuiltin),
    })),
  toggleSkillPanel: () => set((s) => ({ showSkillPanel: !s.showSkillPanel })),
});
