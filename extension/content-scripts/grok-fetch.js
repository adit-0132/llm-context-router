// Grok MAIN world helper — runs at document_start to wrap fetch before the page uses it.
// Intercepts the page's own load-responses call and caches it per conversation.
// Also handles direct fetch fallback from grok.js (isolated world) via postMessage.

const _origFetch = window.fetch;

// Cache keyed by conversationId so switching conversations doesn't return stale data
const _cache = new Map();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Wrap window.fetch to intercept load-responses before the page consumes it
window.fetch = async function(...args) {
  const req = args[0];
  const url = typeof req === 'string' ? req : (req instanceof Request ? req.url : '');
  const result = await _origFetch.apply(this, args);

  if (url.includes('load-responses')) {
    const idMatch = url.match(/\/conversations\/([^/]+)\/load-responses/);
    const cid = idMatch?.[1];
    if (cid) {
      result.clone().json().then(data => {
        _cache.set(cid, data);
      }).catch(() => {});
    }
  }

  return result;
};

window.addEventListener('message', async (e) => {
  if (e.origin !== 'https://grok.com') return;
  if (!e.data || e.data.type !== '__cp_grok_fetch') return;

  const { conversationId, msgId } = e.data;

  // Validate conversationId is a UUID before using in URL
  if (!UUID_RE.test(conversationId)) {
    window.postMessage({ type: msgId, ok: false, error: 'Invalid conversation ID' }, 'https://grok.com');
    return;
  }

  // Prefer intercepted data for this specific conversation
  if (_cache.has(conversationId)) {
    window.postMessage({ type: msgId, ok: true, data: _cache.get(conversationId) }, 'https://grok.com');
    return;
  }

  // Fallback: fetch directly (runs with origin: https://grok.com in MAIN world)
  try {
    const r = await _origFetch(
      `/rest/app-chat/conversations/${conversationId}/load-responses`,
      { method: 'POST', credentials: 'include' }
    );
    const data = await r.json();
    _cache.set(conversationId, data);
    window.postMessage({ type: msgId, ok: true, data }, 'https://grok.com');
  } catch (err) {
    window.postMessage({ type: msgId, ok: false, error: err.message }, 'https://grok.com');
  }
});
