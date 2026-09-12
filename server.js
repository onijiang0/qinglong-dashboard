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
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const SECRET_FILE = path.join(DATA_DIR, "session.key");

const DASH_USER = (process.env.DASH_USER || "admin").trim();
const DASH_PASSWORD = process.env.DASH_PASSWORD || "";

// 关键：青龙公网域名过 Cloudflare 反代，默认 UA 一律 403，必须伪装浏览器 UA
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ---------- 青龙连接配置：面板里保存的 config.json 优先，环境变量兜底 ----------
function loadPanelConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function qlConfig() {
  const f = loadPanelConfig();
  return {
    qlUrl: String(f.qlUrl || process.env.QL_URL || "").replace(/\/+$/, ""),
    clientId: String(f.clientId || process.env.QL_CLIENT_ID || ""),
    clientSecret: String(f.clientSecret || process.env.QL_CLIENT_SECRET || "")
  };
}

let tokenCache = { token: "", expiresAt: 0 };
const resetQlSession = () => {
  tokenCache = { token: "", expiresAt: 0 };
};

async function getToken(cfg) {
  cfg = cfg || qlConfig();
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  if (!cfg.qlUrl || !cfg.clientId || !cfg.clientSecret) {
    throw new Error("青龙连接配置不完整（地址 / Client ID / Client Secret），请到「连接设置」页填写");
  }

  // 新版青龙必须 GET + query 参数换取 token，用 POST 会报 Cannot POST
  const url = new URL(`${cfg.qlUrl}/open/auth/token`);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("client_secret", cfg.clientSecret);

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
  const cfg = qlConfig();
  const token = await getToken(cfg);
  const headers = {
    "User-Agent": UA,
    Authorization: `Bearer ${token}`,
    ...(options.body ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {})
  };

  let response = await fetch(`${cfg.qlUrl}${pathname}`, {
    ...options,
    headers,
    signal: AbortSignal.timeout(20000)
  });

  // token 失效时重取一次再试
  if (response.status === 401) {
    resetQlSession();
    const newToken = await getToken(cfg);
    response = await fetch(`${cfg.qlUrl}${pathname}`, {
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

// ---------- 账号密码登录（DASH_PASSWORD 留空 = 不启用） ----------
const AUTH_COOKIE = "dash_auth";

function sessionSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, "utf8").trim();
    if (s) return s;
  } catch (_) {}
  const s = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(SECRET_FILE, s);
  return s;
}

// 会话令牌绑定 账号+密码：改密码后旧会话全部失效
const sessionToken = () =>
  crypto.createHmac("sha256", sessionSecret()).update(`${DASH_USER}:${DASH_PASSWORD}`).digest("hex");

const hasValidCookie = (req) => {
  const cookie = (req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(`${AUTH_COOKIE}=`));
  return !!cookie && cookie.split("=")[1] === sessionToken();
};

app.get("/api/auth", (req, res) => {
  res.json({ required: !!DASH_PASSWORD, user: DASH_USER, ok: !DASH_PASSWORD || hasValidCookie(req) });
});

app.post("/api/login", (req, res) => {
  if (!DASH_PASSWORD) return res.json({ code: 200, message: "未启用登录" });
  const { user, password } = req.body || {};
  if (String(user || "").trim().toLowerCase() === DASH_USER.toLowerCase() && password === DASH_PASSWORD) {
    res.setHeader(
      "Set-Cookie",
      `${AUTH_COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
    );
    return res.json({ code: 200 });
  }
  res.status(401).json({ code: 401, message: "账号或密码错误" });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ code: 200 });
});

app.use("/api", (req, res, next) => {
  if (!DASH_PASSWORD || req.path === "/login" || req.path === "/auth" || req.path === "/logout") return next();
  if (hasValidCookie(req)) return next();
  res.status(401).json({ code: 401, message: "未登录或口令已变更" });
});

// ---------- 连接设置（面板可视化配置青龙，保存到数据卷） ----------
const maskSecret = (s) => (s ? `••••${s.slice(-4)}` : "");

function mergeConfig(input) {
  const cur = qlConfig();
  const cfg = {
    qlUrl: String(input.qlUrl ?? cur.qlUrl ?? "").trim().replace(/\/+$/, ""),
    clientId: String(input.clientId ?? cur.clientId ?? "").trim(),
    clientSecret: String(input.clientSecret ?? "").trim() || cur.clientSecret || ""
  };
  if (!/^https?:\/\//.test(cfg.qlUrl)) throw new Error("青龙地址必须以 http:// 或 https:// 开头");
  if (!cfg.clientId || !cfg.clientSecret) throw new Error("Client ID 和 Client Secret 不能为空");
  return cfg;
}

async function testConnection(cfg) {
  const token = await getToken({ ...cfg });
  const r = await fetch(`${cfg.qlUrl}/open/system`, {
    headers: { "User-Agent": UA, Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j?.data?.version) throw new Error(j.message || `连接失败（HTTP ${r.status}）`);
  return { ok: true, version: j.data.version };
}

app.get("/api/settings", (req, res) => {
  const cfg = qlConfig();
  const panel = loadPanelConfig();
  res.json({
    code: 200,
    qlUrl: cfg.qlUrl,
    clientId: cfg.clientId,
    secretMasked: maskSecret(cfg.clientSecret),
    source: panel.qlUrl || panel.clientId ? "panel" : "env"
  });
});

app.post("/api/settings", async (req, res) => {
  try {
    const cfg = mergeConfig(req.body || {});
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    resetQlSession();
    const test = await testConnection(cfg);
    res.json({ code: 200, saved: true, ...test });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/settings/test", async (req, res) => {
  try {
    const test = await testConnection(mergeConfig(req.body || {}));
    res.json({ code: 200, ...test });
  } catch (error) {
    sendError(res, error);
  }
});

// ---------- 只读接口 ----------
app.get("/api/health", async (req, res) => {
  try {
    const cfg = qlConfig();
    const data = await qlRequest("/open/system");
    res.json({ ok: true, qlUrl: cfg.qlUrl, version: data?.data?.version || "未知" });
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

// 批量删除日志（目录或文件混选）：items=[{filename, path}]
// 目录：filename=目录名, path=''；文件：filename=日志文件名, path=目录名
app.post("/api/logs/delete", async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 300) : [];
    if (!items.length) return res.status(400).json({ code: 400, message: "没有要删除的目标" });
    const bad = (s) => /(^|\/|\\)\.\.?(\/|\\|$)/.test(s) || s.includes("\\");
    const results = [];
    for (const it of items) {
      const filename = String(it?.filename || "");
      const dir = String(it?.path || "");
      const full = dir ? `${dir}/${filename}` : filename;
      if (!/^[^/\\]+$/.test(filename) || bad(filename) || bad(dir)) {
        results.push({ target: full, ok: false, message: "非法路径" });
        continue;
      }
      try {
        await qlRequest("/open/logs", {
          method: "DELETE",
          body: JSON.stringify({ filename, path: dir })
        });
        results.push({ target: full, ok: true });
      } catch (e) {
        results.push({ target: full, ok: false, message: e.message });
      }
    }
    const failed = results.filter((r) => !r.ok).length;
    res.json({ code: 200, deleted: results.length - failed, failed, results });
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
  console.log(`登录保护: ${DASH_PASSWORD ? `已启用（账号 ${DASH_USER}）` : "未启用"}  配置文件: ${CONFIG_FILE}`);
});
