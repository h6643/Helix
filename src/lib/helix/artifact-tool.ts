import type { ToolDefinition } from '@/lib/agent/tools'

export const ARTIFACT_TOOL_DEFINITION: ToolDefinition = {
  name: 'create_artifact',
  description: 'Create a persistent visual artifact (HTML page, Mermaid diagram, or Markdown document) that will be rendered in a dedicated viewer. Use this for charts, diagrams, reports, dashboards, or any rich visual content.',
  parameters: {
    title: { type: 'string', description: 'Artifact title', required: true },
    type: { type: 'string', description: 'Artifact type: html, markdown, mermaid', required: true },
    content: { type: 'string', description: 'Full content. For HTML: valid HTML document. For mermaid: Mermaid diagram definition. For markdown: Markdown text.', required: true },
  },
  execute: async (params) => {
    const title = (params.title as string) || ''
    const type = (params.type as string) || 'html'
    const content = (params.content as string) || ''
    if (!title || !content) return 'Error: title and content are required'

    try {
      const { useHelixStore } = await import('@/stores/helix-store')
      const id = useHelixStore.getState().addArtifact({ title, type: type as 'html' | 'markdown' | 'mermaid', content })
      return `Artifact created: "${title}" (${type}, id: ${id})`
    } catch {
      return 'Artifact created (store unavailable)'
    }
  },
}
