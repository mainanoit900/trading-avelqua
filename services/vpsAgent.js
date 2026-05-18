async function postJson(url, apiKey, body, timeoutMs = 12000) {
  if (!url) return { ok: false, skipped: true, error: 'ยังไม่ได้ตั้งค่า api_url ของ VPS' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey || ''
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function runBot(node, payload) {
  return postJson(`${String(node.api_url || '').replace(/\/$/, '')}/run-bot`, node.api_key, payload);
}

async function stopBot(node, payload) {
  return postJson(`${String(node.api_url || '').replace(/\/$/, '')}/stop-bot`, node.api_key, payload);
}

async function ping(node) {
  return postJson(`${String(node.api_url || '').replace(/\/$/, '')}/status`, node.api_key, { nodeCode: node.node_code });
}

module.exports = { runBot, stopBot, ping };
