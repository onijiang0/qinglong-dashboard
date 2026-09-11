# QingLong Nexus · 青龙可视化管理面板

Dark Plus 风格的青龙面板管理看板：前端单页 + Node.js 后端代理青龙 Open API，Client Secret 只存在后端，不进浏览器。

![Build](https://github.com/onijiang0/qinglong-dashboard/actions/workflows/docker.yml/badge.svg)

## 功能

- **登录保护**：账号 + 密码（部署方通过 `DASH_USER` / `DASH_PASSWORD` 配置），会话绑定凭据，改密码即全端下线
- **连接设置**：青龙地址 / Client ID / Client Secret 直接在面板里填写、测试、保存（写入数据卷 `data/config.json`，改配置不用重启容器、不用改 .env）
- 数据总览：任务总数 / 运行中 / 24h 内执行过 / 已禁用，上次执行时间分布图，最近执行任务表
- 任务管理：搜索（名称+命令）、状态筛选、手动执行、启用 / 禁用、点「日志」直接看该任务最近一次日志
- 运行日志：任务目录两级下拉（目录 → 按时间倒序的日志文件），读取日志内容
- 系统监控：面板后端所在环境的 CPU / 内存 / 运行时长（不是青龙容器本身）
- 自动刷新：30s 一次（页面隐藏时暂停）

## 部署方式一：拉 GitHub Actions 自动构建的镜像（推荐）

推送代码到 main 分支后，GitHub Actions 自动构建并发布镜像到 GHCR：
`ghcr.io/onijiang0/qinglong-dashboard:latest`

服务器上只需要一个 `docker-compose.yml` 和 `.env`：

```yaml
services:
  qinglong-dashboard:
    image: ghcr.io/onijiang0/qinglong-dashboard:latest
    container_name: qinglong-dashboard
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      TZ: Asia/Shanghai
      DASH_USER: ${DASH_USER:-admin}
      DASH_PASSWORD: ${DASH_PASSWORD}
    volumes:
      - ./data:/app/data
```

```bash
docker compose pull && docker compose up -d
```

青龙连接信息可以不写进 .env——打开面板 → 「连接设置」页填写并保存，存进数据卷，即时生效。

## 部署方式二：源码构建

```bash
git clone https://github.com/onijiang0/qinglong-dashboard.git
cd qinglong-dashboard
cp .env.example .env   # 填 DASH_PASSWORD 等
docker compose up -d --build   # compose 里把 image 换成 build: . 即可本地构建
```

## 本地开发（无 Docker）

```bash
npm install
DASH_USER=admin DASH_PASSWORD=test123 PORT=3000 npm start
```

## 环境变量

| 变量 | 说明 |
|---|---|
| `DASH_USER` | 面板登录账号，默认 `admin` |
| `DASH_PASSWORD` | 面板登录密码。**留空 = 不启用登录（仅限本机调试）** |
| `QL_URL` / `QL_CLIENT_ID` / `QL_CLIENT_SECRET` | 青龙连接信息兜底值；面板「连接设置」保存后以面板配置为准 |
| `PORT` | 监听端口，默认 3000 |
| `DATA_DIR` | 数据目录（config.json / session.key），默认 `./data` |

## 相对通用模板修正过的点（实测踩坑）

| 问题 | 修正 |
|---|---|
| 默认 UA 被 Cloudflare 反代 403 | 所有请求带浏览器 UA |
| `/api/logs/*` 是内部 JWT 接口，外部 token 会 `jwt malformed` | 日志走 `/open/logs` 目录树 + `/open/logs/<文件>?path=<目录>`（路径需 encodeURIComponent） |
| `PUT /open/crons` + command 字段不是启停 | 启用/禁用/执行用 `/open/crons/enable` `/disable` `/run`，body `{ids:[id]}` |
| 任务 `status=1` 被当成运行中（青龙 2.20 里 1=空闲，0=才是运行中） | 状态映射：0 运行中 / 1 空闲 / 3 队列中，禁用看 `isDisabled` |
| "今日成功/失败"卡片接口给不出（青龙无执行历史） | 换成 24h 内执行过 / 已禁用等真实可算指标 |
| `last_execution_time` 秒级、`updatedAt` ISO 串混合 | 前端统一按秒级时间戳处理 |

已实测环境：青龙 **2.20.2**。

## 安全建议

- **公网部署必须设置 `DASH_PASSWORD`**，否则面板和任务日志（含账号昵称）对任何能访问该地址的人可见
- `.env`、`data/`（含青龙凭据）均已 gitignore，不要提交
- 建议 Cloudflare Tunnel 指向本容器，并套 Access / 登录保护；不要把青龙管理端口直接暴露公网

## 已知边界

- 青龙 Open API 没有"执行历史 / 成功率"接口，本面板的统计都基于"最后一次执行"；执行趋势、超期告警需要后续版本自建快照落库（SQLite）实现
- 手动执行 / 启用 / 禁用是对真实面板的写操作，按钮均带确认
