/**
 * Pure Hermes config.yaml helpers — string manipulation only, no I/O.
 * Extracted from main.js. Every function returns a new YAML string (or a
 * derived value); callers own reading/writing config.yaml.
 */

// Lightweight YAML helper — sets a nested key (up to 2 levels, 2-space indent)
// without a js-yaml dependency. Preserves the rest of the file. Returns the new
// YAML string (unchanged if the value was already identical).
function setYamlKey(yaml, dottedKey, value) {
  const parts = dottedKey.split('.')
  if (parts.length !== 2) return yaml
  const [top, sub] = parts
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  const valueStr = typeof value === 'boolean' ? (value ? 'true' : 'false') : String(value)
  let topIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].startsWith(top + ':')) { topIdx = i; break }
  }
  if (topIdx === -1) {
    lines.push(`${top}:`)
    lines.push(`  ${sub}: ${valueStr}`)
    return lines.join('\n')
  }
  let subIdx = -1
  for (let i = topIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    if (new RegExp(`^\\s+${sub}:`).test(lines[i])) { subIdx = i; break }
  }
  if (subIdx !== -1) {
    const oldVal = lines[subIdx]
    lines[subIdx] = lines[subIdx].replace(new RegExp(`^(\\s+${sub}:\\s*).*$`), `$1${valueStr}`)
    if (sub === 'provider') {
      console.log('[setYamlKey] provider: old=' + JSON.stringify(oldVal) + ' new=' + JSON.stringify(lines[subIdx]))
      console.trace('[setYamlKey] provider write stack')
    }
    // Remove any duplicate `sub:` lines within the same parent block so a
    // previously-inserted/stray key can't survive and shadow the value.
    for (let i = subIdx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break
      if (new RegExp(`^\\s+${sub}:`).test(lines[i])) { lines.splice(i, 1); i-- }
    }
  } else {
    lines.splice(topIdx + 1, 0, `  ${sub}: ${valueStr}`)
  }
  return lines.join('\n')
}

// Update the `model:` field of a named custom_providers entry so Hermes
// actually uses the model the user picked. A named custom provider
// OVERRIDES model.default (see hermes runtime_provider.resolve_runtime_provider),
// so without this the UI model selection would never take effect.
function setCustomProviderModel(yaml, providerName, model) {
  if (!providerName || !model) return yaml
  const name = String(providerName).trim()
  const modelStr = String(model).trim()
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let inProviders = false
  let entryActive = false
  for (let i = 0; i < lines.length; i++) {
    const lp = lines[i]
    if (/^custom_providers:/.test(lp)) { inProviders = true; continue }
    if (!inProviders) continue
    if (/^\S/.test(lp) && !lp.startsWith(' ') && !lp.startsWith('-')) { inProviders = false; entryActive = false; continue }
    const mName = lp.match(/^\s*-\s+name:\s*(.+?)\s*$/)
    if (mName) { entryActive = (mName[1] === name); continue }
    if (entryActive) {
      const mModel = lp.match(/^(\s+)model:\s*(.+?)\s*$/)
      if (mModel) {
        lines[i] = mModel[1] + 'model: ' + modelStr
        return lines.join('\n')
      }
    }
  }
  return yaml
}

function setCustomProviderField(yaml, name, field, value) {
  if (!name || !field || value === undefined || value === null) return yaml
  const n = String(name).trim()
  const v = String(value).trim()
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let inProviders = false, entryActive = false, entryEnd = -1, entryFound = false
  for (let i = 0; i < lines.length; i++) {
    const lp = lines[i]
    if (/^custom_providers:/.test(lp)) { inProviders = true; continue }
    if (!inProviders) continue
    if (/^\S/.test(lp) && !lp.startsWith(' ') && !lp.startsWith('-')) { inProviders = false; entryActive = false; continue }
    const mName = lp.match(/^\s*-\s+name:\s*(.+?)\s*$/)
    if (mName) {
      entryActive = (mName[1] === n)
      if (entryActive) { entryFound = true; entryEnd = i }
      continue
    }
    if (entryActive) {
      const mF = lp.match(new RegExp('^(\\s+)' + field + ':\\s*(.+?)\\s*$'))
      if (mF) { lines[i] = mF[1] + field + ': ' + v; return lines.join('\n') }
      entryEnd = i
    }
  }
  if (!entryFound) {
    // Auto-create a new custom_providers entry for any provider name
    const defaultBaseUrl = 'https://api.openai.com/v1'
    const defaultModel = 'gpt-4o'
    const fld = (field === 'base_url') ? v : defaultBaseUrl
    const mdl = (field === 'model') ? v : defaultModel
    const entryLines = [
      '  - name: ' + n,
      '    base_url: ' + fld,
      '    api_key_env: OPENAI_API_KEY',
      '    model: ' + mdl,
    ]
    if (/^custom_providers:/m.test(yaml)) {
      const yl = yaml.replace(/\r\n/g, '\n').split('\n')
      let inProv = false, lastIdx = -1
      for (let i = 0; i < yl.length; i++) {
        if (/^custom_providers:/.test(yl[i])) { inProv = true; continue }
        if (inProv) {
          if (/^\S/.test(yl[i]) && !yl[i].startsWith(' ') && !yl[i].startsWith('-')) { inProv = false; continue }
          lastIdx = i
        }
      }
      if (lastIdx >= 0) {
        yl.splice(lastIdx + 1, 0, ...entryLines)
        return yl.join('\n')
      }
      return yaml.replace(/\r\n/g, '\n') + '\n' + entryLines.join('\n') + '\n'
    }
    const block = [
      'custom_providers:',
      ...entryLines,
      '',
    ].join('\n')
    return block + yaml
  }
  // Entry exists but lacks the field - append it at entry end
  lines.splice(entryEnd + 1, 0, '    ' + field + ': ' + v)
  return lines.join('\n')
}

// Resolve a valid named custom provider for model writes. Hermes uses a named
// custom provider's own `model:` field and OVERRIDES model.default, so the UI
// model selection must be written there. 'custom'/empty/invalid falls back to
// the named provider whose base_url matches the configured model.base_url.
const KNOWN_BASE_PROVIDERS = ['openai','anthropic','openrouter','agnes-ai','nous','moa','ollama','vllm','llamacpp','zai','kimi-coding','kimi-coding-cn','minimax','minimax-cn','bedrock','gemini','deepseek','qwen','grok','xai','antling']
function customProviderApiKey(yaml, name) {
  if (!name) return ''
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let entryActive = false
  for (const lp of lines) {
    const mName = lp.match(/^\s*-\s+name:\s*(.+?)\s*$/)
    if (mName) { entryActive = (mName[1] === name); continue }
    if (entryActive) {
      const mK = lp.match(/^\s+api_key:\s*(.+?)\s*$/)
      if (mK) return mK[1].trim()
    }
  }
  return ''
}
function customProviderBaseUrl(yaml, name) {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let entryActive = false
  for (const lp of lines) {
    const mName = lp.match(/^\s*-\s+name:\s*(.+?)\s*$/)
    if (mName) { entryActive = (mName[1] === name); continue }
    if (entryActive) {
      const mB = lp.match(/^\s+base_url:\s*(.+?)\s*$/)
      if (mB) return mB[1].trim().replace(/\/+$/, '')
    }
  }
  return ''
}
function providerNameFromUrl(baseUrl) {
  if (!baseUrl) return null
  try {
    const hostname = new URL(baseUrl).hostname
    // Strip common prefixes: api., apihub., gateway.
    return hostname.replace(/^(api|apihub|gateway)\./, '').split('.')[0]
  } catch { return null }
}
function resolveProvider(yaml, requestedProvider, newBaseUrl) {
  const customNames = [...yaml.matchAll(/^\s*-\s+name:\s*(.+?)\s*$/gm)].map(m => m[1])
  const validNamed = (p) => p && customNames.includes(p)
  const validBase = (p) => p && KNOWN_BASE_PROVIDERS.includes(p)
  // If a new baseUrl is provided, find a custom provider entry that matches it.
  // This takes priority over the requested name to avoid reusing a stale provider.
  if (newBaseUrl) {
    const normNew = newBaseUrl.replace(/\/+$/, '')
    for (const n of customNames) {
      if (customProviderBaseUrl(yaml, n).replace(/\/+$/, '') === normNew) return n
    }
    // No matching entry — derive a new name from the hostname
    const derived = providerNameFromUrl(newBaseUrl)
    if (derived) return derived
  }
  if (validNamed(requestedProvider)) return requestedProvider
  if (validBase(requestedProvider)) return requestedProvider
  if (customNames.length) {
    return customNames[0]
  }
  return 'custom'
}

// Custom provider names that collider with Hermes BUILT-IN provider names
// (registered in hermes_cli.auth.PROVIDER_REGISTRY). When a custom_providers
// entry reuses one of these names, config.yaml model.provider MUST be written as
// 'custom:<name>' (NOT the bare name): otherwise Hermes routes to the built-in
// resolver, which reads a provider-specific env var (e.g. DEEPSEEK_API_KEY) and
// IGNORES the custom entry's api_key/base_url — producing
// "No LLM provider configured" / "Set <PROVIDER>_API_KEY". This is the same
// collision class already documented for stepfun. Keep this list in sync with the
// keys of BUILTIN_PROVIDER_ENV.
function disambiguateCustomProvider(yaml, name) {
  if (!name) return name
  const colliding = Object.keys(BUILTIN_PROVIDER_ENV)
  const customNames = [...yaml.matchAll(/^\s*-\s+name:\s*(.+?)\s*$/gm)].map(m => m[1])
  if (customNames.includes(name) && colliding.includes(name)) {
    return 'custom:' + name
  }
  return name
}

// Hermes built-in providers (registered in hermes_cli.auth.PROVIDER_REGISTRY)
// that read their API key from a provider-specific env var instead of
// OPENAI_API_KEY / custom_providers[].api_key. When model.provider matches one
// of these names, the custom_providers entry is IGNORED by the resolver, so we
// MUST also mirror the key into the env var the built-in expects — otherwise
// the gateway starts with "No LLM provider configured" / "Set <PROVIDER>_API_KEY".
// Keep this table in sync with the provider names in PROVIDER_REGISTRY.
const BUILTIN_PROVIDER_ENV = {
  stepfun: 'STEPFUN_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  // add more built-in providers here as needed (e.g. glm, minimax, ...)
}

// Parse the `agent:` block of config.yaml into a flat map (personality fields).
function parseHermesPersonalities(yaml) {
  const lines = yaml.split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^agent:/.test(lines[i])) { start = i; break }
  }
  if (start === -1) return {}
  const out = {}
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !lines[i].startsWith(' ')) break
    const m = lines[i].match(/^\s{4}([A-Za-z0-9_\u4e00-\u9fff]+):\s?(.*)$/)
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
  }
  return out
}

// Write `delegation.identities` as a JSON-on-one-line YAML flow value, e.g.
// `  identities: [{"name":"researcher","system_prompt":"..."}]`. Stored as a
// single scalar line so: (a) Hermes' YAML loader parses the flow syntax into a
// real list, and (b) the existing flat-scalar getConfig reader returns it as a
// string the UI can JSON.parse. The value line is built directly (not via a
// regex-replace of the old value) so `$`, quotes, or backslashes inside a
// persona can't corrupt the write. `identities` is a list of {name, system_prompt}.
function setDelegationIdentities(yaml, identities) {
  const valueStr = JSON.stringify(Array.isArray(identities) ? identities : [])
  const line = `  identities: ${valueStr}`
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  let topIdx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && lines[i].startsWith('delegation:')) { topIdx = i; break }
  }
  if (topIdx === -1) {
    lines.push('delegation:')
    lines.push(line)
    return lines.join('\n')
  }
  // Find the delegation block's extent and drop any existing `identities:` lines
  // (reverse iteration keeps indices valid) so there's a single canonical line.
  let blockEnd = topIdx
  for (let i = topIdx + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i])) break
    blockEnd = i
  }
  for (let i = blockEnd; i > topIdx; i--) {
    if (/^\s+identities:/.test(lines[i])) lines.splice(i, 1)
  }
  // Insert right after the `delegation:` header (topIdx is unchanged since we
  // only removed lines after it).
  lines.splice(topIdx + 1, 0, line)
  return lines.join('\n')
}

module.exports = {
  setYamlKey,
  setDelegationIdentities,
  setCustomProviderModel,
  setCustomProviderField,
  customProviderApiKey,
  resolveProvider,
  disambiguateCustomProvider,
  parseHermesPersonalities,
  BUILTIN_PROVIDER_ENV,
}
