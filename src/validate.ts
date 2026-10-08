import { BoardState, Point, Snake, ApiError } from "./types";
import { isValidDir, key, LIMITS } from "./engine";

function isPoint(p: unknown): p is Point {
  return (
    !!p &&
    typeof (p as any).x === "number" &&
    typeof (p as any).y === "number" &&
    Number.isInteger((p as any).x) &&
    Number.isInteger((p as any).y)
  );
}

export function validateScenario(input: any): BoardState {
  if (!input || typeof input !== "object")
    throw new ApiError("VALIDATION_ERROR", "请求体必须是对象");
  const { width, height } = input;
  if (!Number.isInteger(width) || !Number.isInteger(height))
    throw new ApiError("VALIDATION_ERROR", "width/height 必须是整数");
  if (width < 1 || height < 1 || width > LIMITS.MAX_WIDTH || height > LIMITS.MAX_HEIGHT)
    throw new ApiError(
      "LIMIT_EXCEEDED",
      `棋盘尺寸须在 1..${LIMITS.MAX_WIDTH} x 1..${LIMITS.MAX_HEIGHT} 内`
    );

  const walls: Point[] = input.walls ?? [];
  const foods: Point[] = input.foods ?? [];
  const snakes: Snake[] = (input.snakes ?? []).map((s: any) => ({
    id: s?.id,
    dir: s?.dir,
    alive: true,
    body: s?.body,
  }));

  if (snakes.length > LIMITS.MAX_SNAKES)
    throw new ApiError("LIMIT_EXCEEDED", `蛇数量超过上限 ${LIMITS.MAX_SNAKES}`);

  const inBounds = (p: Point) =>
    p.x >= 0 && p.y >= 0 && p.x < width && p.y < height;

  const wallSet = new Set<string>();
  for (const w of walls) {
    if (!isPoint(w) || !inBounds(w))
      throw new ApiError("VALIDATION_ERROR", `墙格非法: ${JSON.stringify(w)}`);
    wallSet.add(key(w));
  }
  const foodSet = new Set<string>();
  for (const f of foods) {
    if (!isPoint(f) || !inBounds(f))
      throw new ApiError("VALIDATION_ERROR", `食物格非法: ${JSON.stringify(f)}`);
    if (wallSet.has(key(f)))
      throw new ApiError("VALIDATION_ERROR", `食物不能放在墙里: ${key(f)}`);
    foodSet.add(key(f));
  }

  const ids = new Set<string>();
  const occupied = new Map<string, string>();
  for (const s of snakes) {
    if (!s.id || typeof s.id !== "string")
      throw new ApiError("VALIDATION_ERROR", "蛇缺少唯一 ID");
    if (ids.has(s.id))
      throw new ApiError("VALIDATION_ERROR", `蛇 ID 重复: ${s.id}`);
    ids.add(s.id);
    if (!isValidDir(s.dir))
      throw new ApiError("INVALID_DIRECTION", `蛇 ${s.id} 方向非法`);
    if (!Array.isArray(s.body) || s.body.length < 1)
      throw new ApiError("VALIDATION_ERROR", `蛇 ${s.id} 身体为空`);
    if (s.body.length > LIMITS.MAX_SNAKE_LENGTH)
      throw new ApiError(
        "LIMIT_EXCEEDED",
        `蛇 ${s.id} 长度超过上限 ${LIMITS.MAX_SNAKE_LENGTH}`
      );
    const selfCells = new Set<string>();
    for (let i = 0; i < s.body.length; i++) {
      const c = s.body[i];
      if (!isPoint(c) || !inBounds(c))
        throw new ApiError("VALIDATION_ERROR", `蛇 ${s.id} 身体坐标非法: ${JSON.stringify(c)}`);
      const k = key(c);
      if (selfCells.has(k))
        throw new ApiError("VALIDATION_ERROR", `蛇 ${s.id} 身体自交于 ${k}`);
      selfCells.add(k);
      if (wallSet.has(k))
        throw new ApiError("VALIDATION_ERROR", `蛇 ${s.id} 压住墙格 ${k}`);
      if (foodSet.has(k))
        throw new ApiError("VALIDATION_ERROR", `蛇 ${s.id} 压住食物 ${k}`);
      if (occupied.has(k))
        throw new ApiError(
          "VALIDATION_ERROR",
          `蛇 ${s.id} 与蛇 ${occupied.get(k)} 在 ${k} 重叠`
        );
      occupied.set(k, s.id);
      if (i > 0) {
        const prev = s.body[i - 1];
        if (Math.abs(prev.x - c.x) + Math.abs(prev.y - c.y) !== 1)
          throw new ApiError("VALIDATION_ERROR", `蛇 ${s.id} 身体不连续`);
      }
    }
    if (s.body.length > 1) {
      const [h, neck] = s.body;
      const expect =
        h.x - neck.x === 1 ? "R" : h.x - neck.x === -1 ? "L" : h.y - neck.y === 1 ? "D" : "U";
      if (s.dir !== expect)
        throw new ApiError(
          "INVALID_DIRECTION",
          `蛇 ${s.id} 方向 ${s.dir} 与颈部指向头部方向 ${expect} 不一致`
        );
    }
  }

  return {
    width,
    height,
    walls,
    foods,
    snakes,
    version: 0,
    tick: 0,
  };
}
