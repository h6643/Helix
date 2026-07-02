/**
 * API authentication for Agent endpoints.
 * Validates API token from environment variable.
 */

export function validateApiToken(req: Request): boolean {
  const token = process.env.HELIX_API_TOKEN
  if (!token) return true // No token configured = skip validation (dev mode)
  
  const authHeader = req.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) return false
  
  const providedToken = authHeader.slice(7)
  return providedToken === token
}