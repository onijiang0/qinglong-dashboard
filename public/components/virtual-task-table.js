/**
 * VirtualTaskTable — 虚拟滚动任务列表（零依赖，原生 ES Module）
 * ---------------------------------------------------------------
 * 目标：500~5000 条任务时 DOM 常驻节点恒定 ~30 个，滚动不掉帧。
 *
 * 用法：
 *   import { VirtualTaskTable } from "./components/virtual-task-table.js";
 *   const vt = new VirtualTaskTable({ mount: document.getElementById("taskListMount") });
 *   vt.setData(tasks);          // 全量数据，内部自己做过滤
 *   vt.setQuery("camel");       // 搜索（内部 180ms 防抖）
 *   vt.setFilter("running");    // 状态筛选
 *
 * 设计要点（对应"极度降低资源占用"）：
 *  1. 定高行（ROW_H）+ transform 整体位移，避免逐行写 top 引起的 layout thrash。
 *  2. <template> + cloneNode 做行模板复用，替代 innerHTML 字符串拼接/解析。
 *  3. 滚动事件走 rAF 合并；同帧内只重排一次。
 *  4. 搜索/筛选走防抖 + 单次过滤，避免每敲一个字符全量重建。
 *  5. 只重绘"新增/移出"的行，命中区间的行原地更新文本（patch），不重建 DOM。
 *  6. 空态/加载态与滚动容器分离，避免撑高影响 scrollHeight。
 *
 * 注意：本文件不依赖任何框架，可直接放进 public/components/ 下被 index.html import。
 *      需要 http(s) 环境（ES module 有 CORS 限制，file:// 打开会失败）。
 */

const ROW_H = 56;        // 行高（px）。CSS 里与之保持一致，务必同步改。
const OVERSCAN = 6;      // 上下各多渲染几行，防止快速滚动露白。
const SEARCH_DEBOUNCE = 180;

/* ------------------------- 工具 ------------------------- */

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/** 相对时间。兼容秒级时间戳与毫秒级时间戳（同一套判断，见 qinglong-panel 技能） */
export function fmtRel(sec) {
  if (!sec) return "—";
  const ms = sec > 1e12 ? sec : sec * 1000;
  const diff = Date.now() - ms;
  if (diff < 0) return "刚刚";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "1 分钟内";
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  const d = Math.floor(h / 24);
  if (d < 30) return d + " 天前";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

export function fmtDate(sec) {
  if (!sec) return "—";
  const ms = sec > 1e12 ? sec : sec * 1000;
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}

/**
 * 状态映射 —— 严格按青龙 2.20.2 实测语义。
 * 默认绝大多数任务是 status=1（空闲），只有 status===0 才是"运行中"。
 * 判断禁用只看 isDisabled。切勿把 status=1 当作运行中。
 */
export function statusOf(t) {
  if (Number(t.isDisabled) === 1) return { key: "disabled", text: "已禁用", cls: "st-muted" };
  if (Number(t.status) === 0) return { key: "running", text: "运行中", cls: "st-run" };
  if (Number(t.status) === 3) return { key: "queued", text: "队列中", cls: "st-queued" };
  return { key: "idle", text: "空闲", cls: "st-idle" };
}

/** 单次防抖 */
function debounce(fn, wait) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/* ------------------------- 样式（自包含，注入一次） ------------------------- */

const STYLE_ID = "virtual-task-table-style";
const CSS = `
/* ── 虚拟列表容器：自己就是滚动视口 ── */
.vt-wrap{position:relative;border:1px solid var(--line);border-radius:12px;
  background:var(--panel);overflow:hidden}
.vt-head{display:grid;align-items:center;height:40px;padding:0 12px;
  border-bottom:1px solid var(--line);background:var(--panel2);
  font-size:12px;font-weight:600;color:var(--muted);
  position:sticky;top:0;z-index:2}
.vt-scroll{overflow-y:auto;overflow-x:hidden;position:relative;
  /* 关键：固定视口高度，让浏览器自己做原生滚动（比 JS 模拟流畅得多） */
  height:min(62vh,620px);
  overscroll-behavior:contain;
  -webkit-overflow-scrolling:touch;
  contain:strict;           /* 布局/绘制隔离，滚动不牵连外部 */
  will-change:transform;}
.vt-sizer{position:relative;width:100%}
.vt-body{position:absolute;top:0;left:0;right:0;
  will-change:transform;contain:layout style}

/* ── 行：与表头共用同一套网格列宽 ── */
.vt-grid{display:grid;
  grid-template-columns:minmax(180px,2.2fr) 96px minmax(120px,1.4fr) 120px 168px}
.vt-row{height:${ROW_H}px;padding:0 12px;border-bottom:1px solid var(--line);
  align-items:center;font-size:13px;color:var(--text);
  transition:background .12s}
.vt-row:hover{background:var(--navHoverBg)}
.vt-row:last-child{border-bottom:0}

/* 任务名 + 命令（命令强制单行省略，保证行高恒定 —— 虚拟滚动的前提） */
.vt-cell-name{min-width:0;display:flex;flex-direction:column;justify-content:center;gap:2px}
.vt-name{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vt-cmd{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;font-family:ui-monospace,Consolas,monospace}
.vt-cell{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.vt-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.vt-acts{display:flex;gap:6px;justify-content:flex-end}

/* ── 状态点 ── */
.vt-st{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.vt-st i{width:7px;height:7px;border-radius:50%;flex-shrink:0;display:inline-block}
.st-run i{background:var(--green);box-shadow:0 0 0 3px rgba(61,220,151,.16)}
.st-idle i{background:var(--muted);opacity:.55}
.st-queued i{background:var(--amber)}
.st-muted i{background:var(--muted);opacity:.35}
.st-run{color:var(--green)}
.st-queued{color:var(--amber)}
.st-idle,.st-muted{color:var(--muted)}

/* ── 空态 / 加载态：绝对定位覆盖，不撑高 sizer ── */
/* 注意：display:flex 会盖掉 UA 的 [hidden]{display:none}（同权重、后写者胜），
   所以必须自带 [hidden] 规则，否则载入时"暂无任务"会浮在列表中间。 */
.vt-empty{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:8px;color:var(--muted);
  font-size:13px;pointer-events:none}
.vt-empty[hidden]{display:none}
.vt-empty .big{font-size:26px;opacity:.4}

/* ── 右上角性能/计数徽标 ── */
.vt-meta{font-size:12px;font-weight:400;color:var(--muted);display:flex;
  align-items:center;gap:10px}
.vt-meta b{color:var(--accentSoft);font-variant-numeric:tabular-nums}

/* ── 迷你按钮（复用全局 .btn.mini 观感，但做成自包含避免依赖） ── */
.vt-btn{border:1px solid var(--line);background:var(--panel2);color:var(--text);
  padding:3px 8px;border-radius:7px;font-size:11px;font-weight:500;cursor:pointer;
  white-space:nowrap;line-height:1.6}
.vt-btn:hover{filter:brightness(1.18)}
.vt-btn:disabled{opacity:.45;cursor:not-allowed}
.vt-btn.danger{border-color:#4a2430;color:var(--red)}

/* ── 回到顶部浮动按钮 ── */
.vt-top{position:absolute;right:14px;bottom:14px;z-index:3;
  border:1px solid var(--line);background:var(--panel2);color:var(--text);
  padding:7px 12px;border-radius:99px;font-size:12px;cursor:pointer;
  box-shadow:0 6px 18px rgba(0,0,0,.35);opacity:0;pointer-events:none;
  transition:opacity .18s,transform .18s;transform:translateY(6px)}
.vt-top.show{opacity:1;pointer-events:auto;transform:none}

@media(max-width:900px){
  .vt-grid{grid-template-columns:minmax(140px,2fr) 88px 110px}
  .vt-col-hide{display:none}   /* 窄屏隐藏 schedule / 上次执行 */
  .vt-scroll{height:60vh}
}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/* ------------------------- 行模板 ------------------------- */

function buildRowTemplate() {
  const tpl = document.createElement("template");
  // 列顺序与 .vt-grid 一致：名称 | 状态 | 定时规则 | 上次执行 | 操作
  tpl.innerHTML = `
    <div class="vt-row vt-grid" role="row">
      <div class="vt-cell-name">
        <div class="vt-name"></div>
        <div class="vt-cmd"></div>
      </div>
      <div class="vt-cell"><span class="vt-st"><i></i><em></em></span></div>
      <div class="vt-cell vt-mono vt-col-hide"></div>
      <div class="vt-cell vt-col-hide"></div>
      <div class="vt-acts">
        <button class="vt-btn" data-act="log">日志</button>
        <button class="vt-btn" data-act="run">▶ 执行</button>
        <button class="vt-btn" data-act="toggle"></button>
      </div>
    </div>`;
  return tpl;
}

/* ------------------------- 主类 ------------------------- */

export class VirtualTaskTable {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mount     挂载点（会被清空）
   * @param {string}      [opts.colHead] 表头文案（空格分隔 5 列）
   * @param {Function}    [opts.onAction] 操作回调 (action, task, ev) => void
   */
  constructor({ mount, colHead, onAction } = {}) {
    if (!mount) throw new Error("VirtualTaskTable: 缺少 mount 挂载点");
    injectStyle();

    this.mount = mount;
    this.onAction = onAction || (() => {});
    this.rows = [];          // 过滤后的数据
    this.source = [];        // 全量数据
    this.query = "";
    this.filter = "all";
    this.pool = [];          // DOM 行节点池
    this.rafId = 0;
    this.lastStart = -1;     // 上一次渲染窗口起点，用于判定是否需要重排
    this.lastEnd = -1;
    this.followTop = true;

    this._build(colHead || "任务 状态 定时规则 上次执行 操作");
    this._bind();
    this._draw();
  }

  /* ---------- 骨架 ---------- */
  _build(colHead) {
    const cols = colHead.split(/\s+/);
    this.mount.innerHTML = `
      <div class="vt-wrap">
        <div class="vt-head vt-grid">
          <div>${esc(cols[0])}</div>
          <div>${esc(cols[1])}</div>
          <div class="vt-col-hide">${esc(cols[2])}</div>
          <div class="vt-col-hide">${esc(cols[3])}</div>
          <div style="text-align:right">
            <span class="vt-meta">共 <b data-meta="count">0</b> 条</span>
          </div>
        </div>
        <div class="vt-scroll" data-scroll tabindex="0">
          <div class="vt-sizer" data-sizer>
            <div class="vt-body" data-body></div>
          </div>
          <div class="vt-empty" data-empty hidden>
            <div class="big">▤</div>
            <div data-empty-text>暂无任务</div>
          </div>
        </div>
        <button class="vt-top" data-top type="button">↑ 回到顶部</button>
      </div>`;

    const q = (s) => this.mount.querySelector(s);
    this.el = {
      scroll: q("[data-scroll]"),
      sizer: q("[data-sizer]"),
      body: q("[data-body]"),
      empty: q("[data-empty]"),
      emptyText: q("[data-empty-text]"),
      count: q('[data-meta="count"]'),
      top: q("[data-top]")
    };
    this.tpl = buildRowTemplate();

    // 列宽一致性：把表头网格模板量出来，套到每一行上
    // （两处都用 .vt-grid 自动同宽，这里只做断言式兜底，无需额外处理）
  }

  /* ---------- 事件绑定 ---------- */
  _bind() {
    // 滚动：rAF 合并，同帧内只渲染一次
    this.el.scroll.addEventListener(
      "scroll",
      () => {
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
          this.rafId = 0;
          this._draw();
          this._syncTopBtn();
        });
      },
      { passive: true }
    );

    // 回到顶部
    this.el.top.addEventListener("click", () => {
      this.el.scroll.scrollTo({ top: 0, behavior: "smooth" });
    });

    // 事件委托：只绑一次，行节点再多也不增加监听器
    this.el.body.addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const rowEl = btn.closest(".vt-row");
      const idx = Number(rowEl.dataset.idx);
      const task = this.rows[idx];
      if (task) this.onAction(btn.dataset.act, task, e);
    });

    // 视口尺寸变化：行高不变，但可视条数变了，需要重算窗口
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this._draw(true));
      this._ro.observe(this.el.scroll);
    }
  }

  _syncTopBtn() {
    // 只在"离顶部超过 2 屏"时才显示，避免无意义的重绘/动效
    const show = this.el.scroll.scrollTop > ROW_H * 20;
    this.el.top.classList.toggle("show", show);
  }

  /* ---------- 数据入口 ---------- */

  setData(list) {
    this.source = Array.isArray(list) ? list : [];
    this._applyFilter();
    this.el.scroll.scrollTop = 0;
    this._draw(true);
  }

  /** 搜索词（内部防抖，避免每敲一个字符就全量过滤 + 重排） */
  setQuery = debounce((q) => {
    this.query = String(q || "").trim().toLowerCase();
    this._applyFilter();
    this.el.scroll.scrollTop = 0;
    this._draw(true);
  }, SEARCH_DEBOUNCE);

  setFilter(f) {
    this.filter = f || "all";
    this._applyFilter();
    this.el.scroll.scrollTop = 0;
    this._draw(true);
  }

  /** 单次过滤：把 名称/命令 匹配 + 状态筛选合并成一遍循环 */
  _applyFilter() {
    const q = this.query;
    const f = this.filter;
    const out = [];
    for (let i = 0; i < this.source.length; i++) {
      const t = this.source[i];
      if (q) {
        const name = String(t.name || "").toLowerCase();
        const cmd = String(t.command || "").toLowerCase();
        if (!name.includes(q) && !cmd.includes(q)) continue;
      }
      if (f !== "all") {
        const st = statusOf(t).key;
        if (f === "enabled") {
          if (st === "disabled") continue;
        } else if (st !== f) continue;
      }
      out.push(t);
    }
    this.rows = out;
  }

  get visibleCount() {
    return this.rows.length;
  }

  /* ---------- 渲染核心 ---------- */

  _draw(force = false) {
    const total = this.rows.length;
    const viewH = this.el.scroll.clientHeight || 1;

    // 总高度一次性写死，浏览器据此生成原生滚动条
    this.el.sizer.style.height = total * ROW_H + "px";

    // 空态
    if (!total) {
      this.el.empty.hidden = false;
      this.el.emptyText.textContent = this.source.length
        ? "没有匹配的任务"
        : "暂无任务";
      this.el.body.style.transform = "translateY(0)";
      this.el.body.replaceChildren();
      this.pool.length = 0;
      this.el.count.textContent = "0";
      this.lastStart = this.lastEnd = -1;
      return;
    }
    this.el.empty.hidden = true;
    this.el.count.textContent = String(total);

    // 计算可见窗口
    const start = Math.max(
      0,
      Math.floor(this.el.scroll.scrollTop / ROW_H) - OVERSCAN
    );
    const end = Math.min(
      total,
      Math.ceil((this.el.scroll.scrollTop + viewH) / ROW_H) + OVERSCAN
    );
    const need = end - start;

    // 窗口没变 → 一次 DOM 都不碰（滚动微动时的主要优化）
    if (!force && start === this.lastStart && end === this.lastEnd) return;

    // 节点池：只增不减地复用，收缩到 need 长度
    while (this.pool.length < need) {
      this.pool.push(this.tpl.content.firstElementChild.cloneNode(true));
    }

    const body = this.el.body;
    // 先按需补挂缺失节点（append 顺序 = 池顺序，天然有序）
    for (let i = 0; i < need; i++) {
      const node = this.pool[i];
      if (node.parentNode !== body) body.appendChild(node);
    }
    // 再移除多余的（窗口缩小时）
    for (let i = need; i < this.pool.length; i++) {
      const node = this.pool[i];
      if (node.parentNode === body) body.removeChild(node);
    }

    // 整体位移：一次 transform，替代逐行 top
    body.style.transform = `translateY(${start * ROW_H}px)`;

    // 原地 patch 文本（不重建 DOM）
    for (let i = 0; i < need; i++) {
      this._patch(this.pool[i], this.rows[start + i], start + i);
    }

    this.lastStart = start;
    this.lastEnd = end;
  }

  /** 把一个 task 写进已存在的行节点 */
  _patch(node, t, idx) {
    if (!t) return;
    node.dataset.idx = String(idx);

    const nameEl = node.children[0].children[0];
    const cmdEl = node.children[0].children[1];
    if (nameEl.textContent !== t.name) nameEl.textContent = t.name || "(未命名)";
    const cmd = t.command || "";
    if (cmdEl.textContent !== cmd) cmdEl.textContent = cmd;
    if (cmdEl.title !== cmd) cmdEl.title = cmd;   // 折叠后的全文兜底

    const st = statusOf(t);
    const stWrap = node.children[1].firstElementChild;
    if (stWrap.dataset.k !== st.key) {
      stWrap.dataset.k = st.key;
      stWrap.className = "vt-st " + st.cls;
      stWrap.lastElementChild.textContent = st.text;
    }

    const schedEl = node.children[2];
    if (schedEl.textContent !== (t.schedule || "")) schedEl.textContent = t.schedule || "—";

    const lastEl = node.children[3];
    const rel = fmtRel(t.lastExecutionTime);
    if (lastEl.textContent !== rel) {
      lastEl.textContent = rel;
      lastEl.title = fmtDate(t.lastExecutionTime);
    }

    const toggleBtn = node.children[4].children[2];
    const disabled = Number(t.isDisabled) === 1;
    const label = disabled ? "启用" : "禁用";
    if (toggleBtn.textContent !== label) {
      toggleBtn.textContent = label;
      toggleBtn.dataset.act = disabled ? "enable" : "disable";
    }
  }

  /** 外部数据变更后强制重排（例如任务状态被手动执行改变） */
  refresh() {
    this._draw(true);
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this._ro) this._ro.disconnect();
    this.mount.replaceChildren();
  }
}

export default VirtualTaskTable;
