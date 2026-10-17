/**
 * Git auto-commit / push settings slice.
 * Isolated domain: zero cross-reference with other store state. Values are
 * written via `setState` in the settings restore path and read by the
 * auto-commit flow in agent-flow-panel; no setter actions needed.
 */
import type { StateCreator } from "zustand";

export interface GitSlice {
  gitAutoCommit: boolean;
  gitAutoPush: boolean;
  gitPushConfirm: boolean;
  gitAutoBranch: boolean;
  gitRemoteUrl: string;
  gitCommitTemplate: string;
  gitBranchPrefix: string;
}

export const createGitSlice: StateCreator<GitSlice, [], [], GitSlice> = () => ({
  gitAutoCommit: false,
  gitAutoPush: false,
  gitPushConfirm: true,
  gitAutoBranch: false,
  gitRemoteUrl: "",
  gitCommitTemplate: "chore: auto-commit changes",
  gitBranchPrefix: "feature/",
});
