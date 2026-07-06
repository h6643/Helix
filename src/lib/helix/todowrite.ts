interface TodoItem {
  id: string
  label: string
  status: 'pending' | 'in_progress' | 'done' | 'blocked'
  subItems?: TodoItem[]
}

const todoStores = new Map<string, TodoItem[]>()
let nextId = 1

function getStore(): TodoItem[] {
  const requestId = (globalThis as any).__helixRequestId
  if (requestId && !todoStores.has(requestId)) {
    todoStores.set(requestId, [])
  }
  if (requestId) return todoStores.get(requestId)!
  return []
}

function findTodo(items: TodoItem[], id: string): TodoItem | undefined {
  for (const item of items) {
    if (item.id === id) return item
    if (item.subItems) {
      const found = findTodo(item.subItems, id)
      if (found) return found
    }
  }
  return undefined
}

function removeTodo(items: TodoItem[], id: string): boolean {
  const idx = items.findIndex(i => i.id === id)
  if (idx >= 0) {
    items.splice(idx, 1)
    return true
  }
  for (const item of items) {
    if (item.subItems && removeTodo(item.subItems, id)) return true
  }
  return false
}

function formatTodos(items: TodoItem[], indent = 0): string {
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

export const TODOWRITE_TOOL_DEFINITION = {
  name: 'todowrite',
  description: 'Create and manage a structured task list. Actions: create (add a new task), update (change status), list (show all tasks), delete (remove a task), clear (reset all tasks). Use this to track progress on multi-step work.',
  parameters: {
    action: { type: 'string' as const, description: 'Action: create, update, list, delete, clear', required: true },
    id: { type: 'string' as const, description: 'Task ID (required for update, delete)' },
    label: { type: 'string' as const, description: 'Task label (required for create)' },
    status: { type: 'string' as const, description: 'New status: pending, in_progress, done, blocked (for update)' },
    parent_id: { type: 'string' as const, description: 'Parent task ID to nest under (optional, for create)' },
  },
  execute: async (params: Record<string, unknown>): Promise<string> => {
    const action = params.action as string
    const store = getStore()

    switch (action) {
      case 'create': {
        const label = params.label as string
        if (!label) return 'Error: label is required for create action'
        const parentId = params.parent_id as string | undefined
        const newItem: TodoItem = { id: String(nextId++), label, status: 'pending' }

        if (parentId) {
          const parent = findTodo(store, parentId)
          if (!parent) return `Error: Parent task "${parentId}" not found`
          parent.subItems = parent.subItems || []
          parent.subItems.push(newItem)
        } else {
          store.push(newItem)
        }

        const formatted = formatTodos(store)
        return `Created task: ${label} (id: ${newItem.id})\n\nCurrent tasks:\n${formatted || '(no tasks)'}`
      }

      case 'update': {
        const id = params.id as string
        if (!id) return 'Error: id is required for update action'
        const item = findTodo(store, id)
        if (!item) return `Error: Task "${id}" not found`
        const status = params.status as string
        if (status) {
          if (!['pending', 'in_progress', 'done', 'blocked'].includes(status)) {
            return `Error: Invalid status "${status}". Valid: pending, in_progress, done, blocked`
          }
          item.status = status as TodoItem['status']
        }
        const formatted = formatTodos(store)
        return `Updated task ${id} → ${item.status}\n\nCurrent tasks:\n${formatted || '(no tasks)'}`
      }

      case 'list': {
        const formatted = formatTodos(store)
        return formatted || '(no tasks)'
      }

      case 'delete': {
        const delId = params.id as string
        if (!delId) return 'Error: id is required for delete action'
        const deleted = removeTodo(store, delId)
        if (!deleted) return `Error: Task "${delId}" not found`
        const formatted = formatTodos(store)
        return `Deleted task ${delId}\n\nCurrent tasks:\n${formatted || '(no tasks)'}`
      }

      case 'clear':
        store.length = 0
        return 'All tasks cleared'

      default:
        return `Error: Unknown action "${action}". Valid: create, update, list, delete, clear`
    }
  },
}
