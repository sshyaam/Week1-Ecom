import { Router } from 'itty-router';
import { json, getAuthFromRequest, callLogger } from './common.js';

// In-memory map: user_id -> Set<WebSocket>
const userSockets = new Map();

// ----- Helpers -----
function addSocket(userId, ws) {
  let set = userSockets.get(userId);
  if (!set) {
    set = new Set();
    userSockets.set(userId, set);
  }
  set.add(ws);
}

function removeSocket(userId, ws) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    userSockets.delete(userId);
  }
}

async function broadcastOrderStatus(userId, payload) {
  const set = userSockets.get(userId);
  if (!set || set.size === 0) return;

  const msg = JSON.stringify({
    type: 'order_status',
    ...payload
  });

  for (const ws of set) {
    try {
      ws.send(msg);
    } catch (e) {
      await callLogger("ws", "failed ws message", {userId, payload})
      // ignore send failures
    }
  }
}

// ----- WebSocket connection handler -----
function handleWebSocketConnection(userId, ws) {
  addSocket(userId, ws);
  ws.accept();

  ws.addEventListener('message', (event) => {
    // Optional: handle pings, subscribe, etc.
    // For now we can ignore or echo.
    // const data = event.data;
  });

  ws.addEventListener('close', () => {
    removeSocket(userId, ws);
  });

  ws.addEventListener('error', () => {
    removeSocket(userId, ws);
  });
}

// ----- Router -----
const router = Router();

// WebSocket endpoint for order status
router.get('/ws/orders', async (request, env, ctx) => {
  // Authenticate user using the same session cookie logic
  const auth = await getAuthFromRequest(request, env);
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, { status: 401 });
  }

  if (request.headers.get('Upgrade') !== 'websocket') {
    return new Response('Expected websocket', { status: 426 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  const userId = auth.user.id;
  handleWebSocketConnection(userId, server);

  return new Response(null, {
    status: 101,
    webSocket: client
  });
});

// Internal endpoint for other workers to push order status updates
router.post('/internal/order-status', async (request, env, ctx) => {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const { user_id, order_id, status } = body || {};
  if (!user_id || !order_id || !status) {
    return json(
      { ok: false, error: 'Missing user_id, order_id, or status' },
      { status: 400 }
    );
  }

  // In a real system you could add some internal auth here (e.g. shared secret header)
  await broadcastOrderStatus(user_id, { order_id, status });

  return json({ ok: true });
});

router.get('/health', async (request, env, ctx) => {
  return json({
    ok: true,
    service: 'realtime',
    ts: new Date().toISOString()
  });
});


// Fallback
router.all('*', () =>
  json({ ok: false, error: 'Not found (realtime worker)' }, { status: 404 })
);

export default {
  fetch: (request, env, ctx) => router.fetch(request, env, ctx)
};
