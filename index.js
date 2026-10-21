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

    // The run id travels inside each message, never in the URL, so it can't end up in access logs
    if (server.upgrade(req, { data: {} })) return

    return json({ error: 'websocket required' }, 426)
  },

  websocket: {
    // Videos ride along as base64 in every request; Bun's 16 MB default fits only a handful
    maxPayloadLength: 100 * 1024 * 1024,
    // Anything malformed (bad JSON, null, wrong shapes) fails only that message; a throw here would kill the process
    message(ws, raw) {
      try { handleMessage(ws, JSON.parse(String(raw))) }
      catch { try { ws.send(JSON.stringify({ type: 'err', message: 'bad_message' })) } catch {} }
    },
    close: removeSocket,
  },
})

console.log(`🟢 us.proxy.sune.chat running on :${PORT}`)
