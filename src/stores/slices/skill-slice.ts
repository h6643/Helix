/**
 * Skills slice — skill definitions.
 */
import type { StateCreator } from "zustand";
import type { Skill } from "../helix-types";
import { generateId } from "@/lib/format";

export interface SkillSlice {
  skills: Skill[];
  addSkill: (skill: Omit<Skill, "id" | "createdAt">) => string;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
  removeSkill: (skillId: string) => void;
}

export const createSkillSlice: StateCreator<SkillSlice, [], [], SkillSlice> = (
  set,
) => ({
  skills: [],

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
});
