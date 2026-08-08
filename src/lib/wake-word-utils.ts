// Wake-word detection frontend utilities.
// Bridges to the Rust backend which manages the Python wake-word listener
// (_helix_wake.py) as a long-running subprocess.

/**
 * Start the wake-word listener. The Python bridge starts automatically
 * on launch and emits events via `hermes:event` — the frontend listens
 * for `wake_word_wake_word` events to trigger voice conversation.
 */
export async function startWakeWord(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = (await invoke('hermes_wake_start')) as any
    return result?.success ?? false
  } catch (err: any) {
    console.error('[wake] startWakeWord:', err?.message || err)
    return false
  }
}

/**
 * Stop the wake-word listener and clean up the bridge process.
 */
export async function stopWakeWord(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('hermes_wake_control', { action: 'stop' })
  } catch (err: any) {
    console.error('[wake] stopWakeWord:', err?.message || err)
  }
}

/**
 * Pause the wake-word listener (release microphone for a voice turn).
 */
export async function pauseWakeWord(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('hermes_wake_control', { action: 'pause' })
  } catch (err: any) {
    console.error('[wake] pauseWakeWord:', err?.message || err)
  }
}

/**
 * Resume the wake-word listener after a voice turn finishes.
 */
export async function resumeWakeWord(): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('hermes_wake_control', { action: 'resume' })
  } catch (err: any) {
    console.error('[wake] resumeWakeWord:', err?.message || err)
  }
}
