interface PlanState {
  plan: string
  approved: boolean
}

const planStores = new Map<string, PlanState>()

function getStore(): PlanState {
  const requestId = (globalThis as any).__helixRequestId
  if (requestId && !planStores.has(requestId)) {
    planStores.set(requestId, { plan: '', approved: false })
  }
  if (requestId) return planStores.get(requestId)!
  return { plan: '', approved: false }
}

export const PLAN_ENTER_TOOL_DEFINITION = {
  name: 'plan_enter',
  description: 'Enter structured plan mode. Present a multi-step plan to the user before executing. Call this first to lay out your approach, then use plan_exit to proceed with execution.',
  parameters: {
    plan: { type: 'string' as const, description: 'The structured plan describing steps to accomplish the task', required: true },
  },
  execute: async (params: Record<string, unknown>): Promise<string> => {
    const plan = params.plan as string
    if (!plan) return 'Error: plan is required'

    const store = getStore()
    store.plan = plan
    store.approved = false

    const result = `Plan recorded:\n\n${plan}\n\n---\nPlan is awaiting review. Call plan_exit when ready to proceed with execution.`
    return result
  },
}

export const PLAN_EXIT_TOOL_DEFINITION = {
  name: 'plan_exit',
  description: 'Exit plan mode and proceed with executing the plan. Call this after presenting your plan with plan_enter.',
  parameters: {},
  execute: async (): Promise<string> => {
    const store = getStore()
    if (!store.plan) {
      return 'No active plan. Use plan_enter first to create a plan.'
    }
    store.approved = true
    return `Plan approved. Proceeding with execution.\n\nPlan:\n${store.plan}`
  },
}

export const PLAN_TOOLS = [PLAN_ENTER_TOOL_DEFINITION, PLAN_EXIT_TOOL_DEFINITION]
