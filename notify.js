const NTFY_URL = process.env.NTFY_URL || ''

export function notify(msg, priority = 3, tags = []) {
  if (!NTFY_URL) return
  fetch(NTFY_URL, {
    method: 'POST',
    body: msg,
    headers: {
      Title: 'Sune Proxy',
      Priority: `${priority}`,
      Tags: tags.join(','),
    },
  }).catch(e => console.error('ntfy failed:', e))
}
