import { addSocket, removeSocket, handleMessage, handlePoll } from './run.js'

const PORT = +(process.env.PORT || 8080)

const ALLOWED_ORIGINS = ['sune.planetrenox.com', 'sune.chat']
const isAllowed = origin => {
  if (!origin) return false
  try {
    const h = new URL(origin).hostname
    return ALLOWED_ORIGINS.some(a => h === a || h.endsWith('.github.io'))
  } catch { return false }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS },
})

Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url)
    const method = req.method.toUpperCase()

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    const origin = req.headers.get('Origin')
    if (origin && !isAllowed(origin)) return json({ error: 'Forbidden' }, 403)

    if (url.pathname !== '/ws') return json({ error: 'not found' }, 404)

    const uid = (url.searchParams.get('uid') || '').slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '')
    if (!uid) return json({ error: 'uid is required' }, 400)

    if (server.upgrade(req, { data: { uid } })) return

    if (method === 'GET') return json(handlePoll(uid))

    return json({ error: 'method not allowed' }, 405)
  },

  websocket: {
    open(ws) {
      const { uid } = ws.data
      addSocket(uid, ws)
    },
    message(ws, raw) {
      const { uid } = ws.data
      let msg
      try { msg = JSON.parse(String(raw)) }
      catch { try { ws.send(JSON.stringify({ type: 'err', message: 'bad_json' })) } catch {}; return }
      handleMessage(uid, ws, msg)
    },
    close(ws) {
      const { uid } = ws.data
      removeSocket(uid, ws)
    },
  },
})

console.log(`🟢 us.proxy.sune.chat running on :${PORT}`)
