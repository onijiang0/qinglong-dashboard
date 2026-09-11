const express = require("express");
const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");

// 轻量读取同目录 .env（不覆盖已存在的环境变量）
(() => {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch (_) {}
})();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const QL_URL = (process.env.QL_URL || "").replace(/\/+$/, "");
const CLIENT_ID = process.env.QL_CLIENT_ID || "";
const CLIENT_SECRET = process.env.QL_CLIENT_SECRET || "";
const DASH_PASSWORD = process.env.DASH_PASSWORD || "";

// 关键：青龙公网域名过 Cloudflare 反代，默认 UA 一律 403，必须伪装浏览器 UA
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

let tokenCache = { token: "", expiresAt: 0 };

function qlUrl(pathname) {
  return `${QL_URL}${pathname}`;
}

async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  if (!QL_URL || !CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("青龙连接配置不完整（QL_URL / QL_CLIENT_ID / QL_CLIENT_SECRET）");
  }

  // 新版青龙必须 GET + query 参数换取 token，用 POST 会报 Cannot POST
  const url = new URL(qlUrl("/open/auth/token"));
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("client_secret", CLIENT_SECRET);

  const response = await fetch(url, {
    headers: { "User-Agent": UA },
    signal: AbortSignal.timeout(15000)
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.data?.token) {
    throw new Error(result.message || "青龙认证失败");
  }

  tokenCache = {
    token: result.data.token,
    expiresAt: Date.now() + 20 * 24 * 60 * 60 * 1000
  };
  return tokenCache.token;
}

async function qlRequest(pathname, options = {}) {
  const token = await getToken();
  const headers = {
    "User-Agent": UA,
    Authorization: `Bearer ${token}`,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  let response = await fetch(qlUrl(pathname), {
    ...options,
    headers,
    signal: AbortSignal.timeout(20000)
  });

  // token 失效时重取一次再试
  if (response.status === 401) {
    tokenCache = { token: "", expiresAt: 0 };
    const newToken = await getToken();
    response = await fetch(qlUrl(pathname), {
      ...options,
      headers: { ...headers, Authorization: `Bearer ${newToken}` },
      signal: AbortSignal.timeout(20000)
    });
  }

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { data: text };
  }

  if (!response.ok) {
    const error = new Error(data.message || `青龙 API 错误 ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function sendError(res, error) {
  console.error(`[api] ${error.status || ""} ${error.message}`);
  res.status(error.status || 502).json({
    code: error.status || 502,
    message: error.message
  });
}

// ---------- 简单口令登录（DASH_PASSWORD 留空则不启用） ----------
const AUTH_COOKIE = "dash_auth";
const authHash = () =>
  crypto.createHash("sha256").update(`ql-nexus:${DASH_PASSWORD}`).digest("hex");

app.post("/api/login", (req, res) => {
  if (!DASH_PASSWORD) return res.json({ code: 200, message: "未启用口令" });
  if (req.body && req.body.password === DASH_PASSWORD) {
    res.setHeader(
      "Set-Cookie",
      `${AUTH_COOKIE}=${authHash()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
    );
    return res.json({ code: 200 });
  }
  res.status(401).json({ code: 401, message: "口令错误" });
});

app.use("/api", (req, res, next) => {
  if (!DASH_PASSWORD || req.path === "/login") return next();
  const cookie = (req.headers.cookie || "")
    .split(/;\s*/)
    .find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  if (cookie && cookie.split("=")[1] === authHash()) return next();
  res.status(401).json({ code: 401, message: "未登录或口令已变更" });
});

// ---------- 只读接口 ----------
// 健康检查 + 青龙版本
app.get("/api/health", async (req, res) => {
  try {
    const data = await qlRequest("/open/system");
    res.json({
      ok: true,
      qlUrl: QL_URL,
      version: data?.data?.version || "未知",
      publishTime: data?.data?.publishTime || null
    });
  } catch (error) {
    sendError(res, error);
  }
});

// 全量任务列表（该版本忽略分页，一次返回全部）
app.get("/api/tasks", async (req, res) => {
  try {
    const result = await qlRequest("/open/crons?searchValue=&page=1");
    const list = result?.data?.data || [];
    // 青龙 2.20 任务状态：0=运行中 1=空闲 3=队列中（禁用看 isDisabled）
    const tasks = list.map((t) => ({
      id: t.id,
      name: t.name,
      command: t.command,
      schedule: t.schedule,
      status: t.status,
      isDisabled: t.isDisabled === 1 || t.isDisabled === true ? 1 : 0,
      isPinned: t.isPinned,
      labels: t.labels || [],
      pid: t.pid,
      lastExecutionTime: t.last_execution_time || 0,
      lastRunningTime: t.last_running_time || 0,
      logPath: t.log_path || "",
      updatedAt: t.updatedAt || ""
    }));
    res.json({ code: 200, total: tasks.length, data: tasks });
  } catch (error) {
    sendError(res, error);
  }
});

// 日志目录树展开成文件清单
app.get("/api/logs", async (req, res) => {
  try {
    const result = await qlRequest("/open/logs");
    const dirs = result?.data || [];
    const files = dirs.flatMap((d) =>
      (d.children || [])
        .filter((c) => c.type === "file")
        .map((c) => ({
          dir: d.title,
          name: c.title,
          size: c.size || 0,
          createTime: c.createTime || 0
        }))
    );
    res.json({ code: 200, dirCount: dirs.length, total: files.length, data: files });
  } catch (error) {
    sendError(res, error);
  }
});

// 读取单个日志文件：file=<目录>/<文件名>.log
app.get("/api/logs/detail", async (req, res) => {
  try {
    const file = String(req.query.file || "");
    if (!/^[^/\\]+\/[^/\\]+\.log$/.test(file)) {
      return res.status(400).json({ code: 400, message: "非法日志路径" });
    }
    const idx = file.lastIndexOf("/");
    const dir = file.slice(0, idx);
    const name = file.slice(idx + 1);
    const result = await qlRequest(
      `/open/logs/${encodeURIComponent(name)}?path=${encodeURIComponent(dir)}`
    );
    res.json({ code: 200, data: typeof result.data === "string" ? result.data : "" });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------- 任务操作（写接口） ----------
app.put("/api/tasks/:id/run", async (req, res) => {
  try {
    const result = await qlRequest("/open/crons/run", {
      method: "PUT",
      body: JSON.stringify({ ids: [Number(req.params.id)] })
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.put("/api/tasks/:id/enable", async (req, res) => {
  try {
    const result = await qlRequest("/open/crons/enable", {
      method: "PUT",
      body: JSON.stringify({ ids: [Number(req.params.id)] })
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

app.put("/api/tasks/:id/disable", async (req, res) => {
  try {
    const result = await qlRequest("/open/crons/disable", {
      method: "PUT",
      body: JSON.stringify({ ids: [Number(req.params.id)] })
    });
    res.json(result);
  } catch (error) {
    sendError(res, error);
  }
});

// ---------- 本机资源（注意：这是本容器所在环境，不是青龙容器） ----------
app.get("/api/system", (req, res) => {
  const total = os.totalmem();
  const free = os.freemem();
  res.json({
    code: 200,
    data: {
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || "",
      loadavg: os.loadavg(),
      memoryTotal: total,
      memoryFree: free,
      memoryUsed: total - free,
      memoryPercent: Math.round((1 - free / total) * 100),
      uptime: os.uptime()
    }
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`QingLong Nexus dashboard running on port ${PORT}`);
  console.log(`青龙地址: ${QL_URL || "（未配置）"}  口令保护: ${DASH_PASSWORD ? "已启用" : "未启用"}`);
});
