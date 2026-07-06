import type { ToolDefinition } from '@/lib/agent/tools'

type LspManagerType = import('./lsp').LspManager

let lspManager: LspManagerType | null = null

export async function initLsp(workDir?: string): Promise<void> {
  if (lspManager) return
  try {
    const { LspManager } = await import('./lsp')
    lspManager = new LspManager(workDir)
  } catch (err) {
    console.warn('[LSP] Failed to initialize:', err)
  }
}

export function getLspManager(): LspManagerType | null {
  return lspManager
}

export async function shutdownLsp(): Promise<void> {
  if (!lspManager) return
  try {
    await lspManager.shutdown()
  } catch { /* ignore */ }
  lspManager = null
}

function createLspTool(name: string, description: string, params: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>, method: string): ToolDefinition {
  return {
    name,
    description,
    parameters: params,
    execute: async (args) => {
      if (!lspManager) return 'LSP not initialized'
      try {
        const mgr = lspManager
        switch (method) {
          case 'goToDefinition':
            return await mgr.goToDefinition(args.filePath as string, Number(args.line), Number(args.character))
          case 'findReferences':
            return await mgr.findReferences(args.filePath as string, Number(args.line), Number(args.character))
          case 'hover':
            return await mgr.hover(args.filePath as string, Number(args.line), Number(args.character))
          case 'documentSymbols':
            return await mgr.documentSymbols(args.filePath as string)
          case 'workspaceSymbols':
            return await mgr.workspaceSymbols(args.query as string)
          default:
            return `Unknown LSP method: ${method}`
        }
      } catch (err) {
        return `LSP error: ${err instanceof Error ? err.message : String(err)}`
      }
    },
  }
}

export const LSP_DEFINITION_TOOL = createLspTool(
  'lsp_definition',
  'Go to the definition of a symbol at a given position. Returns file location of the definition.',
  {
    filePath: { type: 'string', description: 'Absolute or relative path to the file', required: true },
    line: { type: 'number', description: 'Line number (1-based)', required: true },
    character: { type: 'number', description: 'Character offset (1-based)', required: true },
  },
  'goToDefinition',
)

export const LSP_REFERENCES_TOOL = createLspTool(
  'lsp_references',
  'Find all references to a symbol at a given position. Returns all locations where the symbol is referenced.',
  {
    filePath: { type: 'string', description: 'Absolute or relative path to the file', required: true },
    line: { type: 'number', description: 'Line number (1-based)', required: true },
    character: { type: 'number', description: 'Character offset (1-based)', required: true },
  },
  'findReferences',
)

export const LSP_HOVER_TOOL = createLspTool(
  'lsp_hover',
  'Get hover information (type signature, documentation) for a symbol at a given position.',
  {
    filePath: { type: 'string', description: 'Absolute or relative path to the file', required: true },
    line: { type: 'number', description: 'Line number (1-based)', required: true },
    character: { type: 'number', description: 'Character offset (1-based)', required: true },
  },
  'hover',
)

export const LSP_SYMBOLS_TOOL = createLspTool(
  'lsp_symbols',
  'List all symbols (functions, classes, variables, etc.) in a file with their locations.',
  {
    filePath: { type: 'string', description: 'Absolute or relative path to the file', required: true },
  },
  'documentSymbols',
)

export const LSP_WORKSPACE_SYMBOLS_TOOL = createLspTool(
  'lsp_workspace_symbols',
  'Search for symbols (functions, classes, etc.) across the entire workspace by name query.',
  {
    query: { type: 'string', description: 'Search query (empty string returns all symbols)', required: true },
  },
  'workspaceSymbols',
)

export const LSP_TOOLS: ToolDefinition[] = [
  LSP_DEFINITION_TOOL,
  LSP_REFERENCES_TOOL,
  LSP_HOVER_TOOL,
  LSP_SYMBOLS_TOOL,
  LSP_WORKSPACE_SYMBOLS_TOOL,
]
