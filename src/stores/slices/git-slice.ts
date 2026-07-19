/**
 * Git auto-commit / push settings slice.
 * Isolated domain: zero cross-reference with other store state. The action
 * implementations are simple setters so the HelixState interface can just
 * extend this slice.
 */
import type { StateCreator } from 'zustand'

export interface GitSlice {
  gitAutoCommit: boolean
  gitAutoPush: boolean
  gitPushConfirm: boolean
  gitAutoBranch: boolean
  gitRemoteUrl: string
  gitCommitTemplate: string
  gitBranchPrefix: string
  setGitAutoCommit: (v: boolean) => void
  setGitAutoPush: (v: boolean) => void
  setGitPushConfirm: (v: boolean) => void
  setGitAutoBranch: (v: boolean) => void
  setGitRemoteUrl: (v: string) => void
  setGitCommitTemplate: (v: string) => void
  setGitBranchPrefix: (v: string) => void
}

export const createGitSlice: StateCreator<GitSlice, [], [], GitSlice> = (set) => ({
  gitAutoCommit: false,
  gitAutoPush: false,
  gitPushConfirm: true,
  gitAutoBranch: false,
  gitRemoteUrl: '',
  gitCommitTemplate: 'chore: auto-commit changes',
  gitBranchPrefix: 'feature/',

  setGitAutoCommit: (v) => set({ gitAutoCommit: v }),
  setGitAutoPush: (v) => set({ gitAutoPush: v }),
  setGitPushConfirm: (v) => set({ gitPushConfirm: v }),
  setGitAutoBranch: (v) => set({ gitAutoBranch: v }),
  setGitRemoteUrl: (v) => set({ gitRemoteUrl: v }),
  setGitCommitTemplate: (v) => set({ gitCommitTemplate: v }),
  setGitBranchPrefix: (v) => set({ gitBranchPrefix: v }),
})
