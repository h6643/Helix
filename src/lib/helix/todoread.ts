export const TODOREAD_TOOL_DEFINITION = {
  name: 'todoread',
  description: 'Read and display the current task list. Returns all tasks with their status and hierarchy. Use this to review progress after context compression or at any point during your work.',
  parameters: {
    filter: { type: 'string' as const, description: 'Optional filter: all (default), pending, in_progress, done, blocked' },
  },
  execute: async (params: Record<string, unknown>): Promise<string> => {
    const requestId = (globalThis as any).__helixRequestId as string | undefined
    if (!requestId) return '(no active session)'

    const store = (globalThis as any).__helixTodoStore as Array<{ id: string; label: string; status: string; subItems?: any[] }> | undefined
    if (!store || store.length === 0) return '(no tasks)'

    const filter = (params.filter as string) || 'all'

    function formatTodos(items: Array<{ id: string; label: string; status: string; subItems?: any[] }>, indent = 0): string {
      if (items.length === 0) return ''
      return items.map(item => {
        const prefix = '  '.repeat(indent)
        const icon =
          item.status === 'done' ? '[x]' :
          item.status === 'in_progress' ? '[>]' :
          item.status === 'blocked' ? '[!]' : '[ ]'
        let line = `${prefix}${icon} ${item.label} (id: ${item.id})`
        if (item.subItems?.length) {
          line += '\n' + formatTodos(item.subItems, indent + 1)
        }
        return line
      }).join('\n')
    }

    function filterItems(items: Array<{ id: string; label: string; status: string; subItems?: any[] }>, status: string): Array<{ id: string; label: string; status: string; subItems?: any[] }> {
      return items
        .filter(item => item.status === status || (item.subItems?.some(si => si.status === status)))
        .map(item => ({
          ...item,
          subItems: item.subItems?.filter(si => si.status === status),
        }))
    }

    const filtered = filter === 'all' ? store : filterItems(store, filter)
    const formatted = formatTodos(filtered)
    return formatted || `(no ${filter} tasks)`
  },
}
