import * as http from "node:http";
import * as crypto from "node:crypto";
import { Store } from "./store";
import { applyTick, key, renderBoard } from "./engine";
import { validateScenario } from "./validate";
import { ApiError, Move } from "./types";

function hashRequest(payload: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError("VALIDATION_ERROR", "请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body =
        method === "POST" || method === "PUT" ? await readBody(req) : undefined;

      if (method === "POST" && parts.length === 1 && parts[0] === "scenarios") {
        const state = validateScenario(body);
        const id =
          typeof body.id === "string" && body.id ? body.id : crypto.randomUUID();
        if (store.exists(id))
          throw new ApiError("VALIDATION_ERROR", `场景 ID 已存在: ${id}`, 409);
        store.createScenario(id, state);
        return send(201, { id, version: 0, board: renderBoard(state) });
      }

      if (parts[0] === "scenarios" && parts.length >= 2) {
        const id = parts[1];

        if (method === "GET" && parts.length === 2) {
          const state = store.loadState(id);
          return send(200, { ...state, board: renderBoard(state) });
        }
        if (method === "POST" && parts[2] === "import") {
          if (!store.exists(id))
            throw new ApiError("NOT_FOUND", `场景不存在: ${id}`, 404);
          const state = validateScenario(body);
          store.importState(id, state);
          return send(200, { id, version: 0, board: renderBoard(state) });
        }
        if (method === "POST" && parts[2] === "foods") {
          const state = store.loadState(id);
          const f = body;
          if (!Number.isInteger(f?.x) || !Number.isInteger(f?.y))
            throw new ApiError("VALIDATION_ERROR", "食物坐标必须是整数");
          if (f.x < 0 || f.y < 0 || f.x >= state.width || f.y >= state.height)
            throw new ApiError("VALIDATION_ERROR", "食物坐标越界");
          const k = key(f);
          if (state.walls.some((w) => key(w) === k))
            throw new ApiError("FOOD_CELL_OCCUPIED", "不能把食物放进墙里");
          if (state.foods.some((w) => key(w) === k))
            throw new ApiError("FOOD_CELL_OCCUPIED", "该格已有食物");
          for (const s of state.snakes)
            if (s.alive && s.body.some((c) => key(c) === k))
              throw new ApiError("FOOD_CELL_OCCUPIED", "不能把食物放进活蛇身体");
          store.setFoods(id, [...state.foods, { x: f.x, y: f.y }]);
          return send(200, { ok: true, foods: [...state.foods, f] });
        }
        if (method === "POST" && parts[2] === "ticks") {
          const { requestId, version, moves } = body ?? {};
          if (typeof requestId !== "string" || !requestId)
            throw new ApiError("VALIDATION_ERROR", "缺少 requestId");
          if (!Number.isInteger(version))
            throw new ApiError("VALIDATION_ERROR", "缺少整数 version");
          if (!Array.isArray(moves))
            throw new ApiError("VALIDATION_ERROR", "moves 必须是数组");
          const requestHash = hashRequest({ version, moves });
          const { result, replayed } = store.applyTickIdempotent(
            id,
            requestId,
            requestHash,
            () => {
              const state = store.loadState(id);
              if (version !== state.version)
                throw new ApiError(
                  "VERSION_CONFLICT",
                  `版本过期: 期望 ${state.version}, 收到 ${version}`,
                  409
                );
              const result = applyTick(state, moves as Move[]);
              const resultById = new Map(result.results.map((r) => [r.snakeId, r]));
              const nextState = {
                ...state,
                version: result.version,
                tick: result.tick,
                foods: result.foods,
                snakes: state.snakes.map((s) => {
                  const r = resultById.get(s.id);
                  return r ? { ...s, alive: r.alive, dir: r.dir, body: r.body } : s;
                }),
              };
              return { state: nextState, result, movesJson: JSON.stringify(moves) };
            }
          );
          return send(200, { ...result, replayed });
        }
        if (method === "GET" && parts[2] === "snakes" && parts[4] === "collisions") {
          return send(200, { deaths: store.getDeaths(id, parts[3]) });
        }
        if (method === "GET" && parts[2] === "board") {
          const t = url.searchParams.get("tick");
          if (t === null) {
            const state = store.loadState(id);
            return send(200, { tick: state.tick, board: renderBoard(state) });
          }
          return send(200, { tick: Number(t), board: store.getBoardAt(id, Number(t)) });
        }
        if (method === "GET" && parts[2] === "replay") {
          return send(200, store.getReplay(id));
        }
      }

      throw new ApiError("NOT_FOUND", "路由不存在", 404);
    } catch (e) {
      if (e instanceof ApiError) {
        send(e.status, { error: { code: e.code, message: e.message } });
      } else {
        send(500, { error: { code: "INTERNAL", message: String(e) } });
      }
    }
  });
}

export function findFreePort(preferred = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(preferred, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}
