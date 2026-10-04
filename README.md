# 大型结构健康监测与疲劳寿命评估服务

纯后端 Node.js + TypeScript + Fastify 服务，无需 Docker、数据库或消息中间件即可本机运行。

## 复杂业务闭环

- 基于本地 ENU 米制坐标的结构、构件和传感器模型
- 应变、加速度、位移、倾角和温度时序采集
- 采样质量、阈值告警、告警确认和检修证据闭环
- 模态频率漂移和阻尼比分析
- 应力序列、简化雨流计数、Miner 损伤和剩余寿命估算
- 车辆、风荷载和温度场景仿真（按场景关联的目标构件材料、截面、长度与许用应力计算）
- 风险规则自动建检修任务、幂等重复模拟、过期结果作废与新结果关闭门禁
- 构件健康指数与检查任务门禁

默认端口：`6312`。

## 荷载场景与检修任务闭环

1. `POST /api/load-scenarios` 建草稿，可带 `elementId` 关联目标构件；草稿允许无构件，模拟时必须已关联构件。
2. `PATCH /api/load-scenarios/:id` 修改输入或目标构件；已模拟场景的输入/构件一旦变化，旧结果标记 `superseded`、场景退回草稿，旧结果不能再用于关闭任务。
3. `POST /api/load-scenarios/:id/simulate` 按目标构件属性计算峰值应力、位移与 Miner 疲劳损伤，并套用应力利用率（≥1 严重 / ≥0.7 预警）、位移（L/300 严重、L/500 预警）和疲劳损伤（>0.35 严重、>0.15 预警）规则。命中规则即自动创建检修任务；同一构件同一输入重复模拟复用结果、不重复建任务（响应中 `reusedResult=true`）。
4. `POST /api/inspections` 保留直接检修流程（`source=direct`）。
5. `POST /api/inspections/:id/close`：证据必须覆盖全部 `requiredEvidence`；风险检修任务还必须提供同场景、同构件、未过期、且不再命中风险规则的新模拟结果（`resultId`），创建任务时的旧结果或输入/构件变化后的过期结果一律拒绝关闭。

端到端验证（先 `npm run build && npm start`，另开终端）：`npm run test:e2e`，覆盖不同构件、安全/风险结果、重复模拟、过期结果、证据不足、直接检修与新结果关闭。

## 模块结构

- `src/domain`：领域类型、坐标/单位约束和进程内状态锚点
- `src/services`：计算、仿真、融合和风险规则（`fatigue.ts`、`load-scenario.ts`、`health-index.ts`）
- `src/routes`：按业务边界拆分的 HTTP 接口（荷载场景与检修任务各自独立路由模块）
- `src/app.ts`：应用组装与路由注册
- `src/index.ts`：进程启动入口
- `scripts/e2e.ts`：HTTP 端到端业务闭环验证

各模块保持单一职责，业务状态只由 domain state 模块持有，避免路由之间重复维护同一份状态。
