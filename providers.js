import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

function extractText(m) {
  if (!m) return ''
  if (typeof m.content === 'string') return m.content
  if (!Array.isArray(m.content)) return ''
  return m.content.filter(p => p && ['text', 'input_text'].includes(p.type)).map(p => p.text ?? p.content ?? '').join('')
}

function isMultimodal(m) {
  return m && Array.isArray(m.content) && m.content.some(p => p?.type && p.type !== 'text' && p.type !== 'input_text')
}

function mapPartToResponses(part) {
  const type = part?.type || 'text'
  if (['image_url', 'input_image'].includes(type)) {
    const url = part?.image_url?.url || part?.image_url
    return url ? { type: 'input_image', image_url: String(url) } : null
  }
  if (['text', 'input_text'].includes(type)) return { type: 'input_text', text: String(part.text ?? part.content ?? '') }
  return { type: 'input_text', text: `[${type}:${part?.file?.filename || 'file'}]` }
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
      ? m.content.map(mapPartToResponses).filter(Boolean)
      : [{ type: 'input_text', text: String(m.content || '') }],
  }))
}

function mapToGoogleContents(messages) {
  const contents = messages.reduce((acc, m) => {
    const role = m.role === 'assistant' ? 'model' : 'user'
    const msgContent = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }]
    const parts = msgContent.map(p => {
      if (p.type === 'text') return { text: p.text || '' }
      if (p.type === 'image_url' && p.image_url?.url) {
        const match = p.image_url.url.match(/^data:(image\/\w+);base64,(.*)$/)
        if (match) return { inline_data: { mime_type: match[1], data: match[2] } }
      }
      return null
    }).filter(Boolean)
    if (!parts.length) return acc
    if (acc.length > 0 && acc.at(-1).role === role) acc.at(-1).parts.push(...parts)
    else acc.push({ role, parts })
    return acc
  }, [])
  if (contents.at(-1)?.role !== 'user') contents.pop()
  return contents
}

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
  const params = {
    model: body.model,
    input: buildInputForResponses(body.messages || []),
    temperature: body.temperature,
    stream: true,
  }
  if (Number.isFinite(+body.max_tokens) && +body.max_tokens > 0) params.max_output_tokens = +body.max_tokens
  if (Number.isFinite(+body.top_p)) params.top_p = +body.top_p
  if (body.reasoning?.effort) params.reasoning = { effort: body.reasoning.effort }
  if (body.verbosity) params.text = { verbosity: body.verbosity }

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
  const system = body.messages
    .filter(m => m.role === 'system')
    .map(extractText)
    .join('\n\n') || body.system
  const payload = {
    model: body.model,
    messages: body.messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : (m.content || []).map(p => {
        if (p.type === 'text' && p.text) return { type: 'text', text: p.text }
        if (p.type === 'image_url') {
          const match = String(p.image_url?.url || p.image_url || '').match(/^data:(image\/\w+);base64,(.*)$/)
          if (match) return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } }
        }
        return null
      }).filter(Boolean),
    })).filter(m => m.content.length),
    max_tokens: body.max_tokens || 64000,
  }
  if (system) payload.system = system
  if (Number.isFinite(+body.temperature)) payload.temperature = +body.temperature
  if (Number.isFinite(+body.top_p)) payload.top_p = +body.top_p
  if (body.reasoning?.enabled) {
    payload.extended_thinking = {
      enabled: true,
      ...(body.reasoning.budget && { max_thinking_tokens: body.reasoning.budget }),
    }
  }

  const stream = client.messages.stream(payload)
  stream.on('text', text => { if (isRunning()) onDelta(text) })
  await stream.finalMessage()
}

export async function streamGoogle({ apiKey, body, signal, onDelta, isRunning }) {
  const generationConfig = Object.entries({
    temperature: body.temperature,
    topP: body.top_p,
    maxOutputTokens: body.max_tokens,
  }).reduce((acc, [k, v]) => (Number.isFinite(+v) && +v >= 0 ? { ...acc, [k]: +v } : acc), {})

  if (body.reasoning) {
    generationConfig.thinkingConfig = {
      includeThoughts: body.reasoning.exclude !== true,
      ...(body.reasoning.effort && body.reasoning.effort !== 'default' && { thinkingLevel: body.reasoning.effort }),
    }
  }
  if (body.response_format?.type?.startsWith('json')) {
    generationConfig.responseMimeType = 'application/json'
    if (body.response_format.json_schema) {
      const translate = s => {
        if (typeof s !== 'object' || s === null) return s
        const n = Array.isArray(s) ? [] : {}
        for (const k in s) if (Object.hasOwn(s, k)) n[k] = (k === 'type' && typeof s[k] === 'string') ? s[k].toUpperCase() : translate(s[k])
        return n
      }
      generationConfig.responseSchema = translate(body.response_format.json_schema.schema || body.response_format.json_schema)
    }
  }

  const model = (body.model ?? '').replace(/:online$/, '')
  const payload = {
    contents: mapToGoogleContents(body.messages),
    ...(Object.keys(generationConfig).length && { generationConfig }),
    ...((body.model ?? '').endsWith(':online') && { tools: [{ google_search: {} }] }),
  }

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(payload),
      signal,
    }
  )
  if (!resp.ok) throw new Error(`Google API error: ${resp.status} ${await resp.text()}`)

  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = '', hasReasoning = false, hasContent = false

  while (isRunning()) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data: ')) continue
      try {
        JSON.parse(line.substring(6))?.candidates?.[0]?.content?.parts?.forEach(p => {
          if (p.thought?.thought) {
            onDelta(p.thought.thought)
            hasReasoning = true
          }
          if (p.text) {
            if (hasReasoning && !hasContent) onDelta('\n')
            onDelta(p.text)
            hasContent = true
          }
        })
      } catch {}
    }
    buf = buf.slice(buf.lastIndexOf('\n') + 1)
  }
}
