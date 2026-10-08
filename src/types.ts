export type Dir = "U" | "R" | "D" | "L";

export interface Point {
  x: number;
  y: number;
}

export interface Snake {
  id: string;
  body: Point[]; // head first
  dir: Dir;
  alive: boolean;
}

export interface BoardState {
  width: number;
  height: number;
  walls: Point[];
  foods: Point[];
  snakes: Snake[];
  version: number;
  tick: number;
}

export type DeathReason =
  | "OUT_OF_BOUNDS"
  | "HIT_WALL"
  | "HIT_BODY"
  | "HEAD_ON"
  | "HEAD_SWAP";

export const DEATH_REASON_ORDER: DeathReason[] = [
  "OUT_OF_BOUNDS",
  "HIT_WALL",
  "HIT_BODY",
  "HEAD_ON",
  "HEAD_SWAP",
];

export interface Move {
  snakeId: string;
  dir: Dir;
}

export interface SnakeTickResult {
  snakeId: string;
  alive: boolean;
  dir: Dir;
  target: Point;
  grew: boolean;
  ateFood: boolean;
  deathReasons: DeathReason[];
  body: Point[]; // new body for survivors, old body for dead
}

export interface TickResult {
  tick: number;
  version: number;
  results: SnakeTickResult[];
  foods: Point[];
  board: string[];
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400
  ) {
    super(message);
  }
}
