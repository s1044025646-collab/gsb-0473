import {
  ApiError, BoardState, DeathReason, DeathRecord, Dir, DIRS, Move,
  OPPOSITE, Point, SnakeState, TickResult, key, samePt,
} from './types';

export const LIMITS = {
  MAX_WIDTH: 64,
  MAX_HEIGHT: 64,
  MAX_SNAKES: 32,
  MAX_SNAKE_LEN: 256,
  MAX_STEPS: 64,
};

export function isDir(d: unknown): d is Dir {
  return d === 'up' || d === 'right' || d === 'down' || d === 'left';
}

function inBounds(state: BoardState, p: Point): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < state.width && p.y < state.height;
}

/** 校验导入局面：连续四邻接、不自交、不重叠、不压墙/食物、方向与颈部一致。 */
export function validateBoard(state: BoardState): void {
  if (!Number.isInteger(state.width) || !Number.isInteger(state.height)
    || state.width < 1 || state.height < 1
    || state.width > LIMITS.MAX_WIDTH || state.height > LIMITS.MAX_HEIGHT) {
    throw new ApiError('LIMIT_EXCEEDED',
      `棋盘尺寸须在 1..${LIMITS.MAX_WIDTH} x 1..${LIMITS.MAX_HEIGHT} 之间`, 422);
  }
  for (const w of state.walls) {
    if (!inBounds(state, w)) throw new ApiError('VALIDATION', `墙格越界: ${key(w)}`, 422);
  }
  const wallSet = new Set(state.walls.map(key));
  const foodSet = new Set<string>();
  for (const f of state.foods) {
    if (!inBounds(state, f)) throw new ApiError('VALIDATION', `食物越界: ${key(f)}`, 422);
    if (wallSet.has(key(f))) throw new ApiError('VALIDATION', `食物压在墙上: ${key(f)}`, 422);
    if (foodSet.has(key(f))) throw new ApiError('VALIDATION', `食物重复: ${key(f)}`, 422);
    foodSet.add(key(f));
  }
  if (state.snakes.length > LIMITS.MAX_SNAKES) {
    throw new ApiError('LIMIT_EXCEEDED', `蛇数量超过上限 ${LIMITS.MAX_SNAKES}`, 422);
  }
  const ids = new Set<string>();
  const occupied = new Map<string, string>();
  for (const s of state.snakes) {
    if (!s.id || ids.has(s.id)) throw new ApiError('VALIDATION', `蛇 ID 缺失或重复: ${s.id}`, 422);
    ids.add(s.id);
    if (!isDir(s.dir)) throw new ApiError('INVALID_DIRECTION', `非法方向: ${s.dir}`, 422);
    if (!Array.isArray(s.body) || s.body.length < 1) {
      throw new ApiError('VALIDATION', `蛇 ${s.id} 身体为空`, 422);
    }
    if (s.body.length > LIMITS.MAX_SNAKE_LEN) {
      throw new ApiError('LIMIT_EXCEEDED', `蛇 ${s.id} 长度超过上限 ${LIMITS.MAX_SNAKE_LEN}`, 422);
    }
    const selfSet = new Set<string>();
    for (let i = 0; i < s.body.length; i++) {
      const c = s.body[i];
      if (!inBounds(state, c)) throw new ApiError('VALIDATION', `蛇 ${s.id} 身体越界: ${key(c)}`, 422);
      if (wallSet.has(key(c))) throw new ApiError('VALIDATION', `蛇 ${s.id} 压住墙: ${key(c)}`, 422);
      if (foodSet.has(key(c))) throw new ApiError('VALIDATION', `蛇 ${s.id} 压住食物: ${key(c)}`, 422);
      if (selfSet.has(key(c))) throw new ApiError('VALIDATION', `蛇 ${s.id} 身体自交: ${key(c)}`, 422);
      selfSet.add(key(c));
      const other = occupied.get(key(c));
      if (other !== undefined) {
        throw new ApiError('VALIDATION', `蛇 ${s.id} 与蛇 ${other} 身体重叠: ${key(c)}`, 422);
      }
      occupied.set(key(c), s.id);
      if (i > 0) {
        const prev = s.body[i - 1];
        if (Math.abs(prev.x - c.x) + Math.abs(prev.y - c.y) !== 1) {
          throw new ApiError('VALIDATION', `蛇 ${s.id} 身体不连续: ${key(prev)} -> ${key(c)}`, 422);
        }
      }
    }
    if (s.body.length > 1) {
      const neck = s.body[1];
      const head = s.body[0];
      const neckToHead: Point = { x: head.x - neck.x, y: head.y - neck.y };
      const d = DIRS[s.dir];
      if (neckToHead.x !== d.x || neckToHead.y !== d.y) {
        throw new ApiError('VALIDATION',
          `蛇 ${s.id} 方向与颈部指向头部方向不一致`, 422);
      }
    }
  }
}

/**
 * 同步裁决一个 tick。所有判定基于同一个旧状态。
 * 调用前须已完成版本/幂等校验；本函数纯计算，不写库。
 */
export function adjudicate(state: BoardState, moves: Move[]): TickResult {
  const alive = state.snakes.filter((s) => s.alive);
  const moveMap = new Map<string, Dir>();
  for (const m of moves) {
    if (!isDir(m.dir)) throw new ApiError('INVALID_DIRECTION', `非法方向: ${m.dir}`, 400);
    const snake = state.snakes.find((s) => s.id === m.snakeId);
    if (!snake) throw new ApiError('UNKNOWN_SNAKE', `未知蛇 ID: ${m.snakeId}`, 400);
    if (!snake.alive) throw new ApiError('DEAD_SNAKE', `蛇 ${m.snakeId} 已死亡，不能提交移动`, 400);
    if (moveMap.has(m.snakeId)) throw new ApiError('VALIDATION', `蛇 ${m.snakeId} 重复提交方向`, 400);
    if (snake.body.length > 1 && m.dir === OPPOSITE[snake.dir]) {
      throw new ApiError('REVERSE_DIRECTION', `蛇 ${m.snakeId} 禁止直接反向`, 400);
    }
    moveMap.set(m.snakeId, m.dir);
  }

  const foodSet = new Set(state.foods.map(key));
  const wallSet = new Set(state.walls.map(key));

  // 1) 统一计算目标头格与拟增长（死亡裁决之前确定，之后不可更改）
  const plans = new Map<string, { dir: Dir; target: Point; grow: boolean }>();
  for (const s of alive) {
    const dir = moveMap.get(s.id) ?? s.dir;
    const d = DIRS[dir];
    const target = { x: s.body[0].x + d.x, y: s.body[0].y + d.y };
    const grow = foodSet.has(key(target));
    plans.set(s.id, { dir, target, grow });
  }

  // 2) 旧状态占用表：删除本步将腾空的尾格（拟移动且非增长者）
  const occupied = new Map<string, string>(); // cell -> snakeId
  for (const s of alive) {
    const plan = plans.get(s.id)!;
    const keep = plan.grow ? s.body.length : s.body.length - 1;
    for (let i = 0; i < keep; i++) occupied.set(key(s.body[i]), s.id);
  }

  // 3) 碰撞裁决（每条蛇可多个死因，固定顺序记录）
  const reasons = new Map<string, DeathReason[]>();
  const addReason = (id: string, r: DeathReason) => {
    const list = reasons.get(id) ?? [];
    if (!list.includes(r)) list.push(r);
    reasons.set(id, list);
  };
  for (const s of alive) {
    const { target } = plans.get(s.id)!;
    if (!inBounds(state, target)) addReason(s.id, 'OUT_OF_BOUNDS');
    else if (wallSet.has(key(target))) addReason(s.id, 'WALL');
    if (occupied.has(key(target))) addReason(s.id, 'BODY');
  }
  // 互换旧头格：A 目标 == B 旧头 且 B 目标 == A 旧头
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i]; const b = alive[j];
      const ta = plans.get(a.id)!.target; const tb = plans.get(b.id)!.target;
      if (samePt(ta, b.body[0]) && samePt(tb, a.body[0])) {
        addReason(a.id, 'HEAD_SWAP');
        addReason(b.id, 'HEAD_SWAP');
      }
    }
  }
  // 多头同格：全部死亡
  const byTarget = new Map<string, string[]>();
  for (const s of alive) {
    const k = key(plans.get(s.id)!.target);
    byTarget.set(k, [...(byTarget.get(k) ?? []), s.id]);
  }
  for (const ids of byTarget.values()) {
    if (ids.length > 1) for (const id of ids) addReason(id, 'HEAD_TO_HEAD');
  }

  // 4) 幸存者提交新身体；死亡蛇整体移出并记录快照
  const deaths: DeathRecord[] = [];
  const survivors: TickResult['survivors'] = [];
  const consumedFood: Point[] = [];
  const newSnakes: SnakeState[] = [];
  for (const s of state.snakes) {
    if (!s.alive) { newSnakes.push(s); continue; }
    const plan = plans.get(s.id)!;
    const rs = reasons.get(s.id);
    if (rs && rs.length > 0) {
      const order: DeathReason[] = ['OUT_OF_BOUNDS', 'WALL', 'BODY', 'HEAD_SWAP', 'HEAD_TO_HEAD'];
      deaths.push({
        snakeId: s.id,
        reasons: order.filter((r) => rs.includes(r)),
        body: s.body.map((p) => ({ ...p })),
        target: plan.target,
      });
      newSnakes.push({ ...s, dir: plan.dir, alive: false });
      continue;
    }
    const newBody = plan.grow
      ? [plan.target, ...s.body]
      : [plan.target, ...s.body.slice(0, -1)];
    if (plan.grow) consumedFood.push(plan.target);
    survivors.push({ snakeId: s.id, body: newBody, dir: plan.dir, grew: plan.grow });
    newSnakes.push({ id: s.id, body: newBody, dir: plan.dir, alive: true });
  }
  const consumedSet = new Set(consumedFood.map(key));
  const newFoods = state.foods.filter((f) => !consumedSet.has(key(f)));

  const board: BoardState = {
    width: state.width, height: state.height,
    walls: state.walls, foods: newFoods, snakes: newSnakes,
    version: state.version + 1,
  };
  return { tick: board.version, deaths, survivors, consumedFood, board };
}
