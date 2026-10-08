import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from './store';
import { renderBoard } from './render';
import { BoardState } from './types';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-demo-'));
const store = new Store(path.join(tmp, 'demo.db'));

function baseState(snakes: BoardState['snakes'], foods: { x: number; y: number }[] = []): BoardState {
  return { width: 6, height: 4, walls: [], foods, snakes, version: 0 };
}

function scenario(name: string, state: BoardState, moves: { snakeId: string; dir: never }[] | never[]): void {
  console.log(`\n===== ${name} =====`);
  const id = `demo-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  store.createBoard(id, state);
  console.log('--- before ---');
  console.log(renderBoard(state));
  const [r] = store.submitTick(id, `req-${id}`, 0, moves as never[]);
  console.log(`--- tick ${r.tick} ---`);
  console.log(renderBoard(r.board));
  for (const d of r.deaths) console.log(`死亡 ${d.snakeId}: ${d.reasons.join(', ')}`);
  for (const s of r.survivors) console.log(`幸存 ${s.snakeId}: 长度 ${s.body.length}${s.grew ? ' (增长)' : ''}`);
  if (r.consumedFood.length) console.log(`消费食物: ${r.consumedFood.map((p) => `(${p.x},${p.y})`).join(' ')}`);
}

// 1) 无食物：A 可进入 B 腾空的尾格 (3,1)
scenario('1. 无食物，A 跟进 B 腾空的尾格', baseState([
  { id: 'A', body: [{ x: 2, y: 1 }, { x: 1, y: 1 }], dir: 'right', alive: true },
  { id: 'B', body: [{ x: 4, y: 1 }, { x: 3, y: 1 }], dir: 'right', alive: true },
]), []);

// 2) (5,1) 有食物：B 拟增长保留尾，A 撞身体死亡
scenario('2. B 吃食物保留尾，A 撞 B 身体死亡', baseState([
  { id: 'A', body: [{ x: 2, y: 1 }, { x: 1, y: 1 }], dir: 'right', alive: true },
  { id: 'B', body: [{ x: 4, y: 1 }, { x: 3, y: 1 }], dir: 'right', alive: true },
], [{ x: 5, y: 1 }]), []);

// 3) 两头同格：全部死亡
scenario('3. 两头进入同一格，全部死亡', baseState([
  { id: 'A', body: [{ x: 1, y: 1 }], dir: 'right', alive: true },
  { id: 'B', body: [{ x: 3, y: 1 }], dir: 'left', alive: true },
]), []);

// 4) 长度一互换旧头格：全部死亡
scenario('4. 长度一互换旧头格，全部死亡', baseState([
  { id: 'A', body: [{ x: 1, y: 2 }], dir: 'right', alive: true },
  { id: 'B', body: [{ x: 2, y: 2 }], dir: 'left', alive: true },
]), []);

// 5) 进入自己的腾空尾格：合法
scenario('5. 进入自己腾空的尾格（合法）', baseState([
  { id: 'A', body: [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 2 }], dir: 'up', alive: true },
]), [{ snakeId: 'A', dir: 'right' } as never]);

store.close();
console.log(`\n演示数据库位于临时目录: ${tmp}`);
