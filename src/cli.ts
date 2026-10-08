import { Store } from './store';
import { renderBoard } from './render';
import { BoardState, Move, Point } from './types';

const store = new Store();
const [, , cmd, ...args] = process.argv;

function readJson(file: string): unknown {
  return JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
}

function parseStateFile(file: string): BoardState {
  const b = readJson(file) as Record<string, unknown>;
  return {
    width: Number(b.width), height: Number(b.height),
    walls: (b.walls as Point[]) ?? [], foods: (b.foods as Point[]) ?? [],
    snakes: ((b.snakes as BoardState['snakes']) ?? []).map((s) => ({ ...s, alive: s.alive !== false })),
    version: 0,
  };
}

function out(v: unknown): void { console.log(JSON.stringify(v, null, 2)); }

try {
  switch (cmd) {
    case 'create': { // create <id> <state.json>
      const state = store.createBoard(args[0], parseStateFile(args[1]));
      console.log(renderBoard(state));
      break;
    }
    case 'import': { // import <id> <state.json>
      const state = store.importBoard(args[0], parseStateFile(args[1]));
      console.log(renderBoard(state));
      break;
    }
    case 'add-food': { // add-food <id> <x> <y>
      const state = store.addFood(args[0], { x: Number(args[1]), y: Number(args[2]) });
      console.log(renderBoard(state));
      break;
    }
    case 'tick': { // tick <id> <requestId> <version> [moves.json] [steps]
      const moves = args[3] ? (readJson(args[3]) as Move[]) : [];
      const steps = args[4] ? Number(args[4]) : 1;
      const before = store.getBoard(args[0]);
      console.log('--- before ---');
      console.log(renderBoard(before));
      const results = store.submitTick(args[0], args[1], Number(args[2]), moves, steps);
      for (const r of results) {
        console.log(`--- tick ${r.tick} ---`);
        console.log(renderBoard(r.board));
        if (r.deaths.length) {
          console.log('deaths:');
          for (const d of r.deaths) {
            console.log(`  ${d.snakeId}: ${d.reasons.join(', ')} target=(${d.target.x},${d.target.y})`);
          }
        }
        if (r.consumedFood.length) {
          console.log(`consumed: ${r.consumedFood.map((p) => `(${p.x},${p.y})`).join(' ')}`);
        }
      }
      break;
    }
    case 'collisions': { // collisions <id> <snakeId>
      out(store.getSnakeCollision(args[0], args[1]) ?? { message: '该蛇无死亡记录' });
      break;
    }
    case 'board': { // board <id> [tick]
      const state = args[2] !== undefined
        ? store.getTickBoard(args[0], Number(args[2]))
        : store.getBoard(args[0]);
      console.log(renderBoard(state));
      break;
    }
    case 'export': { // export <id>
      out(store.exportReplay(args[0]));
      break;
    }
    default:
      console.log(`用法:
  create <id> <state.json>            创建场景
  import <id> <state.json>            导入/替换局面
  add-food <id> <x> <y>               添加食物
  tick <id> <requestId> <version> [moves.json] [steps]  提交 tick
  collisions <id> <snakeId>           查询某蛇碰撞来源
  board <id> [tick]                   显示当前或历史棋盘
  export <id>                         导出回放 JSON`);
  }
} catch (e) {
  const err = e as { code?: string; message?: string };
  console.error(`错误 [${err.code ?? 'INTERNAL'}] ${err.message ?? e}`);
  process.exitCode = 1;
}
