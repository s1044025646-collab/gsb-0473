import {
  BoardState,
  DeathReason,
  DEATH_REASON_ORDER,
  Dir,
  Move,
  Point,
  SnakeTickResult,
  TickResult,
  ApiError,
} from "./types";

export const LIMITS = {
  MAX_WIDTH: 64,
  MAX_HEIGHT: 64,
  MAX_SNAKES: 32,
  MAX_SNAKE_LENGTH: 512,
  MAX_MOVES_PER_TICK: 64,
  MAX_BATCH_TICKS: 1000,
};

export const DIRS: Record<Dir, Point> = {
  U: { x: 0, y: -1 },
  R: { x: 1, y: 0 },
  D: { x: 0, y: 1 },
  L: { x: -1, y: 0 },
};

const OPPOSITE: Record<Dir, Dir> = { U: "D", D: "U", L: "R", R: "L" };

export const key = (p: Point) => `${p.x},${p.y}`;

export function isValidDir(d: unknown): d is Dir {
  return d === "U" || d === "R" || d === "D" || d === "L";
}

export function validateMoves(
  state: BoardState,
  moves: Move[]
): Map<string, Dir> {
  if (!Array.isArray(moves)) {
    throw new ApiError("VALIDATION_ERROR", "moves 必须是数组");
  }
  if (moves.length > LIMITS.MAX_MOVES_PER_TICK) {
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `单次 tick 方向变更数量超过上限 ${LIMITS.MAX_MOVES_PER_TICK}`
    );
  }
  const aliveById = new Map(state.snakes.filter((s) => s.alive).map((s) => [s.id, s]));
  const dirById = new Map<string, Dir>();
  for (const m of moves) {
    if (!m || typeof m.snakeId !== "string") {
      throw new ApiError("VALIDATION_ERROR", "move 缺少 snakeId");
    }
    if (!isValidDir(m.dir)) {
      throw new ApiError("INVALID_DIRECTION", `非法方向: ${String(m.dir)}`);
    }
    const snake = aliveById.get(m.snakeId);
    if (!snake) {
      throw new ApiError("UNKNOWN_SNAKE", `未知或已死亡的蛇: ${m.snakeId}`);
    }
    if (dirById.has(m.snakeId)) {
      throw new ApiError("VALIDATION_ERROR", `同一蛇重复提交方向: ${m.snakeId}`);
    }
    if (snake.body.length > 1 && m.dir === OPPOSITE[snake.dir]) {
      throw new ApiError(
        "INVALID_DIRECTION",
        `蛇 ${m.snakeId} 长度大于一，禁止直接反向`
      );
    }
    dirById.set(m.snakeId, m.dir);
  }
  return dirById;
}

/**
 * 同步裁决：所有蛇基于同一个旧状态同时移动一格。
 * 纯函数，不修改传入的 state。
 */
export function applyTick(state: BoardState, moves: Move[]): TickResult {
  const dirById = validateMoves(state, moves);
  const wallSet = new Set(state.walls.map(key));
  const foodSet = new Set(state.foods.map(key));
  const alive = state.snakes.filter((s) => s.alive);

  // 1. 为所有活蛇计算目标头格与拟增长（尾格保留）标记。
  interface Plan {
    id: string;
    dir: Dir;
    target: Point;
    grow: boolean;
    oldBody: Point[];
  }
  const plans: Plan[] = alive.map((s) => {
    const dir = dirById.get(s.id) ?? s.dir;
    const d = DIRS[dir];
    const head = s.body[0];
    const target = { x: head.x + d.x, y: head.y + d.y };
    return { id: s.id, dir, target, grow: foodSet.has(key(target)), oldBody: s.body };
  });

  // 2. 身体占用表：旧身体减去本步将腾空的尾格。在死亡裁决之前统一确定。
  const occupancy = new Map<string, string>(); // cell -> snakeId
  for (const p of plans) {
    const cells = p.grow ? p.oldBody : p.oldBody.slice(0, -1);
    for (const c of cells) occupancy.set(key(c), p.id);
  }

  // 3. 目标格统计（同头）与互换检测。
  const targetCount = new Map<string, number>();
  for (const p of plans) {
    const k = key(p.target);
    targetCount.set(k, (targetCount.get(k) ?? 0) + 1);
  }
  const oldHead = new Map(plans.map((p) => [p.id, key(p.oldBody[0])]));
  const targetById = new Map(plans.map((p) => [p.id, key(p.target)]));
  const swapPairs = new Set<string>();
  for (const a of plans) {
    for (const b of plans) {
      if (a.id >= b.id) continue;
      if (
        targetById.get(a.id) === oldHead.get(b.id) &&
        targetById.get(b.id) === oldHead.get(a.id)
      ) {
        swapPairs.add(a.id);
        swapPairs.add(b.id);
      }
    }
  }

  // 4. 汇总每条蛇的全部死亡原因，按固定顺序记录。
  const results: SnakeTickResult[] = [];
  for (const p of plans) {
    const reasons = new Set<DeathReason>();
    const t = p.target;
    if (t.x < 0 || t.y < 0 || t.x >= state.width || t.y >= state.height) {
      reasons.add("OUT_OF_BOUNDS");
    } else if (wallSet.has(key(t))) {
      reasons.add("HIT_WALL");
    }
    if (occupancy.has(key(t))) reasons.add("HIT_BODY");
    if ((targetCount.get(key(t)) ?? 0) > 1) reasons.add("HEAD_ON");
    if (swapPairs.has(p.id)) reasons.add("HEAD_SWAP");
    const ordered = DEATH_REASON_ORDER.filter((r) => reasons.has(r));
    const died = ordered.length > 0;
    results.push({
      snakeId: p.id,
      alive: !died,
      dir: p.dir,
      target: t,
      grew: !died && p.grow,
      ateFood: !died && p.grow,
      deathReasons: ordered,
      body: died
        ? p.oldBody
        : p.grow
          ? [t, ...p.oldBody]
          : [t, ...p.oldBody.slice(0, -1)],
    });
  }

  // 5. 只有幸存者消费目标食物。
  const consumed = new Set(
    results.filter((r) => r.ateFood).map((r) => key(r.target))
  );
  const foods = state.foods.filter((f) => !consumed.has(key(f)));

  const nextState: BoardState = {
    ...state,
    foods,
    version: state.version + 1,
    tick: state.tick + 1,
    snakes: state.snakes.map((s) => {
      const r = results.find((x) => x.snakeId === s.id);
      if (!r) return s;
      return { ...s, alive: r.alive, dir: r.dir, body: r.body };
    }),
  };

  return {
    tick: nextState.tick,
    version: nextState.version,
    results,
    foods,
    board: renderBoard(nextState),
  };
}

export function renderBoard(state: BoardState): string[] {
  const grid: string[][] = Array.from({ length: state.height }, () =>
    Array.from({ length: state.width }, () => ".")
  );
  for (const w of state.walls) grid[w.y][w.x] = "#";
  for (const f of state.foods) grid[f.y][f.x] = "*";
  for (const s of state.snakes) {
    if (!s.alive) continue;
    s.body.forEach((c, i) => {
      grid[c.y][c.x] = i === 0 ? s.id[0].toUpperCase() : s.id[0].toLowerCase();
    });
  }
  return grid.map((row) => row.join(""));
}
