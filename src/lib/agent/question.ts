export interface QuestionPrompt {
  question: string
  header?: string
  options?: Array<{ label: string; description?: string }>
  multiple?: boolean
}

export interface PendingQuestion {
  id: string
  questions: QuestionPrompt[]
  status: 'pending' | 'answered'
  answers: string[][]
  createdAt: number
}

const pendingQuestions = new Map<string, PendingQuestion>()

type AnswerCallback = {
  resolve: (answers: string[][]) => void
  reject: (error: Error) => void
}
const waitingCallbacks = new Map<string, AnswerCallback>()

export function createQuestion(questionId: string, questions: QuestionPrompt[]): PendingQuestion {
  const q: PendingQuestion = {
    id: questionId,
    questions,
    status: 'pending',
    answers: [],
    createdAt: Date.now(),
  }
  pendingQuestions.set(questionId, q)
  return q
}

export function waitForAnswer(questionId: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    waitingCallbacks.set(questionId, { resolve, reject })
    setTimeout(() => {
      if (waitingCallbacks.has(questionId)) {
        waitingCallbacks.delete(questionId)
        const q = pendingQuestions.get(questionId)
        if (q) q.status = 'answered'
        resolve((q?.questions || []).map(() => []))
      }
    }, 10 * 60 * 1000)
  })
}

export function answerQuestion(questionId: string, answers: string[][]): boolean {
  const q = pendingQuestions.get(questionId)
  if (!q || q.status !== 'pending') return false
  q.status = 'answered'
  q.answers = answers
  const cb = waitingCallbacks.get(questionId)
  if (cb) {
    waitingCallbacks.delete(questionId)
    cb.resolve(answers)
  }
  return true
}

export function getPendingQuestion(questionId: string): PendingQuestion | undefined {
  return pendingQuestions.get(questionId)
}

export function getPendingQuestions(): PendingQuestion[] {
  return Array.from(pendingQuestions.values()).filter(q => q.status === 'pending')
}

export function cleanupQuestions(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  for (const [id, q] of pendingQuestions.entries()) {
    if (q.createdAt < oneHourAgo) {
      pendingQuestions.delete(id)
      waitingCallbacks.delete(id)
    }
  }
}
