# 同步多蛇网格裁决后端

离线多蛇网格规则服务：多条蛇在同一逻辑 tick 内**同时**移动一格，基于同一个旧状态统一裁决碰撞，输出幸存者、死亡原因、食物消费和新棋盘。仅提供 HTTP API 与 CLI（字符棋盘），不含实时网页、联网对战与策略寻路。

技术栈：TypeScript + Node.js（>= 22.5，使用内置 `node:sqlite` 与 `node:http`，零运行时依赖）+ SQLite。Windows 本地直接运行，无需 Docker / WSL / 外部服务。

## 快速开始

```powershell
npm install        # 仅安装 typescript / @types/node（开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试
npm start          # 启动 API（默认监听空闲端口，控制台打印实际端口；PORT=8080 可指定）
npm run demo       # 运行四个演示场景（使用临时数据库）
npm run cli -- ... # CLI，例如：npm run cli -- board my-board
```

数据目录默认为项目内 `data/`（可用环境变量 `SNAKE_DATA_DIR`、`SNAKE_DB` 覆盖）。

## 同步裁决顺序（核心规则）

一个 tick 严格按以下顺序执行，**全部基于 tick 开始时的旧状态**，绝不按蛇编号逐条移动：

1. **整体校验**：方向合法、ID 已知且存活、长度大于一禁止直接反向、版本号匹配。任一失败整体拒绝，不推进任何蛇。
2. **统一规划**：为所有活蛇计算目标头格；目标是旧状态中的食物则本步*拟增长*、尾格保留，否则尾格腾空。该判断在死亡裁决之前确定，蛇随后死亡也不会改变其他蛇的判定。
3. **旧状态占用表**：每条蛇的旧身体删去将腾空的尾格，其余格子仍占用（包括即将死亡的蛇——它们未腾空的旧身体参与本步裁决，不因先撞墙就提前释放）。
4. **碰撞裁决**（每条蛇可记录多个死因，固定顺序 `OUT_OF_BOUNDS, WALL, BODY, HEAD_SWAP, HEAD_TO_HEAD`）：
   - 目标越界 → `OUT_OF_BOUNDS`；目标为墙 → `WALL`
   - 目标落在占用表 → `BODY`（含自己未腾空的身体）
   - 两条蛇互换旧头格 → 双方 `HEAD_SWAP`（即使长度一、旧头同时是腾空尾格）
   - 多条蛇目标同格 → 全部 `HEAD_TO_HEAD`，不按长度或先后选胜者
5. **提交结果**：只有幸存者把目标头接在旧身体前（非增长去尾、增长保留尾）并消费目标食物；死亡蛇整条身体在本 tick 结束时移出棋盘，死亡快照（旧身体、目标格、死因列表）单独保存供追查。食物不自动补充，只能在两次 tick 之间向空格添加。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/boards` | 创建场景 `{id,width,height,walls?,foods?,snakes?}` |
| POST | `/boards/:id/import` | 导入/替换局面（版本归零、清空历史） |
| POST | `/boards/:id/foods` | 添加食物 `{x,y}`（不能放进活蛇或墙） |
| POST | `/boards/:id/ticks` | 提交 tick `{requestId,version,moves:[{snakeId,dir}],steps?}` |
| GET | `/boards/:id` | 当前状态 |
| GET | `/boards/:id/snakes/:sid/collisions` | 某蛇最近一次碰撞来源 |
| GET | `/boards/:id/boards/:tick` | 历史棋盘（`?format=text` 返回字符棋盘） |
| GET | `/boards/:id/export` | 导出回放 JSON（每 tick 的裁决与棋盘快照） |

- 坐标从零开始，x 向右、y 向下；方向仅 `up/right/down/left`，缺省沿用当前方向。
- 幂等：`requestId` 相同且内容相同返回原结果（不重复推进）；内容不同返回 `409 REQUEST_CONFLICT`；`version` 不等于当前版本返回 `409 VERSION_CONFLICT`。
- 每个 tick 在 SQLite 事务中原子保存身体、方向、食物、版本与裁决结果；失败整体回滚，重启后继续下一个 tick 与连续执行一致。

错误码：`INVALID_DIRECTION` `REVERSE_DIRECTION` `UNKNOWN_SNAKE` `DEAD_SNAKE` `VERSION_CONFLICT` `REQUEST_CONFLICT` `LIMIT_EXCEEDED` `VALIDATION` `NOT_FOUND` `CONFLICT`。

内置上限（超出明确拒绝）：棋盘 64×64、蛇 32 条、单蛇长度 256、单次批量步数 64。

## CLI

```
node dist/src/cli.js create <id> <state.json>             创建场景
node dist/src/cli.js import <id> <state.json>             导入/替换局面
node dist/src/cli.js add-food <id> <x> <y>                添加食物
node dist/src/cli.js tick <id> <requestId> <version> [moves.json] [steps]
node dist/src/cli.js collisions <id> <snakeId>            查询某蛇碰撞来源
node dist/src/cli.js board <id> [tick]                    显示当前或历史字符棋盘
node dist/src/cli.js export <id>                          导出回放 JSON
```

`tick` 会打印前后字符棋盘、死亡原因与消费的食物。字符约定：`#` 墙、`*` 食物、`.` 空、大写字母蛇头、小写蛇身。

`state.json` 示例：

```json
{
  "width": 6, "height": 4,
  "walls": [],
  "foods": [{ "x": 5, "y": 1 }],
  "snakes": [
    { "id": "A", "body": [{ "x": 2, "y": 1 }, { "x": 1, "y": 1 }], "dir": "right" },
    { "id": "B", "body": [{ "x": 4, "y": 1 }, { "x": 3, "y": 1 }], "dir": "right" }
  ]
}
```

`moves.json` 示例：`[{ "snakeId": "A", "dir": "up" }]`（空数组表示全部沿用当前方向）。

## 演示场景（`npm run demo`）

1. 6×4，A `[(2,1),(1,1)]`、B `[(4,1),(3,1)]` 均向右，无食物：A 进入 B 腾空的 `(3,1)`，双方幸存。
2. 同上但 `(5,1)` 有食物：B 拟增长保留尾，A 撞 B 身体死亡（`BODY`），B 消费食物。
3. 两条长度一的蛇对头进入同一格：双方 `HEAD_TO_HEAD`。
4. 两条长度一的蛇互换旧头格：双方 `HEAD_SWAP`。
5. 长度为四的蛇掉头进入自己腾空的尾格：合法幸存。

## 测试

`npm test` 覆盖：输入蛇顺序不影响结果、死亡蛇不消费食物、非法反向整体回滚、幂等重试与冲突、版本拒绝、重启续跑、批量步数上限、食物放置校验、死蛇拒动、未知 ID、多死因固定顺序、碰撞来源查询与回放导出。

## 限制与假设

- 批量 `steps>1` 时，方向变更只作用于第一步，后续步沿用各蛇当前方向。
- 死亡蛇的身体保留在状态中（`alive:false`）供历史查询，但不占格、不能提交移动。
- 使用 Node 内置 `node:sqlite`（实验性 API，启动时有一条 ExperimentalWarning，不影响功能）。
