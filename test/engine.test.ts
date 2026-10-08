import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTick, renderBoard } from "../src/engine";
import { validateScenario } from "../src/validate";
import { BoardState } from "../src/types";

function scenario(input: any): BoardState {
  return validateScenario(input);
}

const baseDemo = {
  width: 6,
  height: 4,
  snakes: [
    { id: "A", dir: "R", body: [{ x: 2, y: 1 }, { x: 1, y: 1 }] },
    { id: "B", dir: "R", body: [{ x: 4, y: 1 }, { x: 3, y: 1 }] },
  ],
};

test("无食物时 A 可进入 B 腾空的尾格 (3,1)", () => {
  const r = applyTick(scenario(baseDemo), []);
  const a = r.results.find((x) => x.snakeId === "A")!;
  const b = r.results.find((x) => x.snakeId === "B")!;
  assert.ok(a.alive);
  assert.ok(b.alive);
  assert.deepEqual(a.body, [{ x: 3, y: 1 }, { x: 2, y: 1 }]);
  assert.deepEqual(b.body, [{ x: 5, y: 1 }, { x: 4, y: 1 }]);
});

test("(5,1) 有食物时 B 拟增长保留尾，A 撞身体死亡且食物被 B 消费", () => {
  const r = applyTick(scenario({ ...baseDemo, foods: [{ x: 5, y: 1 }] }), []);
  const a = r.results.find((x) => x.snakeId === "A")!;
  const b = r.results.find((x) => x.snakeId === "B")!;
  assert.ok(!a.alive);
  assert.deepEqual(a.deathReasons, ["HIT_BODY"]);
  assert.ok(b.alive);
  assert.equal(b.body.length, 3);
  assert.deepEqual(r.foods, []);
});

test("输入蛇顺序不影响裁决结果", () => {
  const s1 = scenario(baseDemo);
  const s2 = scenario({ ...baseDemo, snakes: [...baseDemo.snakes].reverse() });
  const r1 = applyTick(s1, []);
  const r2 = applyTick(s2, []);
  const norm = (r: typeof r1) =>
    r.results
      .map((x) => ({ ...x }))
      .sort((a, b) => a.snakeId.localeCompare(b.snakeId));
  assert.deepEqual(norm(r1), norm(r2));
  assert.deepEqual(r1.board, r2.board);
});

test("两头进入同一目标格全部死亡", () => {
  const r = applyTick(
    scenario({
      width: 6,
      height: 4,
      snakes: [
        { id: "A", dir: "R", body: [{ x: 1, y: 1 }] },
        { id: "B", dir: "L", body: [{ x: 3, y: 1 }] },
      ],
    }),
    []
  );
  for (const x of r.results) {
    assert.ok(!x.alive);
    assert.ok(x.deathReasons.includes("HEAD_ON"));
  }
});

test("长度一互换旧头格全部死亡（HEAD_SWAP）", () => {
  const r = applyTick(
    scenario({
      width: 6,
      height: 4,
      snakes: [
        { id: "A", dir: "R", body: [{ x: 1, y: 1 }] },
        { id: "B", dir: "L", body: [{ x: 2, y: 1 }] },
      ],
    }),
    []
  );
  for (const x of r.results) {
    assert.ok(!x.alive);
    assert.ok(x.deathReasons.includes("HEAD_SWAP"));
  }
});

test("进入自己本步腾空的尾格合法", () => {
  const r = applyTick(
    scenario({
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
  const a = r.results[0];
  assert.ok(a.alive);
  assert.deepEqual(a.body, [
    { x: 3, y: 1 },
    { x: 2, y: 1 },
    { x: 2, y: 0 },
    { x: 3, y: 0 },
  ]);
});

test("死亡蛇目标上的食物不被消费", () => {
  const r = applyTick(
    scenario({
      width: 6,
      height: 4,
      foods: [{ x: 2, y: 1 }],
      snakes: [
        { id: "A", dir: "R", body: [{ x: 1, y: 1 }] },
        { id: "B", dir: "L", body: [{ x: 3, y: 1 }] },
      ],
    }),
    []
  );
  assert.ok(r.results.every((x) => !x.alive));
  assert.deepEqual(r.foods, [{ x: 2, y: 1 }]);
});

test("非法反向整体拒绝，状态不变", () => {
  const s = scenario(baseDemo);
  assert.throws(
    () => applyTick(s, [{ snakeId: "A", dir: "L" }]),
    /禁止直接反向/
  );
  assert.equal(s.version, 0);
  assert.deepEqual(s.snakes[0].body, [{ x: 2, y: 1 }, { x: 1, y: 1 }]);
});

test("未知蛇 ID 与非法方向被拒绝", () => {
  const s = scenario(baseDemo);
  assert.throws(() => applyTick(s, [{ snakeId: "Z", dir: "R" }]), /未知或已死亡/);
  assert.throws(
    () => applyTick(s, [{ snakeId: "A", dir: "X" as any }]),
    /非法方向/
  );
});

test("越界与撞墙按固定顺序记录多个死因", () => {
  const r = applyTick(
    scenario({
      width: 3,
      height: 3,
      walls: [{ x: 2, y: 0 }],
      snakes: [
        { id: "A", dir: "R", body: [{ x: 1, y: 0 }] },
        { id: "B", dir: "U", body: [{ x: 2, y: 1 }] },
      ],
    }),
    []
  );
  const a = r.results.find((x) => x.snakeId === "A")!;
  const b = r.results.find((x) => x.snakeId === "B")!;
  assert.deepEqual(a.deathReasons, ["HIT_WALL", "HEAD_ON"]);
  assert.deepEqual(b.deathReasons, ["HIT_WALL", "HEAD_ON"]);
});

test("越界死亡记录 OUT_OF_BOUNDS", () => {
  const r = applyTick(
    scenario({
      width: 3,
      height: 3,
      snakes: [{ id: "A", dir: "U", body: [{ x: 1, y: 0 }] }],
    }),
    []
  );
  assert.deepEqual(r.results[0].deathReasons, ["OUT_OF_BOUNDS"]);
});

test("缺省方向沿用当前方向", () => {
  const r = applyTick(scenario(baseDemo), [{ snakeId: "A", dir: "D" }]);
  const b = r.results.find((x) => x.snakeId === "B")!;
  assert.equal(b.dir, "R");
  assert.deepEqual(b.body[0], { x: 5, y: 1 });
});

test("字符棋盘渲染", () => {
  const board = renderBoard(scenario(baseDemo));
  assert.deepEqual(board, ["......", ".aAbB.", "......", "......"]);
});
