import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { BoardState, Point, Snake, TickResult, ApiError } from "./types";

export interface DeathRecord {
  tick: number;
  snakeId: string;
  reasons: string[];
  body: Point[];
  target: Point;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS scenarios (
        id TEXT PRIMARY KEY,
        width INTEGER NOT NULL,
        height INTEGER NOT NULL,
        version INTEGER NOT NULL,
        tick INTEGER NOT NULL,
        walls TEXT NOT NULL,
        foods TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snakes (
        scenario_id TEXT NOT NULL,
        id TEXT NOT NULL,
        alive INTEGER NOT NULL,
        dir TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (scenario_id, id)
      );
      CREATE TABLE IF NOT EXISTS ticks (
        scenario_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        version INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        moves TEXT NOT NULL,
        result TEXT NOT NULL,
        board TEXT NOT NULL,
        PRIMARY KEY (scenario_id, tick)
      );
      CREATE TABLE IF NOT EXISTS requests (
        scenario_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response TEXT NOT NULL,
        PRIMARY KEY (scenario_id, request_id)
      );
      CREATE TABLE IF NOT EXISTS deaths (
        scenario_id TEXT NOT NULL,
        tick INTEGER NOT NULL,
        snake_id TEXT NOT NULL,
        reasons TEXT NOT NULL,
        body TEXT NOT NULL,
        target TEXT NOT NULL,
        PRIMARY KEY (scenario_id, tick, snake_id)
      );
    `);
  }

  close() {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  createScenario(id: string, state: BoardState): void {
    this.tx(() => {
      this.db
        .prepare(
          "INSERT INTO scenarios (id,width,height,version,tick,walls,foods) VALUES (?,?,?,?,?,?,?)"
        )
        .run(
          id,
          state.width,
          state.height,
          state.version,
          state.tick,
          JSON.stringify(state.walls),
          JSON.stringify(state.foods)
        );
      for (const s of state.snakes) this.insertSnake(id, s);
    });
  }

  private insertSnake(scenarioId: string, s: Snake) {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO snakes (scenario_id,id,alive,dir,body) VALUES (?,?,?,?,?)"
      )
      .run(scenarioId, s.id, s.alive ? 1 : 0, s.dir, JSON.stringify(s.body));
  }

  exists(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM scenarios WHERE id=?").get(id);
  }

  loadState(id: string): BoardState {
    const row = this.db.prepare("SELECT * FROM scenarios WHERE id=?").get(id) as
      | any
      | undefined;
    if (!row) throw new ApiError("NOT_FOUND", `场景不存在: ${id}`, 404);
    const snakes = this.db
      .prepare("SELECT * FROM snakes WHERE scenario_id=? ORDER BY rowid")
      .all(id) as any[];
    return {
      width: row.width,
      height: row.height,
      version: row.version,
      tick: row.tick,
      walls: JSON.parse(row.walls),
      foods: JSON.parse(row.foods),
      snakes: snakes.map((s) => ({
        id: s.id,
        alive: !!s.alive,
        dir: s.dir,
        body: JSON.parse(s.body),
      })),
    };
  }

  /** 原子导入局面（重置版本与历史）。 */
  importState(id: string, state: BoardState): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM snakes WHERE scenario_id=?").run(id);
      this.db.prepare("DELETE FROM ticks WHERE scenario_id=?").run(id);
      this.db.prepare("DELETE FROM deaths WHERE scenario_id=?").run(id);
      this.db.prepare("DELETE FROM requests WHERE scenario_id=?").run(id);
      this.db
        .prepare(
          "UPDATE scenarios SET width=?,height=?,version=?,tick=?,walls=?,foods=? WHERE id=?"
        )
        .run(
          state.width,
          state.height,
          state.version,
          state.tick,
          JSON.stringify(state.walls),
          JSON.stringify(state.foods),
          id
        );
      for (const s of state.snakes) this.insertSnake(id, s);
    });
  }

  setFoods(id: string, foods: Point[]): void {
    this.tx(() => {
      const n = this.db
        .prepare("UPDATE scenarios SET foods=? WHERE id=?")
        .run(JSON.stringify(foods), id);
      if (Number(n.changes) === 0)
        throw new ApiError("NOT_FOUND", `场景不存在: ${id}`, 404);
    });
  }

  /**
   * 幂等 tick：同一 requestId 内容相同返回原结果，内容不同抛 REQUEST_CONFLICT。
   * 整个校验+裁决+落库在一个事务里，失败不留部分状态。
   */
  applyTickIdempotent(
    id: string,
    requestId: string,
    requestHash: string,
    compute: () => { state: BoardState; result: TickResult; movesJson: string }
  ): { result: TickResult; replayed: boolean } {
    return this.tx(() => {
      const prev = this.db
        .prepare(
          "SELECT request_hash, response FROM requests WHERE scenario_id=? AND request_id=?"
        )
        .get(id, requestId) as any;
      if (prev) {
        if (prev.request_hash !== requestHash) {
          throw new ApiError(
            "REQUEST_CONFLICT",
            `请求 ID ${requestId} 已存在但内容不同`,
            409
          );
        }
        return { result: JSON.parse(prev.response), replayed: true };
      }
      const { state, result, movesJson } = compute();
      this.db
        .prepare("UPDATE scenarios SET version=?, tick=?, foods=? WHERE id=?")
        .run(state.version, state.tick, JSON.stringify(state.foods), id);
      for (const s of state.snakes) this.insertSnake(id, s);
      this.db
        .prepare(
          "INSERT INTO ticks (scenario_id,tick,version,request_id,moves,result,board) VALUES (?,?,?,?,?,?,?)"
        )
        .run(
          id,
          state.tick,
          state.version,
          requestId,
          movesJson,
          JSON.stringify(result),
          JSON.stringify(result.board)
        );
      for (const r of result.results) {
        if (!r.alive) {
          this.db
            .prepare(
              "INSERT INTO deaths (scenario_id,tick,snake_id,reasons,body,target) VALUES (?,?,?,?,?,?)"
            )
            .run(
              id,
              state.tick,
              r.snakeId,
              JSON.stringify(r.deathReasons),
              JSON.stringify(r.body),
              JSON.stringify(r.target)
            );
        }
      }
      this.db
        .prepare(
          "INSERT INTO requests (scenario_id,request_id,request_hash,response) VALUES (?,?,?,?)"
        )
        .run(id, requestId, requestHash, JSON.stringify(result));
      return { result, replayed: false };
    });
  }

  getDeaths(id: string, snakeId: string): DeathRecord[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM deaths WHERE scenario_id=? AND snake_id=? ORDER BY tick"
      )
      .all(id, snakeId) as any[];
    return rows.map((r) => ({
      tick: r.tick,
      snakeId: r.snake_id,
      reasons: JSON.parse(r.reasons),
      body: JSON.parse(r.body),
      target: JSON.parse(r.target),
    }));
  }

  getBoardAt(id: string, tick: number): string[] {
    if (tick === 0) return []; // 调用方用当前状态或初始导入处理
    const row = this.db
      .prepare("SELECT board FROM ticks WHERE scenario_id=? AND tick=?")
      .get(id, tick) as any;
    if (!row)
      throw new ApiError("NOT_FOUND", `没有 tick ${tick} 的历史棋盘`, 404);
    return JSON.parse(row.board);
  }

  getReplay(id: string): any {
    if (!this.exists(id)) throw new ApiError("NOT_FOUND", `场景不存在: ${id}`, 404);
    const ticks = this.db
      .prepare(
        "SELECT tick, version, request_id, moves, result, board FROM ticks WHERE scenario_id=? ORDER BY tick"
      )
      .all(id) as any[];
    const deaths = this.db
      .prepare("SELECT * FROM deaths WHERE scenario_id=? ORDER BY tick")
      .all(id) as any[];
    return {
      scenarioId: id,
      ticks: ticks.map((t) => ({
        tick: t.tick,
        version: t.version,
        requestId: t.request_id,
        moves: JSON.parse(t.moves),
        result: JSON.parse(t.result),
        board: JSON.parse(t.board),
      })),
      deaths: deaths.map((d) => ({
        tick: d.tick,
        snakeId: d.snake_id,
        reasons: JSON.parse(d.reasons),
        body: JSON.parse(d.body),
        target: JSON.parse(d.target),
      })),
    };
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "snake.db");
}
