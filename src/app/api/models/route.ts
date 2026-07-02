/**
 * API proxy route for fetching available models
 * This avoids CORS issues when fetching models from external APIs
 */

import { NextRequest } from 'next/server'
import { validateApiToken } from '@/lib/agent/auth'

export async function POST(req: NextRequest) {
  // Authentication check
  if (!validateApiToken(req)) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const { baseUrl, apiKey } = await req.json()

    if (!baseUrl || !apiKey) {
      return new Response(JSON.stringify({ error: 'baseUrl and apiKey are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/models`
    
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    })

    if (!response.ok) {
      const errorText = await response.text()
      return new Response(JSON.stringify({ 
        error: `API request failed (${response.status}): ${errorText.slice(0, 200)}` 
      }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const data = await response.json()
    
    // Support different API response formats
    let models: string[] = []
    if (Array.isArray(data)) {
      models = data.map((m: any) => m.id || m.name || String(m))
    } else if (data.data && Array.isArray(data.data)) {
      models = data.data.map((m: any) => m.id || m.name || String(m))
    } else if (data.models && Array.isArray(data.models)) {
      models = data.models.map((m: any) => m.id || m.name || String(m))
    }

    const sortedModels = models.filter(Boolean).sort()

    return new Response(JSON.stringify({ models: sortedModels }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    console.error('Models API error:', error)
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Server error' 
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}