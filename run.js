import * as kv from './db.js'
import { notify } from './notify.js'
import { streamOpenRouter, streamOpenAI, streamClaude, streamGoogle } from './providers.js'

const BATCH_MS = 800
const BATCH_BYTES = 3400
const MAX_RUN_MS = 9 * 60 * 1000
const CLEANUP_INTERVAL_MS = 60_000

const runs = new Map()

function meta(rid) {
  let r = runs.get(rid)
  if (r) return r
  const snap = kv.get(`run:${rid}`)
  if (!snap) return null
  r = {
    rid,
    seq: snap.seq ?? -1,
    phase: snap.phase ?? 'done',
    error: snap.error ?? null,
    sockets: new Set(),
    pending: '',
    pendingImages: [],
    flushTimer: null,
    controller: null,
    startedAt: snap.startedAt ?? 0,
    timeoutTimer: null,
  }
  runs.set(rid, r)
  return r
}

function ensure(rid) {
  let r = meta(rid)
  if (r) return r
  r = {
    rid,
    seq: -1,
    phase: 'idle',
    error: null,
    sockets: new Set(),
    pending: '',
    pendingImages: [],
    flushTimer: null,
    controller: null,
    startedAt: 0,
    timeoutTimer: null,
  }
  runs.set(rid, r)
  return r
}

function saveSnapshot(r) {
  kv.set(`run:${r.rid}`, {
    rid: r.rid,
    seq: r.seq,
    phase: r.phase,
    error: r.error,
    startedAt: r.startedAt,
  })
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)) } catch {}
}

function bcast(r, obj) {
  for (const ws of r.sockets) send(ws, obj)
}

function flush(r, force = false) {
  if (r.flushTimer) { clearTimeout(r.flushTimer); r.flushTimer = null }
  if (r.pending || r.pendingImages.length > 0) {
    const item = { seq: ++r.seq, text: r.pending }
    if (r.pendingImages.length > 0) item.images = [...r.pendingImages]
    kv.set(`delta:${r.rid}:${String(item.seq).padStart(10, '0')}`, item)
    bcast(r, { type: 'delta', seq: item.seq, text: item.text, images: item.images })
    r.pending = ''
    r.pendingImages = []
  }
  if (force) saveSnapshot(r)
}

function queueDelta(r, text, images) {
  if (!text && (!images || !images.length)) return
  if (text) r.pending += text
  if (images) r.pendingImages.push(...images)
  if (r.pending.length >= BATCH_BYTES || r.pendingImages.length > 0) flush(r, false)
  else if (!r.flushTimer) r.flushTimer = setTimeout(() => flush(r, false), BATCH_MS)
}

function getDeltas(rid) {
  const keys = kv.list(`delta:${rid}:`)
  return keys.map(k => kv.get(k)).filter(Boolean).sort((a, b) => a.seq - b.seq)
}

function replay(r, ws, after) {
  const deltas = getDeltas(r.rid)
  for (const it of deltas) {
    if (it.seq > after) send(ws, { type: 'delta', seq: it.seq, text: it.text, images: it.images })
  }
  if (r.phase === 'done') send(ws, { type: 'done' })
  else if (['error', 'evicted'].includes(r.phase)) send(ws, { type: 'err', message: r.error || 'The run was terminated unexpectedly.' })
}

function clearTimeoutTimer(r) {
  if (r.timeoutTimer) { clearTimeout(r.timeoutTimer); r.timeoutTimer = null }
}

function stop(r) {
  if (r.phase !== 'running') return
  clearTimeoutTimer(r)
  flush(r, true)
  r.phase = 'done'
  r.error = null
  const duration = ((Date.now() - r.startedAt) / 1000).toFixed(1)
  try { r.controller?.abort() } catch {}
  saveSnapshot(r)
  bcast(r, { type: 'done' })
  notify(`Run ${r.rid} ended. Duration: ${duration}s`, 3, ['stop_sign'])
}

function fail(r, message) {
  if (r.phase !== 'running') return
  clearTimeoutTimer(r)
  const err = String(message || 'stream_failed')
  const duration = ((Date.now() - r.startedAt) / 1000).toFixed(1)
  queueDelta(r, `\n\nRun failed: ${err}`)
  flush(r, true)
  r.phase = 'error'
  r.error = err
  try { r.controller?.abort() } catch {}
  saveSnapshot(r)
  bcast(r, { type: 'err', message: r.error })
  notify(`Run ${r.rid} failed after ${duration}s: ${r.error}`, 3, ['rotating_light'])
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return []
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

async function beginStream(r, { apiKey, body, provider }) {
  try {
    const providerFn = { openai: streamOpenAI, google: streamGoogle, claude: streamClaude }[provider] || streamOpenRouter
    await providerFn({
      apiKey,
      body,
      signal: r.controller.signal,
      onDelta: (text, images) => queueDelta(r, text, images),
      isRunning: () => r.phase === 'running',
    })
  } catch (e) {
    if (r.phase === 'running') {
      const msg = String(e?.message || 'stream_failed')
      if (!(e?.name === 'AbortError' || /abort/i.test(msg))) fail(r, msg)
    }
  } finally {
    if (r.phase === 'running') stop(r)
  }
}

// Periodic cleanup: remove terminal runs with no sockets from the Map
setInterval(() => {
  const now = Date.now()
  for (const [uid, r] of runs) {
    if (r.phase === 'running') {
      // Safety: if startedAt is set and exceeded MAX_RUN_MS, force-fail
      if (r.startedAt && now - r.startedAt > MAX_RUN_MS) {
        fail(r, `Run timed out after ${MAX_RUN_MS / 60000} minutes.`)
      }
      continue
    }
    // Terminal run with no connected sockets — safe to evict from Map
    if (r.sockets.size === 0) runs.delete(uid)
  }
}, CLEANUP_INTERVAL_MS)

export function addSocket(rid, ws) {
  const r = ensure(rid)
  r.sockets.add(ws)
  return r
}

export function removeSocket(rid, ws) {
  const r = runs.get(rid)
  if (r) r.sockets.delete(ws)
}

export function handleMessage(rid, ws, msg) {
  const r = ensure(rid)

  if (msg.type === 'stop') {
    if (msg.rid === r.rid) stop(r)
    return
  }

  if (msg.type !== 'begin') {
    send(ws, { type: 'err', message: 'bad_type' })
    return
  }

  const { rid: msgRid, apiKey, or_body, model, messages, after, provider } = msg
  let body = or_body || (model && Array.isArray(messages) ? { model, messages, stream: true, ...msg } : null)

  if (!msgRid || !apiKey || !body || !Array.isArray(body.messages) || body.messages.length === 0) {
    send(ws, { type: 'err', message: 'missing_fields' })
    return
  }

  body.messages = sanitizeMessages(body.messages)

  if (r.phase === 'running' && msgRid !== r.rid) {
    send(ws, { type: 'err', message: 'busy' })
    return
  }

  if (msgRid === r.rid && r.phase !== 'idle') {
    replay(r, ws, Number.isFinite(+after) ? +after : -1)
    return
  }

  r.rid = msgRid
  r.seq = -1
  r.phase = 'running'
  r.error = null
  r.pending = ''
  r.pendingImages = []
  r.controller = new AbortController()
  r.startedAt = Date.now()

  // Hard timeout safety net
  r.timeoutTimer = setTimeout(() => {
    if (r.phase === 'running') fail(r, `Run timed out after ${MAX_RUN_MS / 60000} minutes.`)
  }, MAX_RUN_MS)

  kv.set(`prompt:${r.rid}`, body.messages)
  saveSnapshot(r)
  beginStream(r, { apiKey, body, provider: provider || 'openrouter' })
}

export function handlePoll(uid) {
  const r = meta(uid)
  if (!r) return { rid: null, seq: -1, phase: 'idle', done: false, error: null, text: '', images: [] }
  const deltas = getDeltas(r.rid)
  const text = deltas.map(d => d.text).join('') + r.pending
  const images = [...deltas.flatMap(d => d.images || []), ...r.pendingImages]
  const isTerminal = ['done', 'error', 'evicted'].includes(r.phase)
  const isError = ['error', 'evicted'].includes(r.phase)
  return {
    rid: r.rid,
    seq: r.seq,
    phase: r.phase,
    done: isTerminal,
    error: isError ? (r.error || 'The run was terminated unexpectedly.') : null,
    text,
    images,
  }
}
