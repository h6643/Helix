/**
 * Track shell context: CWD, FILES referenced
 * Ported from Helix's shell tool state tracking
 */

import path from 'path'

interface ShellContextState {
  cwd: string
  files: string[]
}

let state: ShellContextState = {
  cwd: process.cwd(),
  files: [],
}

export function getCwd(): string {
  return state.cwd
}

export function setCwd(dir: string): void {
  state.cwd = dir
}

export function getFiles(): readonly string[] {
  return state.files
}

export function addFile(file: string): void {
  const abs = path.resolve(state.cwd, file)
  if (!state.files.includes(abs)) {
    state.files.push(abs)
  }
}

export function addFiles(files: string[]): void {
  for (const f of files) addFile(f)
}

export function resetContext(): void {
  state = { cwd: process.cwd(), files: [] }
}
