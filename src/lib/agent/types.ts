import type { ToolDefinition } from './tools'
import { tools } from './tools'

export interface AgentProfile {
  id: string
  name: string
  description: string
  systemPrompt: string
  allowedTools: string[]
  defaultPermissions: 'full' | 'plan'
}

const ALL_TOOL_NAMES = tools.map(t => t.name)

const AGENT_PROFILES: Record<string, AgentProfile> = {
  build: {
    id: 'build',
    name: 'Build',
    description: 'Full access agent for development and code generation',
    systemPrompt: [
      'You are Helix, an AI programming assistant with full access to the codebase.',
      'Use the available tools to read files, search code, make edits, and run commands.',
      'Read relevant context first, then make targeted changes, and verify when appropriate.',
      '',
      'While working, output brief intermediate explanations to the user after each meaningful batch of read/search operations.',
      'For example, after reading files, summarize what you learned in 1-2 sentences before making the next tool call.',
      'Keep intermediate explanations concise and focused on the user\'s task.',
      '',
      '【Windows note】This environment runs on Windows. Use `read_file` instead of `cat`, `glob` instead of `find`, `list_directory` instead of `ls`.',
    ].join('\n'),
    allowedTools: ALL_TOOL_NAMES,
    defaultPermissions: 'full',
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only agent for codebase exploration and planning',
    systemPrompt: [
      'You are in plan mode. You can only read code and search the codebase — you cannot create, edit, or delete files, or execute commands.',
      'Provide thorough analysis and recommendations.',
    ].join('\n'),
    allowedTools: ['read_file', 'glob', 'grep', 'list_directory', 'webfetch', 'question'],
    defaultPermissions: 'plan',
  },
  general: {
    id: 'general',
    name: 'General',
    description: 'Sub-agent for complex multi-step tasks',
    systemPrompt: 'You are a research assistant with read-only access. Gather information, analyze thoroughly, and report your findings with clear conclusions.',
    allowedTools: ['read_file', 'glob', 'grep', 'list_directory', 'webfetch', 'question'],
    defaultPermissions: 'plan',
  },
  review: {
    id: 'review',
    name: 'Code Review',
    description: 'Git diff-based code review agent',
    systemPrompt: [
      'You are a code review agent. Your job is to analyze code changes and provide thorough, actionable reviews.',
      '',
      'Workflow:',
      '1. Use `git_diff` to get the changes (compare with main/master or current staged changes)',
      '2. Read the affected files for context',
      '3. Analyze for: correctness, security, performance, style, and potential bugs',
      '4. Provide structured feedback in this format:',
      '',
      '## Review Summary',
      '- **Files changed**: N',
      '- **Risk level**: low/medium/high',
      '',
      '## Issues Found',
      '',
      '### [severity] Issue title (file:path line:X)',
      '- **Description**: ...',
      '- **Suggestion**: ...',
      '',
      '## Positive Highlights',
      '- Good patterns or improvements found.',
      '',
      'Be specific, cite line numbers, and include code suggestions where appropriate.',
    ].join('\n'),
    allowedTools: ['read_file', 'git_diff', 'git_log', 'git_branch', 'grep', 'glob', 'list_directory', 'question', 'webfetch'],
    defaultPermissions: 'plan',
  },
}

export function getAgentProfile(id: string): AgentProfile | undefined {
  return AGENT_PROFILES[id]
}

export function getDefaultAgentProfile(): AgentProfile {
  return AGENT_PROFILES.build
}

export function getAllAgentProfiles(): AgentProfile[] {
  return Object.values(AGENT_PROFILES)
}

export function filterToolsByProfile(tools: ToolDefinition[], profile: AgentProfile): ToolDefinition[] {
  return tools.filter(t => profile.allowedTools.includes(t.name))
}
