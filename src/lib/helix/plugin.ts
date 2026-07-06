import type { ToolDefinition } from '@/lib/agent/tools'

export interface ToolDefinitionHook {
  (tool: ToolDefinition): ToolDefinition
}

export interface Plugin {
  name: string
  onToolDefinition?: ToolDefinitionHook
}

const plugins: Plugin[] = []

export function registerPlugin(plugin: Plugin): void {
  if (plugins.find(p => p.name === plugin.name)) {
    console.warn(`[Plugin] Plugin "${plugin.name}" already registered, skipping`)
    return
  }
  plugins.push(plugin)
  console.log(`[Plugin] Registered: ${plugin.name}`)
}

export function unregisterPlugin(name: string): void {
  const idx = plugins.findIndex(p => p.name === name)
  if (idx >= 0) {
    plugins.splice(idx, 1)
    console.log(`[Plugin] Unregistered: ${name}`)
  }
}

export function getPlugins(): Plugin[] {
  return [...plugins]
}

export function applyToolDefinitionHooks(tool: ToolDefinition): ToolDefinition {
  let mutated = { ...tool, parameters: { ...tool.parameters } }
  for (const plugin of plugins) {
    if (plugin.onToolDefinition) {
      try {
        mutated = plugin.onToolDefinition(mutated)
      } catch (err) {
        console.error(`[Plugin] Error in "${plugin.name}".onToolDefinition:`, err)
      }
    }
  }
  return mutated
}

export function applyAllToolHooks(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map(t => applyToolDefinitionHooks(t))
}
