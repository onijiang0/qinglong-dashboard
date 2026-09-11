# QingLong Nexus · 青龙可视化管理面板

Dark Plus 风格的青龙面板管理看板：前端单页 + Node.js 后端代理青龙 Open API，Client Secret 只存在后端，不进浏览器。

## 功能

- 数据总览：任务总数 / 运行中 / 24h 内执行过 / 已禁用，上次执行时间分布图，最近执行任务表
- 任务管理：搜索（名称+命令）、状态筛选、手动执行、启用 / 禁用、点「日志」直接看该任务最近一次日志
- 运行日志：367 个任务目录两级下拉（目录 → 按时间倒序的日志文件），读取日志内容
- 系统监控：面板后端所在环境的 CPU / 内存 / 运行时长（不是青龙容器本身）
- 自动刷新：30s 一次（页面隐藏时暂停）

## 相对通用模板修正过的点（实测踩坑）

| 问题 | 修正 |
|---|---|
| 默认 UA 被 Cloudflare 反代 403 | 所有请求带浏览器 UA |
| `/api/logs/*` 是内部 JWT 接口，外部 token 会 `jwt malformed` | 日志走 `/open/logs` 目录树 + `/open/logs/<文件>?path=<目录>`（路径需 encodeURIComponent） |
| `PUT /open/crons` + command 字段不是启停 | 启用/禁用/执行用 `/open/crons/enable` `/disable` `/run`，body `{ids:[id]}` |
| 任务 `status=1` 被当成运行中（青龙 2.20 里 1=空闲，0=才是运行中） | 状态映射：0 运行中 / 1 空闲 / 3 队列中，禁用看 `isDisabled` |
| "今日成功/失败"卡片接口给不出（青龙无执行历史） | 换成 24h 内执行过 / 已禁用等真实可算指标 |
| `last_execution_time` 秒级、`updatedAt` ISO 串混合 | 前端统一按秒级时间戳处理 |

已实测环境：青龙 **2.20.2**，367 任务 / 171 环境变量。

## 本地运行

```bash
cp .env.example .env   # 填入 QL_URL / CLIENT_ID / SECRET，公网部署再设 DASH_PASSWORD
npm install
npm start              # http://localhost:3000
```

## Docker 部署（DPanel / 任意 compose）

```bash
docker compose up -d --build
docker logs -f qinglong-dashboard
```

`.env` 与 docker-compose.yml 同目录即可，compose 会自动读入。SQLite/数据无需持久卷（当前版本无落库）。

## 安全建议

- **公网部署必须设置 `DASH_PASSWORD`**，否则面板和任务日志（含账号昵称）对任何能访问该地址的人可见
- `.env` 已在 `.gitignore` 中，不要提交 Secret
- 建议 Cloudflare Tunnel 指向本容器，并套 Access / 登录保护；不要把青龙管理端口直接暴露公网

## 已知边界

- 青龙 Open API 没有"执行历史 / 成功率"接口，本面板的统计都基于"最后一次执行"；执行趋势、超期告警需要后续版本自建快照落库（SQLite）实现
- 手动执行 / 启用 / 禁用是对真实面板的写操作，按钮均带确认或可即时撤销（禁用↔启用）
