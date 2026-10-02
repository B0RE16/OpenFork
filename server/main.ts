// Standalone server: serves the client from public/ and the game over a WebSocket at /ws.
// All game logic lives in server/core.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import type { GameMap } from '../shared/map.ts';
import type { ServerMessage } from '../shared/protocol.ts';
import { TICK_MS } from '../shared/rules.ts';
import { GuestAuth } from './adapters/memory.ts';
import { GameServer } from './core/game-server.ts';
import type { ConnId } from './core/ports.ts';

const PORT = Number(process.env.PORT ?? 8090);
const HOST = process.env.HOST ?? '0.0.0.0';
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};
/** Messages per second a client may send before being disconnected. */
const MAX_MSGS_PER_SEC = 60;

const maps = new Map<string, GameMap>();
for (const f of readdirSync(join(PUBLIC_DIR, 'maps')).filter((f) => f.endsWith('.json'))) {
  const map: GameMap = JSON.parse(readFileSync(join(PUBLIC_DIR, 'maps', f), 'utf8'));
  maps.set(map.id, map);
}

const sockets = new Map<ConnId, WebSocket>();
const game = new GameServer({
  transport: {
    send(conn: ConnId, msg: ServerMessage) {
      const ws = sockets.get(conn);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  },
  auth: new GuestAuth(),
  clock: { now: () => Date.now() },
  maps,
  log: (m) => console.log(m),
});

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  try {
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
      res.writeHead(403).end();
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 32 * 1024 });
const alive = new WeakSet<WebSocket>();

wss.on('connection', (ws) => {
  const conn = randomUUID();
  sockets.set(conn, ws);
  alive.add(ws);
  game.handleConnect(conn);

  let windowStart = Date.now();
  let count = 0;
  ws.on('pong', () => alive.add(ws));
  ws.on('message', (data) => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    if (++count > MAX_MSGS_PER_SEC) {
      ws.close(1008, 'rate limit');
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(data.toString());
    } catch {
      return;
    }
    game.handleMessage(conn, raw).catch((e) => console.error('handleMessage failed', e));
  });
  ws.on('close', () => {
    sockets.delete(conn);
    game.handleDisconnect(conn);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    ws.ping();
  }
}, 15_000);

setInterval(() => game.tick(), TICK_MS);

http.listen(PORT, HOST, () => console.log(`OpenFork on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
