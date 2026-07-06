export class LspManager {
  private workDir: string

  constructor(workDir?: string) {
    this.workDir = workDir || process.cwd()
  }

  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {}

  async goToDefinition(filePath: string, line: number, character: number): Promise<string> {
    return 'LSP not available'
  }

  async findReferences(filePath: string, line: number, character: number): Promise<string> {
    return 'LSP not available'
  }

  async hover(filePath: string, line: number, character: number): Promise<string> {
    return 'LSP not available'
  }

  async documentSymbols(filePath: string): Promise<string> {
    return 'LSP not available'
  }

  async workspaceSymbols(query: string): Promise<string> {
    return 'LSP not available'
  }
}
