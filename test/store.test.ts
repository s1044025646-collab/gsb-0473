import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Store } from "../src/store";
import { applyTick } from "../src/engine";
import { validateScenario } from "../src/validate";
import { BoardState, Move } from "../src/types";

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "snake-")), "test.db");
}

const demo = {
  width: 6,
  height: 4,
  snakes: [
    { id: "A", dir: "R", body: [{ x: 2, y: 1 }, { x: 1, y: 1 }] },
    { id: "B", dir: "R", body: [{ x: 4, y: 1 }, { x: 3, y: 1 }] },
  ],
};

function tickOnce(
  store: Store,
  id: string,
  requestId: string,
  moves: Move[],
  version = 0
) {
  const hash = JSON.stringify({ version, moves });
  return store.applyTickIdempotent(id, requestId, hash, () => {
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
  });
}

test("幂等：相同 requestId 相同内容返回原结果", () => {
  const store = new Store(tmpDb());
  store.createScenario("s1", validateScenario(demo));
  const r1 = tickOnce(store, "s1", "req-1", []);
  const r2 = tickOnce(store, "s1", "req-1", []);
  assert.equal(r1.replayed, false);
  assert.equal(r2.replayed, true);
  assert.deepEqual(r2.result, r1.result);
  assert.equal(store.loadState("s1").version, 1);
  store.close();
});

test("幂等：相同 requestId 不同内容报冲突", () => {
  const store = new Store(tmpDb());
  store.createScenario("s1", validateScenario(demo));
  tickOnce(store, "s1", "req-1", []);
  assert.throws(
    () => tickOnce(store, "s1", "req-1", [{ snakeId: "A", dir: "D" }]),
    /内容不同/
  );
  store.close();
});

test("失败 tick 不留部分状态（整体回滚）", () => {
  const store = new Store(tmpDb());
  store.createScenario("s1", validateScenario(demo));
  assert.throws(() =>
    tickOnce(store, "s1", "req-bad", [{ snakeId: "A", dir: "L" }])
  );
  const s = store.loadState("s1");
  assert.equal(s.version, 0);
  assert.equal(s.tick, 0);
  assert.deepEqual(s.snakes[0].body, [{ x: 2, y: 1 }, { x: 1, y: 1 }]);
  store.close();
});

test("重启后继续下一个 tick 与连续执行一致", () => {
  const db = tmpDb();
  const store1 = new Store(db);
  store1.createScenario("s1", validateScenario(demo));
  tickOnce(store1, "s1", "r1", []);
  store1.close();

  const store2 = new Store(db);
  const r = tickOnce(store2, "s1", "r2", []);
  assert.equal(r.result.tick, 2);
  assert.equal(r.result.version, 2);
  const a = r.result.results.find((x) => x.snakeId === "A")!;
  assert.deepEqual(a.body, [{ x: 4, y: 1 }, { x: 3, y: 1 }]);
  assert.ok(store2.getBoardAt("s1", 1).length === 4);
  assert.ok(store2.getReplay("s1").ticks.length === 2);
  store2.close();
});

test("死亡快照保存碰撞来源", () => {
  const store = new Store(tmpDb());
  store.createScenario("s1", validateScenario({ ...demo, foods: [{ x: 5, y: 1 }] }));
  tickOnce(store, "s1", "r1", []);
  const deaths = store.getDeaths("s1", "A");
  assert.equal(deaths.length, 1);
  assert.deepEqual(deaths[0].reasons, ["HIT_BODY"]);
  assert.deepEqual(deaths[0].target, { x: 3, y: 1 });
  store.close();
});
