import { handleMessage, removeSocket } from './run.js'

const PORT = +(process.env.PORT || 8080)

const ALLOWED_ORIGINS = ['sune.planetrenox.com', 'sune.chat']
const isAllowed = origin => {
  try {
    const h = new URL(origin).hostname
    return ALLOWED_ORIGINS.some(a => h === a || h.endsWith('.github.io'))
  } catch { return false }
}

const json = (data, status) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } })

Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url)

    const origin = req.headers.get('Origin')
    if (origin && !isAllowed(origin)) return json({ error: 'Forbidden' }, 403)

    if (url.pathname !== '/ws') return json({ error: 'not found' }, 404)

    const rid = (url.searchParams.get('rid') || '').slice(0, 64).replace(/[^a-zA-Z0-9_-]/g, '')
    if (!rid) return json({ error: 'rid is required' }, 400)

    if (server.upgrade(req, { data: { rid } })) return

    return json({ error: 'websocket required' }, 426)
  },

  websocket: {
    // Videos ride along as base64 in every request; Bun's 16 MB default fits only a handful
    maxPayloadLength: 100 * 1024 * 1024,
    message(ws, raw) {
      let msg
      try { msg = JSON.parse(String(raw)) }
      catch { try { ws.send(JSON.stringify({ type: 'err', message: 'bad_json' })) } catch {}; return }
      handleMessage(ws, msg)
    },
    close: removeSocket,
  },
})

console.log(`🟢 us.proxy.sune.chat running on :${PORT}`)
