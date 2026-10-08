import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { Store, defaultDbPath } from "./store";
import { createServer, findFreePort } from "./api";
import { applyTick, renderBoard } from "./engine";
import { validateScenario } from "./validate";
import { BoardState, Move } from "./types";

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function printBoard(board: string[]) {
  for (const row of board) console.log("  " + row);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dbPath = argValue(rest, "db") ?? defaultDbPath();

  if (cmd === "serve") {
    const portArg = argValue(rest, "port");
    const port = portArg ? Number(portArg) : await findFreePort();
    const store = new Store(dbPath);
    const server = createServer(store);
    server.listen(port, "127.0.0.1", () => {
      console.log(`API 服务已启动: http://127.0.0.1:${port} (数据库: ${dbPath})`);
    });
    return;
  }

  if (cmd === "demo") {
    runDemo();
    return;
  }

  const store = new Store(dbPath);
  try {
    switch (cmd) {
      case "create": {
        const file = argValue(rest, "file");
        const input = file
          ? JSON.parse(fs.readFileSync(file, "utf8"))
          : JSON.parse(argValue(rest, "json") ?? "{}");
        const state = validateScenario(input);
        const id = input.id ?? argValue(rest, "id") ?? crypto.randomUUID();
        if (store.exists(id)) throw new Error(`场景 ID 已存在: ${id}`);
        store.createScenario(id, state);
        console.log(`已创建场景 ${id} (version=0)`);
        printBoard(renderBoard(state));
        break;
      }
      case "import": {
        const id = argValue(rest, "id") ?? rest[0];
        const file = argValue(rest, "file");
        if (!file) throw new Error("import 需要 --file 参数");
        const input = JSON.parse(fs.readFileSync(file, "utf8"));
        const state = validateScenario(input);
        if (!store.exists(id)) store.createScenario(id, state);
        else store.importState(id, state);
        console.log(`已导入局面到场景 ${id}，版本与历史已重置`);
        printBoard(renderBoard(state));
        break;
      }
      case "add-food": {
        const id = argValue(rest, "id") ?? rest[0];
        const x = Number(argValue(rest, "x"));
        const y = Number(argValue(rest, "y"));
        const state = store.loadState(id);
        const k = `${x},${y}`;
        if (x < 0 || y < 0 || x >= state.width || y >= state.height)
          throw new Error("食物坐标越界");
        if (state.walls.some((w) => `${w.x},${w.y}` === k))
          throw new Error("不能把食物放进墙里");
        if (state.foods.some((w) => `${w.x},${w.y}` === k))
          throw new Error("该格已有食物");
        for (const s of state.snakes)
          if (s.alive && s.body.some((c) => `${c.x},${c.y}` === k))
            throw new Error("不能把食物放进活蛇身体");
        store.setFoods(id, [...state.foods, { x, y }]);
        console.log(`已在 (${x},${y}) 添加食物`);
        break;
      }
      case "tick": {
        const id = argValue(rest, "id") ?? rest[0];
        const moves: Move[] = JSON.parse(argValue(rest, "moves") ?? "[]");
        const requestId = argValue(rest, "request") ?? crypto.randomUUID();
        const state = store.loadState(id);
        console.log(`tick 前 (version=${state.version}):`);
        printBoard(renderBoard(state));
        const requestHash = crypto
          .createHash("sha256")
          .update(JSON.stringify({ version: state.version, moves }))
          .digest("hex");
        const { result, replayed } = store.applyTickIdempotent(
          id,
          requestId,
          requestHash,
          () => {
            const fresh = store.loadState(id);
            const result = applyTick(fresh, moves);
            const byId = new Map(result.results.map((r) => [r.snakeId, r]));
            const nextState: BoardState = {
              ...fresh,
              version: result.version,
              tick: result.tick,
              foods: result.foods,
              snakes: fresh.snakes.map((s) => {
                const r = byId.get(s.id);
                return r ? { ...s, alive: r.alive, dir: r.dir, body: r.body } : s;
              }),
            };
            return { state: nextState, result, movesJson: JSON.stringify(moves) };
          }
        );
        console.log(
          `tick 后 (tick=${result.tick}, version=${result.version}${replayed ? ", 幂等重放" : ""}):`
        );
        printBoard(result.board);
        for (const r of result.results) {
          if (!r.alive)
            console.log(`  蛇 ${r.snakeId} 死亡: ${r.deathReasons.join(", ")}`);
          else if (r.ateFood) console.log(`  蛇 ${r.snakeId} 吃到食物并增长`);
        }
        break;
      }
      case "board": {
        const id = argValue(rest, "id") ?? rest[0];
        const t = argValue(rest, "tick");
        if (t !== undefined) printBoard(store.getBoardAt(id, Number(t)));
        else printBoard(renderBoard(store.loadState(id)));
        break;
      }
      case "collisions": {
        const id = argValue(rest, "id") ?? rest[0];
        const sid = argValue(rest, "snake") ?? rest[1];
        console.log(JSON.stringify(store.getDeaths(id, sid), null, 2));
        break;
      }
      case "replay": {
        const id = argValue(rest, "id") ?? rest[0];
        console.log(JSON.stringify(store.getReplay(id), null, 2));
        break;
      }
      default:
        console.log(`用法: node dist/src/cli.js <命令> [参数]
  serve [--port N] [--db 路径]        启动 API 服务（默认自动选择空闲端口）
  create --file 局面.json [--id ID]   创建场景
  import <id> --file 局面.json        导入局面（重置版本与历史）
  add-food <id> --x N --y N           在空格添加食物
  tick <id> --moves "[{\"snakeId\":\"A\",\"dir\":\"R\"}]" [--request ID]
  board <id> [--tick N]               查看当前或历史字符棋盘
  collisions <id> <snakeId>           查询某蛇碰撞来源
  replay <id>                         导出回放 JSON
  demo                                运行内置演示`);
    }
  } finally {
    store.close();
  }
}

function runDemo() {
  const base = {
    width: 6,
    height: 4,
    snakes: [
      { id: "A", dir: "R", body: [{ x: 2, y: 1 }, { x: 1, y: 1 }] },
      { id: "B", dir: "R", body: [{ x: 4, y: 1 }, { x: 3, y: 1 }] },
    ],
  };

  const show = (title: string, state: BoardState, moves: Move[]) => {
    console.log(`\n=== ${title} ===`);
    console.log("移动前:");
    printBoard(renderBoard(state));
    const result = applyTick(state, moves);
    console.log("移动后:");
    printBoard(result.board);
    for (const r of result.results) {
      const status = r.alive
        ? `存活，新身体 ${JSON.stringify(r.body)}${r.ateFood ? "，吃到食物" : ""}`
        : `死亡: ${r.deathReasons.join(", ")}`;
      console.log(`  ${r.snakeId}: ${status}`);
    }
  };

  show("演示1：无食物，A 进入 B 腾空的尾格 (3,1)", validateScenario(base), []);

  show(
    "演示2：(5,1) 有食物，B 保留尾格，A 撞身体死亡",
    validateScenario({ ...base, foods: [{ x: 5, y: 1 }] }),
    []
  );

  show(
    "演示3：两头进入同一目标格，全部死亡",
    validateScenario({
      width: 6,
      height: 4,
      snakes: [
        { id: "A", dir: "R", body: [{ x: 1, y: 1 }] },
        { id: "B", dir: "L", body: [{ x: 3, y: 1 }] },
      ],
    }),
    []
  );

  show(
    "演示4：长度一互换旧头格，全部死亡",
    validateScenario({
      width: 6,
      height: 4,
      snakes: [
        { id: "A", dir: "R", body: [{ x: 1, y: 1 }] },
        { id: "B", dir: "L", body: [{ x: 2, y: 1 }] },
      ],
    }),
    []
  );

  show(
    "演示5：进入自己本步腾空的尾格（合法）",
    validateScenario({
      width: 6,
      height: 4,
      snakes: [
        {
          id: "A",
          dir: "D",
          body: [
            { x: 2, y: 1 },
            { x: 2, y: 0 },
            { x: 3, y: 0 },
            { x: 3, y: 1 },
          ],
        },
      ],
    }),
    [{ snakeId: "A", dir: "R" }]
  );
}

main().catch((e) => {
  console.error(`错误: ${e.message ?? e}`);
  process.exit(1);
});
