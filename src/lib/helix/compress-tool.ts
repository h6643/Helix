export const COMPRESS_TOOL_DEFINITION = {
  name: 'compress',
  description: 'Compress the conversation context to free up tokens. Call this when you notice the conversation is getting long and you want to consolidate what has been learned and done. The system will preserve your task list and recent context.',
  parameters: {
    reason: { type: 'string' as const, description: 'Why compression is needed (optional)' },
  },
  execute: async (params: Record<string, unknown>): Promise<string> => {
    const requestId = (globalThis as any).__helixRequestId as string | undefined
    if (!requestId) return 'Error: No active agent session'

    ;(globalThis as any).__helixCompressRequested = true
    const reason = (params.reason as string) || ''
    return `Context compression has been requested${reason ? ` (reason: ${reason})` : ''}. The system will apply compression before the next step.`
  },
}
