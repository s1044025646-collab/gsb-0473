import * as http from 'node:http';
import { Store } from './store';
import { renderBoard } from './render';
import { ApiError, BoardState, Move, Point } from './types';

const store = new Store();

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError('VALIDATION', '请求体不是合法 JSON', 400); }
}

function parseState(body: Record<string, unknown>): BoardState {
  return {
    width: Number(body.width),
    height: Number(body.height),
    walls: (body.walls as Point[]) ?? [],
    foods: (body.foods as Point[]) ?? [],
    snakes: ((body.snakes as BoardState['snakes']) ?? []).map((s) => ({ ...s, alive: s.alive !== false })),
    version: 0,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const body = (req.method === 'POST' || req.method === 'PUT')
      ? await readBody(req) as Record<string, never> : {};

    if (req.method === 'POST' && url.pathname === '/boards') {
      const id = String(body.id ?? `board-${Date.now()}`);
      return send(res, 201, store.createBoard(id, parseState(body)));
    }
    if (parts[0] === 'boards' && parts[1]) {
      const id = parts[1];
      if (req.method === 'GET' && parts.length === 2) {
        return send(res, 200, store.getBoard(id));
      }
      if (req.method === 'POST' && parts[2] === 'import') {
        return send(res, 200, store.importBoard(id, parseState(body)));
      }
      if (req.method === 'POST' && parts[2] === 'foods') {
        return send(res, 200, store.addFood(id, { x: Number(body.x), y: Number(body.y) }));
      }
      if (req.method === 'POST' && parts[2] === 'ticks') {
        const results = store.submitTick(
          id, String(body.requestId ?? ''), Number(body.version),
          (body.moves as Move[]) ?? [], body.steps !== undefined ? Number(body.steps) : 1);
        return send(res, 200, { results });
      }
      if (req.method === 'GET' && parts[2] === 'snakes' && parts[3] && parts[4] === 'collisions') {
        const found = store.getSnakeCollision(id, parts[3]);
        if (!found) throw new ApiError('NOT_FOUND', `蛇 ${parts[3]} 没有死亡记录`, 404);
        return send(res, 200, found);
      }
      if (req.method === 'GET' && parts[2] === 'boards' && parts[3] !== undefined) {
        const state = store.getTickBoard(id, Number(parts[3]));
        if (url.searchParams.get('format') === 'text') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end(renderBoard(state));
        }
        return send(res, 200, state);
      }
      if (req.method === 'GET' && parts[2] === 'export') {
        return send(res, 200, store.exportReplay(id));
      }
    }
    throw new ApiError('NOT_FOUND', `未知路由: ${req.method} ${url.pathname}`, 404);
  } catch (e) {
    if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message });
    console.error(e);
    return send(res, 500, { error: 'INTERNAL', message: String(e) });
  }
});

const port = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口
server.listen(port, () => {
  const addr = server.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  console.log(`snake server listening on http://127.0.0.1:${actual}`);
});
