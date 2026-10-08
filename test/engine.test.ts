import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { adjudicate } from '../src/engine';
import { Store } from '../src/store';
import { BoardState } from '../src/types';

function state(partial: Partial<BoardState>): BoardState {
  return { width: 6, height: 4, walls: [], foods: [], snakes: [], version: 0, ...partial };
}

test('无食物时 A 可进入 B 腾空的尾格', () => {
  const s = state({
    snakes: [
      { id: 'A', body: [{ x: 2, y: 1 }, { x: 1, y: 1 }], dir: 'right', alive: true },
      { id: 'B', body: [{ x: 4, y: 1 }, { x: 3, y: 1 }], dir: 'right', alive: true },
    ],
  });
  const r = adjudicate(s, []);
  assert.equal(r.deaths.length, 0);
  const a = r.survivors.find((x) => x.snakeId === 'A')!;
  assert.deepEqual(a.body[0], { x: 3, y: 1 });
  assert.equal(a.body.length, 2);
});

test('B 拟增长保留尾，A 撞身体死亡且食物仍被 B 消费', () => {
  const s = state({
    foods: [{ x: 5, y: 1 }],
    snakes: [
      { id: 'A', body: [{ x: 2, y: 1 }, { x: 1, y: 1 }], dir: 'right', alive: true },
      { id: 'B', body: [{ x: 4, y: 1 }, { x: 3, y: 1 }], dir: 'right', alive: true },
    ],
  });
  const r = adjudicate(s, []);
  assert.deepEqual(r.deaths.map((d) => d.snakeId), ['A']);
  assert.deepEqual(r.deaths[0].reasons, ['BODY']);
  const b = r.survivors.find((x) => x.snakeId === 'B')!;
  assert.equal(b.body.length, 3);
  assert.deepEqual(r.consumedFood, [{ x: 5, y: 1 }]);
  assert.equal(r.board.foods.length, 0);
});

test('两头同格全部死亡', () => {
  const s = state({
    snakes: [
      { id: 'A', body: [{ x: 1, y: 1 }], dir: 'right', alive: true },
      { id: 'B', body: [{ x: 3, y: 1 }], dir: 'left', alive: true },
    ],
  });
  const r = adjudicate(s, []);
  assert.equal(r.deaths.length, 2);
  for (const d of r.deaths) assert.ok(d.reasons.includes('HEAD_TO_HEAD'));
  assert.equal(r.board.snakes.every((x) => !x.alive), true);
});

test('长度一互换旧头格全部死亡', () => {
  const s = state({
    snakes: [
      { id: 'A', body: [{ x: 1, y: 2 }], dir: 'right', alive: true },
      { id: 'B', body: [{ x: 2, y: 2 }], dir: 'left', alive: true },
    ],
  });
  const r = adjudicate(s, []);
  assert.equal(r.deaths.length, 2);
  for (const d of r.deaths) assert.ok(d.reasons.includes('HEAD_SWAP'));
});

test('进入自己的腾空尾格合法', () => {
  const s = state({
    snakes: [
      { id: 'A', body: [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 2 }], dir: 'up', alive: true },
    ],
  });
  const r = adjudicate(s, [{ snakeId: 'A', dir: 'right' }]);
  assert.equal(r.deaths.length, 0);
  assert.deepEqual(r.survivors[0].body[0], { x: 3, y: 2 });
  assert.equal(r.survivors[0].body.length, 4);
});

test('撞墙与越界', () => {
  const s = state({
    walls: [{ x: 3, y: 0 }],
    snakes: [
      { id: 'A', body: [{ x: 2, y: 0 }], dir: 'right', alive: true },
      { id: 'B', body: [{ x: 0, y: 0 }], dir: 'left', alive: true },
    ],
  });
  const r = adjudicate(s, []);
  const a = r.deaths.find((d) => d.snakeId === 'A')!;
  const b = r.deaths.find((d) => d.snakeId === 'B')!;
  assert.deepEqual(a.reasons, ['WALL']);
  assert.deepEqual(b.reasons, ['OUT_OF_BOUNDS']);
});

test('死亡蛇的食物不消费', () => {
  // A 冲向食物但同时撞墙死亡（食物在墙上不可能，改用越界：目标既是食物又越界不可能，
  // 因此构造：A 目标有食物但与 B 同头，A 死亡，食物不被消费）
  const s = state({
    foods: [{ x: 2, y: 1 }],
    snakes: [
      { id: 'A', body: [{ x: 1, y: 1 }], dir: 'right', alive: true },
      { id: 'B', body: [{ x: 3, y: 1 }], dir: 'left', alive: true },
    ],
  });
  const r = adjudicate(s, []);
  assert.equal(r.deaths.length, 2);
  assert.equal(r.consumedFood.length, 0);
  assert.deepEqual(r.board.foods, [{ x: 2, y: 1 }]);
});

test('多死因按固定顺序记录（越界+同头）', () => {
  const s = state({
    walls: [{ x: 3, y: 0 }],
    snakes: [
      { id: 'A', body: [{ x: 2, y: 0 }], dir: 'right', alive: true },
      { id: 'B', body: [{ x: 4, y: 0 }], dir: 'left', alive: true },
    ],
  });
  // A、B 同时瞄准墙格 (3,0)：两者均记 WALL + HEAD_TO_HEAD，且顺序固定
  const r = adjudicate(s, []);
  assert.equal(r.deaths.length, 2);
  for (const d of r.deaths) assert.deepEqual(d.reasons, ['WALL', 'HEAD_TO_HEAD']);
});

function tmpStore(): { store: Store; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-test-'));
  const store = new Store(path.join(dir, 't.db'));
  return { store, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const demoState = (): BoardState => state({
  snakes: [
    { id: 'A', body: [{ x: 2, y: 1 }, { x: 1, y: 1 }], dir: 'right', alive: true },
    { id: 'B', body: [{ x: 4, y: 1 }, { x: 3, y: 1 }], dir: 'right', alive: true },
  ],
});

test('输入蛇顺序不影响结果', () => {
  const a = demoState();
  const b = demoState();
  b.snakes.reverse();
  const r1 = adjudicate(a, []);
  const r2 = adjudicate(b, []);
  const norm = (r: typeof r1) => JSON.stringify({
    deaths: [...r.deaths].sort((x, y) => x.snakeId.localeCompare(y.snakeId)),
    survivors: [...r.survivors].sort((x, y) => x.snakeId.localeCompare(y.snakeId)),
    foods: r.board.foods,
  });
  assert.equal(norm(r1), norm(r2));
});

test('非法反向整体回滚，状态不变', () => {
  const { store, cleanup } = tmpStore();
  store.createBoard('b1', demoState());
  assert.throws(
    () => store.submitTick('b1', 'r1', 0, [{ snakeId: 'A', dir: 'left' }]),
    /反向/,
  );
  const after = store.getBoard('b1');
  assert.equal(after.version, 0);
  assert.deepEqual(after.snakes.find((s) => s.id === 'A')!.body[0], { x: 2, y: 1 });
  cleanup();
});

test('错误版本拒绝', () => {
  const { store, cleanup } = tmpStore();
  store.createBoard('b2', demoState());
  assert.throws(() => store.submitTick('b2', 'r1', 5, []), /版本过期/);
  cleanup();
});

test('幂等：同 requestId 同内容返回原结果，内容改变报冲突', () => {
  const { store, cleanup } = tmpStore();
  store.createBoard('b3', demoState());
  const first = store.submitTick('b3', 'req-1', 0, []);
  const again = store.submitTick('b3', 'req-1', 0, []);
  assert.deepEqual(again, first);
  assert.equal(store.getBoard('b3').version, 1); // 未重复推进
  assert.throws(
    () => store.submitTick('b3', 'req-1', 0, [{ snakeId: 'A', dir: 'up' }]),
    /内容不同/,
  );
  cleanup();
});

test('重启后继续下一个 tick 与连续执行一致', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-test-'));
  const db = path.join(dir, 't.db');
  const s1 = new Store(db);
  s1.createBoard('b4', demoState());
  s1.submitTick('b4', 'r1', 0, []);
  s1.close();
  const s2 = new Store(db); // 模拟重启
  const r = s2.submitTick('b4', 'r2', 1, []);
  assert.equal(r[0].tick, 2);
  assert.equal(s2.getBoard('b4').version, 2);
  // 历史棋盘可读
  assert.equal(s2.getTickBoard('b4', 0).version, 0);
  assert.equal(s2.getTickBoard('b4', 1).version, 1);
  s2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('批量步数上限与部分失败整体回滚', () => {
  const { store, cleanup } = tmpStore();
  store.createBoard('b5', demoState());
  assert.throws(() => store.submitTick('b5', 'r1', 0, [], 100), /批量步数/);
  assert.equal(store.getBoard('b5').version, 0);
  const rs = store.submitTick('b5', 'r2', 0, [], 3);
  assert.equal(rs.length, 3);
  assert.equal(store.getBoard('b5').version, 3);
  cleanup();
});

test('食物不能放进活蛇或墙', () => {
  const { store, cleanup } = tmpStore();
  const st = demoState();
  st.walls = [{ x: 0, y: 0 }];
  store.createBoard('b6', st);
  assert.throws(() => store.addFood('b6', { x: 2, y: 1 }), /活蛇/);
  assert.throws(() => store.addFood('b6', { x: 0, y: 0 }), /墙/);
  store.addFood('b6', { x: 5, y: 3 });
  assert.equal(store.getBoard('b6').foods.length, 1);
  cleanup();
});

test('死蛇不能再提交移动', () => {
  const { store, cleanup } = tmpStore();
  const st = state({ snakes: [{ id: 'A', body: [{ x: 0, y: 0 }], dir: 'left', alive: true }] });
  store.createBoard('b7', st);
  store.submitTick('b7', 'r1', 0, []);
  assert.throws(() => store.submitTick('b7', 'r2', 1, [{ snakeId: 'A', dir: 'up' }]), /已死亡/);
  cleanup();
});

test('未知蛇 ID 拒绝', () => {
  const { store, cleanup } = tmpStore();
  store.createBoard('b8', demoState());
  assert.throws(() => store.submitTick('b8', 'r1', 0, [{ snakeId: 'ZZ', dir: 'up' }]), /未知蛇/);
  cleanup();
});

test('碰撞来源查询与回放导出', () => {
  const { store, cleanup } = tmpStore();
  const st = state({
    foods: [{ x: 5, y: 1 }],
    snakes: [
      { id: 'A', body: [{ x: 2, y: 1 }, { x: 1, y: 1 }], dir: 'right', alive: true },
      { id: 'B', body: [{ x: 4, y: 1 }, { x: 3, y: 1 }], dir: 'right', alive: true },
    ],
  });
  store.createBoard('b9', st);
  store.submitTick('b9', 'r1', 0, []);
  const col = store.getSnakeCollision('b9', 'A')!;
  assert.equal(col.tick, 1);
  const replay = store.exportReplay('b9');
  assert.equal(replay.ticks.length, 2); // tick 0 快照 + tick 1
  assert.equal(replay.ticks[1].result!.deaths[0].snakeId, 'A');
  cleanup();
});
