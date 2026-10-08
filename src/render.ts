import { BoardState } from './types';

/** 字符棋盘：# 墙，* 食物，. 空，大写=头，小写=身体，x=死蛇位置(仅当前状态不显示) */
export function renderBoard(state: BoardState): string {
  const grid: string[][] = Array.from({ length: state.height },
    () => Array.from({ length: state.width }, () => '.'));
  for (const w of state.walls) grid[w.y][w.x] = '#';
  for (const f of state.foods) grid[f.y][f.x] = '*';
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const ch = s.id[0].toUpperCase();
    s.body.forEach((c, i) => {
      grid[c.y][c.x] = i === 0 ? ch : ch.toLowerCase();
    });
  }
  const header = `v${state.version} ${state.width}x${state.height}`;
  return [header, ...grid.map((row) => row.join(''))].join('\n');
}
