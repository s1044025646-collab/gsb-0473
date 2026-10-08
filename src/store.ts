import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { adjudicate, validateBoard, LIMITS } from './engine';
import { ApiError, BoardState, Move, Point, TickResult } from './types';

const DATA_DIR = process.env.SNAKE_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = process.env.SNAKE_DB ?? path.join(DATA_DIR, 'snake.db');

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS boards (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ticks (
        board_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        board TEXT NOT NULL,
        PRIMARY KEY (board_id, tick)
      );
      CREATE TABLE IF NOT EXISTS requests (
        board_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        tick INTEGER NOT NULL,
        PRIMARY KEY (board_id, request_id)
      );
    `);
  }

  close(): void { this.db.close(); }

  createBoard(id: string, state: BoardState): BoardState {
    validateBoard(state);
    const exists = this.db.prepare('SELECT 1 FROM boards WHERE id = ?').get(id);
    if (exists) throw new ApiError('CONFLICT', `场景 ${id} 已存在`, 409);
    this.db.prepare('INSERT INTO boards (id, state) VALUES (?, ?)')
      .run(id, JSON.stringify(state));
    this.saveSnapshot(id, 0, 'bootstrap', state);
    return state;
  }

  getBoard(id: string): BoardState {
    const row = this.db.prepare('SELECT state FROM boards WHERE id = ?').get(id) as
      | { state: string } | undefined;
    if (!row) throw new ApiError('NOT_FOUND', `场景 ${id} 不存在`, 404);
    return JSON.parse(row.state) as BoardState;
  }

  /** 导入局面：整体替换指定场景的当前状态（版本归零，清空历史）。 */
  importBoard(id: string, state: BoardState): BoardState {
    validateBoard(state);
    const tx = this.db.prepare('SELECT 1 FROM boards WHERE id = ?').get(id);
    this.db.exec('BEGIN');
    try {
      if (tx) {
        this.db.prepare('UPDATE boards SET state = ? WHERE id = ?')
          .run(JSON.stringify(state), id);
        this.db.prepare('DELETE FROM ticks WHERE board_id = ?').run(id);
        this.db.prepare('DELETE FROM requests WHERE board_id = ?').run(id);
      } else {
        this.db.prepare('INSERT INTO boards (id, state) VALUES (?, ?)')
          .run(id, JSON.stringify(state));
      }
      this.saveSnapshot(id, 0, 'bootstrap', state);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    return state;
  }

  private saveSnapshot(boardId: string, tick: number, requestId: string, state: BoardState,
    result?: TickResult, requestHash: string = ''): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO ticks (board_id, tick, request_id, request_hash, result, board) VALUES (?,?,?,?,?,?)',
    ).run(boardId, tick, requestId, requestHash,
      JSON.stringify(result ?? null), JSON.stringify(state));
  }

  addFood(id: string, p: Point): BoardState {
    const state = this.getBoard(id);
    if (!Number.isInteger(p.x) || !Number.isInteger(p.y)
      || p.x < 0 || p.y < 0 || p.x >= state.width || p.y >= state.height) {
      throw new ApiError('VALIDATION', `食物坐标越界: ${p.x},${p.y}`, 422);
    }
    if (state.walls.some((w) => w.x === p.x && w.y === p.y)) {
      throw new ApiError('VALIDATION', '不能把食物放进墙里', 422);
    }
    for (const s of state.snakes) {
      if (s.alive && s.body.some((c) => c.x === p.x && c.y === p.y)) {
        throw new ApiError('VALIDATION', '不能把食物放进活蛇身体', 422);
      }
    }
    if (state.foods.some((f) => f.x === p.x && f.y === p.y)) {
      throw new ApiError('CONFLICT', '该格已有食物', 409);
    }
    state.foods.push({ x: p.x, y: p.y });
    this.db.prepare('UPDATE boards SET state = ? WHERE id = ?')
      .run(JSON.stringify(state), id);
    return state;
  }

  private hashPayload(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /** 提交 tick：版本校验 + 幂等 + 事务落库。 */
  submitTick(id: string, requestId: string, version: number, moves: Move[], steps = 1): TickResult[] {
    if (!requestId) throw new ApiError('VALIDATION', '缺少 requestId', 400);
    if (!Number.isInteger(steps) || steps < 1 || steps > LIMITS.MAX_STEPS) {
      throw new ApiError('LIMIT_EXCEEDED', `批量步数须在 1..${LIMITS.MAX_STEPS} 之间`, 422);
    }
    const requestHash = this.hashPayload({ version, moves, steps });

    const existing = this.db.prepare(
      'SELECT request_hash, tick FROM requests WHERE board_id = ? AND request_id = ?',
    ).get(id, requestId) as { request_hash: string; tick: number } | undefined;
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ApiError('REQUEST_CONFLICT',
          `请求 ID ${requestId} 已使用且内容不同`, 409);
      }
      // 幂等重放：返回原结果
      const rows = this.db.prepare(
        'SELECT result FROM ticks WHERE board_id = ? AND tick BETWEEN ? AND ? ORDER BY tick',
      ).all(id, existing.tick, existing.tick + steps - 1) as { result: string }[];
      return rows.map((r) => JSON.parse(r.result) as TickResult);
    }

    const state = this.getBoard(id);
    if (version !== state.version) {
      throw new ApiError('VERSION_CONFLICT',
        `版本过期: 期望 ${state.version}, 收到 ${version}`, 409);
    }

    this.db.exec('BEGIN');
    try {
      let cur = state;
      const results: TickResult[] = [];
      for (let i = 0; i < steps; i++) {
        const result = adjudicate(cur, i === 0 ? moves : []);
        this.saveSnapshot(id, result.tick, requestId, result.board, result, requestHash);
        results.push(result);
        cur = result.board;
      }
      this.db.prepare('UPDATE boards SET state = ? WHERE id = ?')
        .run(JSON.stringify(cur), id);
      this.db.prepare(
        'INSERT INTO requests (board_id, request_id, request_hash, tick) VALUES (?,?,?,?)',
      ).run(id, requestId, requestHash, results[0].tick);
      this.db.exec('COMMIT');
      return results;
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }

  getTickBoard(id: string, tick: number): BoardState {
    const row = this.db.prepare(
      'SELECT board FROM ticks WHERE board_id = ? AND tick = ?',
    ).get(id, tick) as { board: string } | undefined;
    if (!row) throw new ApiError('NOT_FOUND', `场景 ${id} 没有 tick ${tick} 的棋盘`, 404);
    return JSON.parse(row.board) as BoardState;
  }

  getTickResult(id: string, tick: number): TickResult | null {
    const row = this.db.prepare(
      'SELECT result FROM ticks WHERE board_id = ? AND tick = ?',
    ).get(id, tick) as { result: string } | undefined;
    if (!row || row.result === 'null') return null;
    return JSON.parse(row.result) as TickResult;
  }

  /** 查询某蛇最近一次死亡裁决（碰撞来源）。 */
  getSnakeCollision(id: string, snakeId: string): { tick: number; record: unknown } | null {
    const rows = this.db.prepare(
      'SELECT tick, result FROM ticks WHERE board_id = ? ORDER BY tick DESC',
    ).all(id) as { tick: number; result: string }[];
    for (const row of rows) {
      if (row.result === 'null') continue;
      const result = JSON.parse(row.result) as TickResult;
      const rec = result.deaths.find((d) => d.snakeId === snakeId);
      if (rec) return { tick: row.tick, record: rec };
    }
    return null;
  }

  exportReplay(id: string): { ticks: { tick: number; result: TickResult | null; board: BoardState }[] } {
    this.getBoard(id); // 404 检查
    const rows = this.db.prepare(
      'SELECT tick, result, board FROM ticks WHERE board_id = ? ORDER BY tick',
    ).all(id) as { tick: number; result: string; board: string }[];
    return {
      ticks: rows.map((r) => ({
        tick: r.tick,
        result: r.result === 'null' ? null : JSON.parse(r.result) as TickResult,
        board: JSON.parse(r.board) as BoardState,
      })),
    };
  }
}
