# 同步多蛇网格移动与头尾碰撞裁决后端

离线、本地可运行的多蛇网格规则服务。多条蛇在同一个逻辑 tick 内**同时**移动一格，基于同一个旧状态统一裁决碰撞，输出幸存者、死亡原因、食物消费和新棋盘。只提供 HTTP API、CLI 和字符棋盘，不含实时网页、联网对战或策略寻路。

- 技术栈：TypeScript + Node.js（>= 22，使用内置 `node:sqlite`，无原生编译依赖）+ SQLite
- 平台：Windows 本地运行，不依赖 Docker / WSL / 外部在线服务
- 所有方向与食物位置均由输入指定，不随机刷食物

## 快速开始

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（node:test）
npm run demo       # 运行内置演示（五个场景，打印前后字符棋盘）
npm start          # 启动 API 服务（默认自动选择空闲端口）
```

指定端口与数据库位置：

```powershell
node dist/src/cli.js serve --port 8080 --db data\snake.db
```

## 同步裁决顺序（核心规则）

每个 tick 严格按以下顺序基于**同一个旧状态**裁决，绝不按蛇编号逐条移动：

1. **整体校验**：版本一致、所有 snakeId 为活蛇、方向合法（仅 `U/R/D/L`）、长度大于一的蛇不直接反向。任一失败则**整体拒绝**，不推进任何蛇。
2. **统一规划**：为所有活蛇计算目标头格；目标是旧状态中的食物则本步**拟增长**（尾格保留），否则本步**拟移动**（旧尾格腾空）。该保留判断在死亡裁决之前统一确定，即使该蛇稍后死亡，也不反过来改变其他蛇的判定。
3. **建立占用表**：每条蛇的旧身体删去本步将腾空的尾格，其余格子仍被占用。
4. **碰撞裁决**（每条蛇可记录多个死因，按固定顺序）：
   - `OUT_OF_BOUNDS`：目标越界
   - `HIT_WALL`：目标撞固定墙格
   - `HIT_BODY`：目标进入占用表中的格子（包括自己未腾空的身体）
   - `HEAD_ON`：多条蛇头进入同一目标格，**全部死亡**，不按长度或先后选胜者
   - `HEAD_SWAP`：两条蛇互换旧头格，**全部死亡**（即便长度一、旧头同时是腾空尾格）
5. **提交新状态**：只有幸存者把目标头接在旧身体前（非增长去尾、增长保留尾），只有幸存者消费目标食物。死亡蛇的全部身体在本 tick **结束时**才移出棋盘——它们本步未腾空的旧身体仍参与第 4 步裁决，不因某蛇先撞墙就立即释放。死亡快照（死因、目标、旧身体、tick）单独保存供追查。

食物不自动补充；只能在两次 tick 之间向空格添加食物，不能放进活蛇或墙里。

## 坐标与输入约定

- 有界矩形棋盘，坐标从零开始，x 向右、y 向下。
- 蛇身体为头到尾的连续四邻接坐标数组（头在前），长度可为一。
- 长度大于一时，当前方向必须与"颈部指向头部"的方向一致。
- 下一 tick 缺省方向沿用当前方向；死蛇不能再提交移动。

## HTTP API

默认监听 `127.0.0.1`，未指定 `--port` 时自动选择空闲端口并打印。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/scenarios` | 创建场景 `{id?, width, height, walls?, foods?, snakes?}` |
| GET | `/scenarios/:id` | 查询当前状态与字符棋盘 |
| POST | `/scenarios/:id/import` | 导入局面（重置版本与历史） |
| POST | `/scenarios/:id/foods` | 添加食物 `{x, y}` |
| POST | `/scenarios/:id/ticks` | 提交 tick `{requestId, version, moves:[{snakeId, dir}]}` |
| GET | `/scenarios/:id/snakes/:sid/collisions` | 查询某蛇碰撞来源（死亡快照） |
| GET | `/scenarios/:id/board?tick=n` | 读历史棋盘（缺省为当前棋盘） |
| GET | `/scenarios/:id/replay` | 导出回放 JSON（全部 tick、裁决与死亡记录） |

### 幂等与并发语义

- 相同 `requestId` 且内容（version + moves）相同：返回原结果，`replayed: true`，不重复推进。
- 相同 `requestId` 但内容不同：`409 REQUEST_CONFLICT`。
- `version` 与当前版本不一致：`409 VERSION_CONFLICT`（过期版本拒绝）。
- 每个 tick 的校验、裁决与落库在**单个 SQLite 事务**内完成，失败整体回滚，不会留下部分蛇已移动的状态；重启后继续下一个 tick 与连续执行一致。

### 错误码

`VALIDATION_ERROR`（400）、`INVALID_DIRECTION`（400）、`UNKNOWN_SNAKE`（400）、`FOOD_CELL_OCCUPIED`（400）、`LIMIT_EXCEEDED`（400）、`NOT_FOUND`（404）、`VERSION_CONFLICT`（409）、`REQUEST_CONFLICT`（409）、`INTERNAL`（500）。

### 上限（超出明确拒绝）

棋盘最大 64×64，蛇数最大 32，单蛇长度最大 512，单 tick 方向变更最大 64 条，批量步数上限 1000（见 `src/engine.ts` 的 `LIMITS`）。

## CLI

```powershell
node dist/src/cli.js serve [--port N] [--db 路径]   # 启动 API（默认空闲端口）
node dist/src/cli.js create --file 局面.json [--id ID]
node dist/src/cli.js import <id> --file 局面.json
node dist/src/cli.js add-food <id> --x 5 --y 1
node dist/src/cli.js tick <id> --moves "[{\"snakeId\":\"A\",\"dir\":\"R\"}]" [--request ID]
node dist/src/cli.js board <id> [--tick N]          # 当前或历史字符棋盘
node dist/src/cli.js collisions <id> <snakeId>
node dist/src/cli.js replay <id>
node dist/src/cli.js demo
```

`tick` 命令会打印 tick 前后的字符棋盘、每条蛇的生死与死因。

局面 JSON 示例：

```json
{
  "width": 6,
  "height": 4,
  "walls": [{ "x": 0, "y": 0 }],
  "foods": [{ "x": 5, "y": 1 }],
  "snakes": [
    { "id": "A", "dir": "R", "body": [{ "x": 2, "y": 1 }, { "x": 1, "y": 1 }] },
    { "id": "B", "dir": "R", "body": [{ "x": 4, "y": 1 }, { "x": 3, "y": 1 }] }
  ]
}
```

## 字符棋盘图例

`.` 空格，`#` 墙，`*` 食物，大写字母为蛇头，小写字母为蛇身（取蛇 ID 首字母）。

## 内置演示（npm run demo）

宽六高四，A 身体 `[(2,1),(1,1)]`、B 身体 `[(4,1),(3,1)]`，二者向右：

1. 无食物：A 进入 B 腾空的尾格 `(3,1)`，双双存活。
2. `(5,1)` 有食物：B 拟增长保留尾格，A 撞身体死亡（`HIT_BODY`），食物被 B 消费。
3. 两头进入同一目标格：全部死亡（`HEAD_ON`）。
4. 长度一互换旧头格：全部死亡（`HEAD_SWAP`）。
5. 进入自己本步腾空的尾格：合法存活。

## 项目结构

```
src/types.ts     类型与错误定义
src/engine.ts    同步裁决纯函数 applyTick + 占用表 + 字符棋盘渲染 + 上限
src/validate.ts  场景/局面合法性校验（自交、重叠、压墙、方向一致性等）
src/store.ts     SQLite 持久化：事务、幂等请求、tick 历史、死亡快照、回放
src/api.ts       HTTP API（node:http）
src/cli.ts       命令行入口与内置演示
test/            node:test 测试（引擎规则 + 持久化/幂等/重启一致性）
data/            项目内数据目录（snake.db）
```

## 假设与限制

- 使用 Node.js 内置 `node:sqlite`（实验性 API，启动时有 ExperimentalWarning，不影响功能）；需 Node >= 22。
- 食物在两次 tick 之间添加，不与版本号联动（版本只随 tick 递增）。
- 历史棋盘从 tick 1 起可查；当前棋盘请用 `GET /scenarios/:id/board`。
- 单进程本地服务，未做鉴权与 TLS。
