import type { ToolDefinition } from './tools'

export const SUB_AGENT_TOOL: ToolDefinition = {
  name: 'sub_agent',
  description: 'Spawn a sub-agent to handle a task',
  parameters: {
    task: { type: 'string', description: 'Task description' },
  },
  execute: async () => 'Sub-agent execution is not available in this build.',
}

export const SUB_AGENT_RESULT_TOOL: ToolDefinition = {
  name: 'sub_agent_result',
  description: 'Submit result from a sub-agent',
  parameters: {
    task_id: { type: 'string', description: 'Task ID' },
    result: { type: 'string', description: 'Result' },
  },
  execute: async () => 'Sub-agent result submission is not available in this build.',
}
