import { NextRequest } from 'next/server'
import { answerQuestion, getPendingQuestion } from '@/lib/agent/question'

export async function POST(req: NextRequest) {
  try {
    const { questionId, answers } = await req.json()

    if (!questionId || !answers) {
      return new Response(
        JSON.stringify({ error: 'questionId and answers are required' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const question = getPendingQuestion(questionId)
    if (!question) {
      return new Response(
        JSON.stringify({ error: 'Question not found or already answered' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      )
    }

    const success = answerQuestion(questionId, answers)
    if (!success) {
      return new Response(
        JSON.stringify({ error: 'Failed to answer question' }),
        { status: 409, headers: { 'Content-Type': 'application/json' } },
      )
    }

    return new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    )
  }
}

export async function GET() {
  return new Response(
    JSON.stringify({ questions: [] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}
