import { createHash } from 'node:crypto'
import { notify } from './notify.js'
import { streamOpenRouter, streamOpenAI, streamAnthropic, streamGoogle } from './providers.js'

const BATCH_MS = 800
const BATCH_BYTES = 3400
const MAX_RUN_MS = 12 * 60 * 1000
// How long a finished run stays resumable
const KEEP_MS = 90 * 60 * 1000

const runs = new Map()

// Stops for rids we haven't seen, so a begin still in flight on another socket can't start them.
// Any socket can send these for free, so they're capped (oldest dropped first) instead of kept like runs
const MAX_TOMBS = 10_000
const tombs = new Map()

// Run ids are the client's reply ids: 128 random bits as unpadded base64url.
// Knowing one is what lets you resume or stop a run, so only that unguessable form is accepted.
const RID = /^[\w-]{22}$/

const newRun = (rid, phase) => ({
  rid,
  phase,
  seq: -1,
  deltas: [],
  sockets: new Set(),
  pending: '',
  pendingImages: [],
  flushTimer: null,
  timeoutTimer: null,
  controller: null,
  startedAt: Date.now(),
  endedAt: phase === 'done' ? Date.now() : 0,
  provider: null,
  model: null,
  settings: '',
})

// Non-empty generation settings for ntfy; prompts and model are skipped,
// as is Sune's default of hiding thoughts (reasoning.exclude=true)
const NOT_SETTINGS = new Set(['messages', 'model', 'stream'])

function settingsOf(o, pre = '') {
  return Object.entries(o || {}).flatMap(([k, v]) => {
    const key = pre + k
    if (NOT_SETTINGS.has(key) || (key === 'reasoning.exclude' && v === true)) return []
    if (v == null || v === '' || (typeof v === 'object' && !Object.keys(v).length)) return []
    if (typeof v === 'object' && !Array.isArray(v)) return settingsOf(v, `${key}.`)
    return [`- ${key}: \`${String(v).slice(0, 80)}\``]
  })
}

function report(r, head, tags, extra) {
  // A short hash, never the id: the id would let anyone reading the topic fetch the reply
  const title = `**${head}** · \`${r.provider || '?'}/${r.model || '?'}\` · run \`${createHash('sha256').update(r.rid).digest('hex').slice(0, 8)}\``
  notify([title, extra, r.settings].filter(Boolean).join('\n\n'), 2, tags)
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)) } catch {}
}

function bcast(r, obj) {
  for (const ws of r.sockets) send(ws, obj)
}

// Deltas are numbered from 0, so a delta's seq is also its index in r.deltas
function flush(r) {
  clearTimeout(r.flushTimer)
  r.flushTimer = null
  if (!r.pending && !r.pendingImages.length) return
  const d = { type: 'delta', seq: ++r.seq, text: r.pending }
  if (r.pendingImages.length) d.images = r.pendingImages
  r.deltas.push(d)
  r.pending = ''
  r.pendingImages = []
  bcast(r, d)
}

function queueDelta(r, text, images) {
  if (!text && !images?.length) return
  if (text) r.pending += text
  if (images) r.pendingImages.push(...images)
  if (r.pending.length >= BATCH_BYTES || r.pendingImages.length) flush(r)
  else r.flushTimer ??= setTimeout(() => flush(r), BATCH_MS)
}

function end(r, head, tags, extra) {
  if (r.phase !== 'running') return
  clearTimeout(r.timeoutTimer)
  flush(r)
  r.phase = 'done'
  r.endedAt = Date.now()
  try { r.controller.abort() } catch {}
  bcast(r, { type: 'done' })
  report(r, `${head} ${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s`, tags, extra)
}

const finish = r => end(r, 'Finished in', ['white_check_mark'])
const stop = r => end(r, 'Stopped after', ['stop_sign'])

function fail(r, message) {
  if (r.phase !== 'running') return
  const err = String(message || 'stream_failed')
  queueDelta(r, `\n\nRun failed: ${err}`)
  end(r, 'Failed after', ['rotating_light'], `\`\`\`\n${err}\n\`\`\``)
}

// Replays what the socket missed, then keeps it subscribed while the run is live
function attach(r, ws, after) {
  for (const d of r.deltas.slice(after + 1)) send(ws, d)
  if (r.phase === 'done') return send(ws, { type: 'done' })
  ws.data.run?.sockets.delete(ws)
  r.sockets.add(ws)
  ws.data.run = r
}

function sanitizeMessages(messages) {
  return messages.map(m => {
    let content = m.content
    if (typeof content === 'string') {
      if (!content.trim()) content = '.'
    } else if (Array.isArray(content)) {
      content = content.filter(p => p.type !== 'text' || (p.text && p.text.trim().length > 0))
      if (content.length === 0 || !content.some(p => p.type === 'text')) {
        content.push({ type: 'text', text: '.' })
      }
    }
    return { ...m, content }
  })
}

async function beginStream(r, apiKey, body) {
  const providerFn = { openai: streamOpenAI, google: streamGoogle, anthropic: streamAnthropic }[r.provider] || streamOpenRouter
  try {
    await providerFn({
      apiKey,
      body,
      signal: r.controller.signal,
      onDelta: (text, images) => queueDelta(r, text, images),
      isRunning: () => r.phase === 'running',
    })
    finish(r)
  } catch (e) {
    fail(r, e?.message)
  }
}

// Forget finished runs once they're no longer resumable
setInterval(() => {
  const now = Date.now()
  for (const [rid, r] of runs) if (r.phase === 'done' && now - r.endedAt > KEEP_MS) runs.delete(rid)
  for (const [rid, t] of tombs) { if (now - t <= KEEP_MS) break; tombs.delete(rid) }
}, 60_000)

function tomb(rid) {
  tombs.set(rid, Date.now())
  if (tombs.size > MAX_TOMBS) tombs.delete(tombs.keys().next().value)
}

export function removeSocket(ws) {
  ws.data.run?.sockets.delete(ws)
}

export function handleMessage(ws, msg) {
  if (msg.type === 'ping') return send(ws, { type: 'pong' })
  const { rid } = msg
  if (typeof rid !== 'string' || !RID.test(rid)) return send(ws, { type: 'err', message: 'bad_rid' })
  // A tombstoned rid acts as an already finished run
  let r = runs.get(rid) || (tombs.has(rid) ? newRun(rid, 'done') : null)
  const after = Number.isInteger(msg.after) ? msg.after : -1

  switch (msg.type) {
    case 'stop': return r ? stop(r) : tomb(rid)
    case 'resume': return r ? attach(r, ws, after) : send(ws, { type: 'gone' })
    case 'begin': break
    default: return send(ws, { type: 'err', message: 'bad_type' })
  }

  // A repeated begin (the client lost its socket before the ack) just resumes
  if (r) {
    send(ws, { type: 'ack' })
    return attach(r, ws, after)
  }

  const { apiKey, body, provider = 'openrouter' } = msg
  if (!apiKey || !Array.isArray(body?.messages) || !body.messages.length) {
    return send(ws, { type: 'err', message: 'missing_fields' })
  }
  body.messages = sanitizeMessages(body.messages)

  r = newRun(rid, 'running')
  r.provider = provider
  r.model = body.model || null
  r.settings = settingsOf(body).join('\n')
  r.controller = new AbortController()
  r.timeoutTimer = setTimeout(() => fail(r, `Run timed out after ${MAX_RUN_MS / 60000} minutes.`), MAX_RUN_MS)
  runs.set(rid, r)

  send(ws, { type: 'ack' })
  attach(r, ws, -1)
  beginStream(r, apiKey, body)
}
