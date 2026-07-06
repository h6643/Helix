/**
 * Zod validation schemas for API requests
 */

import { z } from 'zod'

export const ApiConfigSchema = z.object({
  provider: z.enum(['openai', 'deepseek', 'mimo', 'custom']),
  apiKey: z.string().min(1, 'API Key 不能为空'),
  baseUrl: z.string().url('无效的 URL'),
  model: z.string().min(1, '模型名称不能为空'),
})

export const AgentRunRequestSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant', 'system']),
    content: z.string(),
  })).min(1),
  apiConfig: ApiConfigSchema,
  workDir: z.string().optional(),
})

export const ApproveRequestSchema = z.object({
  approvalId: z.string().min(1),
  action: z.enum(['approve', 'reject']),
  cache: z.boolean().optional(),
  approveAll: z.boolean().optional(),
})