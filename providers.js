import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'
import { GoogleGenAI } from '@google/genai'

function extractText(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content.filter(p => p && ['text', 'input_text', 'output_text'].includes(p.type)).map(p => p.text ?? p.content ?? '').join('')
}

function isMultimodal(m) {
  return m && Array.isArray(m.content) && m.content.some(p => p?.type && !['text', 'input_text', 'output_text'].includes(p.type))
}

function mapPartToResponses(part, role) {
  const type = part?.type || 'text'
  if (['image_url', 'input_image'].includes(type)) {
    const url = part?.image_url?.url || part?.image_url
    return url ? { type: 'input_image', image_url: String(url) } : null
  }
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (['text', 'input_text', 'output_text'].includes(type)) return { type: textType, text: String(part.text ?? part.content ?? '') }
  return { type: textType, text: `[${type}:${part?.file?.filename || 'file'}]` }
}

function buildInputForResponses(messages) {
  if (!Array.isArray(messages) || !messages.length) return ''
  if (!messages.some(isMultimodal)) {
    if (messages.length === 1) return extractText(messages[0])
    return messages.map(m => ({ role: m.role, content: extractText(m) }))
  }
  return messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.map(p => mapPartToResponses(p, m.role)).filter(Boolean)
      : [{ type: m.role === 'assistant' ? 'output_text' : 'input_text', text: String(m.content || '') }],
  }))
}

/* ---------- Google helpers ---------- */

const THINKING_LEVELS = { none: 'minimal', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high' }

const EXT_MIME = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', bmp: 'image/bmp',
  mp3: 'audio/mp3', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  txt: 'text/plain', md: 'text/md', csv: 'text/csv', xml: 'text/xml', rtf: 'text/rtf',
}

const mimeFromName = n => EXT_MIME[String(n || '').split('.').pop().toLowerCase()] || 'text/plain'

const inlineFromDataUrl = u => {
  const m = String(u || '').match(/^data:([^;,]+);base64,(.*)$/s)
  return m ? { inlineData: { mimeType: m[1], data: m[2] } } : null
}

function mapPartToGoogle(p) {
  if (!p) return null
  if (typeof p === 'string') return p.trim() ? { text: p } : null
  switch (p.type) {
    case 'text':
      return p.text?.trim() ? { text: p.text } : null
    case 'image_url':
      return inlineFromDataUrl(p.image_url?.url || p.image_url)
    case 'input_audio':
      return p.input_audio?.data
        ? { inlineData: { mimeType: p.input_audio.format === 'mp3' ? 'audio/mp3' : 'audio/wav', data: p.input_audio.data } }
        : null
    case 'file': {
      const d = p.file?.file_data
      if (!d) return null
      return d.startsWith('data:') ? inlineFromDataUrl(d) : { inlineData: { mimeType: mimeFromName(p.file.filename), data: d } }
    }
    default:
      return null
  }
}

const isBlankTurn = c => c.parts.every(p => 'text' in p) && ['', '.'].includes(c.parts.map(p => p.text).join('').trim())

function mapToGoogleContents(messages) {
  const contents = []
  for (const m of messages) {
    if (!m || m.role === 'system') continue
    const role = m.role === 'assistant' ? 'model' : 'user'
    const src = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]
    const parts = src.map(mapPartToGoogle).filter(Boolean)
    for (const img of m.images || []) {
      const ip = inlineFromDataUrl(img?.image_url?.url || img?.image_url)
      if (ip) parts.push(ip)
    }
    if (!parts.length) continue
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  while (contents.length && contents.at(-1).role === 'model' && isBlankTurn(contents.at(-1))) contents.pop()
  return contents
}

function toGoogleSchema(s) {
  if (typeof s !== 'object' || s === null) return s
  const n = Array.isArray(s) ? [] : {}
  for (const k in s) if (Object.hasOwn(s, k)) n[k] = (k === 'type' && typeof s[k] === 'string') ? s[k].toUpperCase() : toGoogleSchema(s[k])
  return n
}

function collectSources(candidate, sources) {
  for (const c of candidate?.groundingMetadata?.groundingChunks || []) {
    const uri = c?.web?.uri
    if (uri) sources.add(uri)
  }
  for (const u of candidate?.urlContextMetadata?.urlMetadata || []) {
    const uri = u?.retrievedUrl
    if (uri && (!u.urlRetrievalStatus || u.urlRetrievalStatus === 'URL_RETRIEVAL_STATUS_SUCCESS')) sources.add(uri)
  }
}

/* ---------- Providers ---------- */

export async function streamOpenRouter({ apiKey, body, signal, onDelta, isRunning }) {
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://sune.chat',
      'X-Title': 'Sune',
    },
    body: JSON.stringify(body),
    signal,
  })
  if (!resp.ok) throw new Error(`OpenRouter API error: ${resp.status} ${await resp.text()}`)

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = '', hasReasoning = false, hasContent = false

  while (isRunning()) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.substring(6).trim()
      if (data === '[DONE]') return
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta
        if (!delta) continue
        if (delta.reasoning && body.reasoning?.exclude !== true) {
          onDelta(delta.reasoning)
          hasReasoning = true
        }
        if (delta.content) {
          if (hasReasoning && !hasContent) onDelta('\n')
          onDelta(delta.content)
          hasContent = true
        }
        if (delta.images) onDelta('', delta.images)
      } catch {}
    }
  }
}

export async function streamOpenAI({ apiKey, body, signal, onDelta, isRunning }) {
  const client = new OpenAI({ apiKey })
  const online = (body.model ?? '').endsWith(':online')
  const model = online ? body.model.slice(0, -7) : body.model

  const params = {
    model,
    input: buildInputForResponses(body.messages || []),
    temperature: body.temperature,
    stream: true,
  }
  if (Number.isFinite(+body.max_tokens) && +body.max_tokens > 0) params.max_output_tokens = +body.max_tokens
  if (Number.isFinite(+body.top_p)) params.top_p = +body.top_p
  if (body.reasoning?.effort) params.reasoning = { effort: body.reasoning.effort }
  if (body.verbosity) params.text = { verbosity: body.verbosity }

  if (online) {
    params.tools = [
      ...(params.tools || []),
      { type: 'web_search', external_web_access: true },
    ]
  }

  const stream = await client.responses.stream(params)
  try {
    for await (const event of stream) {
      if (!isRunning()) break
      if (event.type.endsWith('.delta') && event.delta) onDelta(event.delta)
    }
  } finally {
    try { stream.controller?.abort() } catch {}
  }
}

export async function streamClaude({ apiKey, body, signal, onDelta, isRunning }) {
  const client = new Anthropic({ apiKey })
  const online = (body.model ?? '').endsWith(':online')
  const model = online ? body.model.slice(0, -7) : body.model
  const CLAUDE_MAX_TOKENS = 128000

  const system = body.messages
    .filter(m => m.role === 'system')
    .map(extractText)
    .join('\n\n') || body.system
  const payload = {
    model,
    messages: body.messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : (m.content || []).map(p => {
        if (p.type === 'text' && p.text) return { type: 'text', text: p.text }
        if (p.type === 'image_url') {
          const match = String(p.image_url?.url || p.image_url || '').match(/^data:(image\/\w+);base64,(.*)$/)
          if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
        }
        if (p.type === 'document' && p.source) return p
        if (p.type === 'file' && p.file?.file_data) {
          return {
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: p.file.file_data,
            },
          }
        }
        return null
      }).filter(Boolean),
    })).filter(m => m.content.length),
    max_tokens: CLAUDE_MAX_TOKENS,
  }
  if (system) payload.system = system
  if (Number.isFinite(+body.temperature)) payload.temperature = +body.temperature
  if (Number.isFinite(+body.top_p)) payload.top_p = +body.top_p

  const effort = body.reasoning?.effort
  if (effort === 'none') {
    payload.thinking = { type: 'disabled' }
  } else if (effort && effort !== 'default') {
    payload.thinking = { type: 'adaptive' }
    payload.output_config = { effort }
  }

  if (online) {
    payload.tools = [
      ...(payload.tools || []),
      { type: 'web_search_20260318', name: 'web_search', allowed_callers: ['direct'] },
    ]
  }

  const includeThoughts = body.reasoning?.exclude !== true
  let hasThinking = false, hasContent = false

  const stream = client.messages.stream(payload)
  try {
    for await (const event of stream) {
      if (!isRunning()) break
      if (event.type !== 'content_block_delta') continue
      const delta = event.delta
      if (delta.type === 'thinking_delta' && includeThoughts) {
        onDelta(delta.thinking)
        hasThinking = true
      } else if (delta.type === 'text_delta') {
        if (hasThinking && !hasContent) onDelta('\n')
        onDelta(delta.text)
        hasContent = true
      }
    }
  } finally {
    try { stream.controller?.abort() } catch {}
  }
}

export async function streamGoogle({ apiKey, body, signal, onDelta, isRunning }) {
  const ai = new GoogleGenAI({ apiKey })
  const raw = body.model ?? ''
  const online = raw.endsWith(':online')
  const model = (online ? raw.slice(0, -7) : raw).replace(/^models\//, '')

  const config = {
    abortSignal: signal,
    maxOutputTokens: Number.isFinite(+body.max_tokens) && +body.max_tokens > 0 ? +body.max_tokens : 65536,
  }
  if (Number.isFinite(+body.temperature)) config.temperature = +body.temperature
  if (Number.isFinite(+body.top_p)) config.topP = +body.top_p

  const systemInstruction = body.messages.filter(m => m.role === 'system').map(extractText).filter(Boolean).join('\n\n')
  if (systemInstruction) config.systemInstruction = systemInstruction

  const includeThoughts = body.reasoning?.exclude !== true
  if (body.reasoning) {
    const level = THINKING_LEVELS[String(body.reasoning.effort || '').toLowerCase()]
    config.thinkingConfig = { includeThoughts, ...(level && { thinkingLevel: level }) }
  }

  if (online) config.tools = [{ googleSearch: {} }, { urlContext: {} }]

  if (body.modalities?.includes('image')) {
    config.responseModalities = ['TEXT', 'IMAGE']
    config.imageConfig = {
      aspectRatio: body.image_config?.aspect_ratio || '1:1',
      imageSize: body.image_config?.image_size || '1K',
    }
  }

  if (body.response_format?.type?.startsWith('json')) {
    config.responseMimeType = 'application/json'
    const schema = body.response_format.json_schema
    if (schema) config.responseSchema = toGoogleSchema(schema.schema || schema)
  }

  const contents = mapToGoogleContents(body.messages)
  if (!contents.length) throw new Error('Google API error: no usable content')

  const sources = new Set()
  let hasReasoning = false, hasContent = false

  const stream = await ai.models.generateContentStream({ model, contents, config })

  for await (const chunk of stream) {
    if (!isRunning()) return
    const candidate = chunk.candidates?.[0]
    collectSources(candidate, sources)
    for (const part of candidate?.content?.parts || []) {
      const inline = part.inlineData
      if (inline?.data && String(inline.mimeType || '').startsWith('image/')) {
        onDelta('', [{ image_url: { url: `data:${inline.mimeType};base64,${inline.data}` } }])
        continue
      }
      if (!part.text) continue
      if (part.thought) {
        if (!includeThoughts) continue
        onDelta(part.text)
        hasReasoning = true
      } else {
        if (hasReasoning && !hasContent) onDelta('\n')
        onDelta(part.text)
        hasContent = true
      }
    }
  }

  if (sources.size && isRunning()) {
    const list = [...sources].map((uri, i) => `${i + 1}. [${uri}](${uri})`).join('\n')
    onDelta(`\n\n---\n\n**Sources**\n\n${list}\n`)
  }
}
