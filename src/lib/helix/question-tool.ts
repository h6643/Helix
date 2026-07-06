import type { ToolDefinition } from '@/lib/agent/tools'
import { createQuestion, waitForAnswer, type QuestionPrompt } from '@/lib/agent/question'

export const QUESTION_TOOL_DEFINITION: ToolDefinition = {
  name: 'question',
  description: 'Ask the user for input or clarification. Use this when you need additional information, preferences, or decisions from the user to proceed with a task.',
  parameters: {
    questions: {
      type: 'string',
      description: 'JSON array of questions to ask. Each question has: question (string, required), header (string, optional short label max 30 chars), options (array of {label, description}, optional), multiple (boolean, optional, allow selecting multiple)',
      required: true,
    },
  },
  execute: async (params) => {
    const questionsRaw = params.questions as string
    const questionId = params._questionId as string
    let questions: QuestionPrompt[]
    try {
      questions = typeof questionsRaw === 'string' ? JSON.parse(questionsRaw) : questionsRaw as QuestionPrompt[]
      if (!Array.isArray(questions)) throw new Error('questions must be an array')
    } catch {
      return 'Error: questions must be a valid JSON array of QuestionPrompt objects'
    }

    if (questions.length === 0) {
      return 'Error: at least one question is required'
    }

    const qid = questionId || `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    createQuestion(qid, questions)

    const answers = await waitForAnswer(qid)

    const formatted = questions
      .map((q, i) => `"${q.question}" = "${answers[i]?.length ? answers[i].join(', ') : 'Unanswered'}"`)
      .join(', ')

    return `User has answered your questions: ${formatted}. You can continue with the user's answers in mind.`
  },
}
