export type Dir = 'up' | 'right' | 'down' | 'left';

export interface Point { x: number; y: number; }

export interface SnakeState {
  id: string;
  body: Point[]; // 头在前
  dir: Dir;
  alive: boolean;
}

export interface BoardState {
  width: number;
  height: number;
  walls: Point[];
  foods: Point[];
  snakes: SnakeState[];
  version: number; // 已完成 tick 数
}

export type DeathReason =
  | 'OUT_OF_BOUNDS'
  | 'WALL'
  | 'BODY'
  | 'HEAD_SWAP'
  | 'HEAD_TO_HEAD';

export interface Move { snakeId: string; dir: Dir; }

export interface DeathRecord {
  snakeId: string;
  reasons: DeathReason[];
  body: Point[];   // 死亡时旧身体快照
  target: Point;   // 本步目标头格
}

export interface TickResult {
  tick: number;
  deaths: DeathRecord[];
  survivors: { snakeId: string; body: Point[]; dir: Dir; grew: boolean }[];
  consumedFood: Point[];
  board: BoardState;
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

export const DIRS: Record<Dir, Point> = {
  up: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export const OPPOSITE: Record<Dir, Dir> = {
  up: 'down', down: 'up', left: 'right', right: 'left',
};

export const key = (p: Point) => `${p.x},${p.y}`;
export const samePt = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
