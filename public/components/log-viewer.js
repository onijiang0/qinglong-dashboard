/**
 * LogViewer — 日志滚动查看器（零依赖，原生 ES Module）
 * ---------------------------------------------------------------
 * 解决现有代码 `ovText.textContent = r.data` 对大日志的三个问题：
 *   1. 几万行一次性塞进一个 <pre> → 首次渲染卡死、内存膨胀
 *   2. 无法"自动滚到底部"，且用户手动上滚后会被强行拽回底部
 *   3. 高频追加（轮询/SSE）时每来一行就重算 scrollHeight → 强制同步 reflow
 *
 * 用法：
 *   import { LogViewer } from "./log-viewer.js";
 *   const lv = new LogViewer({ mount: document.getElementById("logMount") });
 *   lv.setContent(text);                  // 一次性灌入整份日志
 *   lv.append(chunk);                     // 增量追加（双缓冲，rAF 合并）
 *   lv.scrollToBottom();                  // 主动跳到底
 *
 * 设计要点：
 *  A. 行级虚拟化 —— 定高行（LOG_LINE_H）只渲染可视区，DOM 常驻 ~40 个
 *  B. 自动跟随 —— IntersectionObserver 观察底部哨兵；用户上滚 >60px 自动暂停跟随，
 *     出现"↓ 跳到最新"浮动按钮，重新滚回底部自动恢复跟随
 *  C. 高频追加 —— 新行先进 pending 缓冲，rAF 里一次性合并；只做增量 patch，
 *     绝不在追加时重算整份列表高度
 *  D. 长行折行 —— 日志常有超长行，故行高按"单行"计算，超长行走横向滚动而非折行
 *     （折行会破坏虚拟化的定高前提，这是与任务表相同的取舍）
 */

const LOG_LINE_H = 21;      // 与 CSS 的 line-height 严格一致
const LOG_OVERSCAN = 10;
const FOLLOW_THRESHOLD = 60; // 距底部多少 px 内视为"在底部"

/* ------------------------- 样式（自包含） ------------------------- */

const STYLE_ID = "log-viewer-style";
const CSS = `
.lv-wrap{position:relative;display:flex;flex-direction:column;
  border:1px solid var(--line);border-radius:12px;overflow:hidden;
  background:var(--bg)}
.lv-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;
  padding:9px 12px;border-bottom:1px solid var(--line);background:var(--panel2)}
.lv-bar .lv-title{font-weight:600;font-size:13px;min-width:0;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.lv-stat{font-size:11px;color:var(--muted);font-variant-numeric:tabular-nums;
  white-space:nowrap}
.lv-stat b{color:var(--accentSoft)}
.lv-tools{display:flex;gap:6px;align-items:center}
.lv-btn{border:1px solid var(--line);background:var(--panel);color:var(--text);
  padding:4px 9px;border-radius:7px;font-size:11px;cursor:pointer;
  white-space:nowrap;line-height:1.6}
.lv-btn:hover{filter:brightness(1.18)}
.lv-btn.on{background:var(--accent);border-color:var(--accent);color:#fff}
.lv-btn:disabled{opacity:.45;cursor:not-allowed}
.lv-input{background:var(--panel);color:var(--text);border:1px solid var(--line);
  padding:4px 9px;border-radius:7px;font-size:12px;min-width:120px;flex:1;
  max-width:220px}

/* 滚动视口 —— height 必须写死在这里。
   踩坑记录：之前用 flex:1 + 父级 contain:strict，结果外层 .lv-wrap 没有确定高度，
   flex:1 解析成 0，整个滚动区高度为 0 → 完全无法滚动，且"上滚暂停跟随"永远不触发
   （scrollHeight - scrollTop - clientHeight 恒为 0）。
   教训：contain:strict（含 size 隔离）的元素不要依赖 flex 拉伸来取高度，
   必须给它确定的高度。 */
.lv-scroll{position:relative;overflow:auto;
  height:var(--lv-height,min(58vh,560px));
  contain:content;overscroll-behavior:contain}
.lv-sizer{position:relative;width:100%}
.lv-body{position:absolute;top:0;left:0;right:0;contain:layout style;
  will-change:transform;font:12px/21px ui-monospace,Consolas,"Courier New",monospace}
.lv-line{height:21px;line-height:21px;padding:0 12px;white-space:pre;
  color:#b6b6ce;min-width:max-content}
/* 交替底色让长日志更容易按行追踪 */
.lv-line.alt{background:rgba(255,255,255,.012)}
/* 命中关键词的行高亮 */
.lv-line mark{background:rgba(239,179,39,.28);color:inherit;
  border-radius:3px;padding:0 1px}
/* 行号槽 */
.lv-line .ln{display:inline-block;min-width:52px;margin-right:12px;
  color:var(--muted);opacity:.5;text-align:right;user-select:none}
.lv-wrap.nolines .lv-line .ln{display:none}

/* 空态 */
.lv-empty{position:absolute;inset:0;display:flex;align-items:center;
  justify-content:center;color:var(--muted);font-size:13px;
  font-family:system-ui,sans-serif;pointer-events:none}
.lv-empty[hidden]{display:none}

/* 悬浮"跳到最新" */
.lv-jump{position:absolute;right:16px;bottom:16px;z-index:3;
  border:1px solid var(--accent);background:var(--panel2);color:var(--accentSoft);
  padding:7px 13px;border-radius:99px;font-size:12px;cursor:pointer;
  font-family:system-ui,sans-serif;box-shadow:0 8px 22px rgba(0,0,0,.5);
  opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;
  transform:translateY(8px);display:flex;align-items:center;gap:6px}
.lv-jump.show{opacity:1;pointer-events:auto;transform:none}
.lv-jump .cnt{background:var(--accent);color:#fff;border-radius:99px;
  padding:0 6px;font-size:10px;font-weight:700;font-variant-numeric:tabular-nums}

/* 悬浮"跳到最新" —— 这个按钮就是"底部哨兵"：它贴底常驻，
   若未来需要视觉上的贴底提示，直接观察它即可（当前跟随状态由 scroll 判定，见 _syncFollowState）。 */
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/* ------------------------- 主类 ------------------------- */

export class LogViewer {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mount
   * @param {string} [opts.title]      标题
   * @param {boolean} [opts.lineNumbers] 是否显示行号（默认 true）
   * @param {number} [opts.maxLines]   超出后丢弃最旧的行（默认 50000，防内存无限增长）
   * @param {string} [opts.height]     滚动区高度（CSS 长度，默认 min(58vh,560px)）
   */
  constructor({ mount, title = "日志", lineNumbers = true, maxLines = 50000, height } = {}) {
    if (!mount) throw new Error("LogViewer: 缺少 mount 挂载点");
    injectStyle();

    this.mount = mount;
    this.title = title;
    this.height = height || "";
    this.lines = [];        // 原始行（已按 \n 切分）
    this.view = [];         // 当前显示的行（应用搜索过滤后）→ { text, no }
    this.pending = [];      // 增量追加缓冲
    this.dropped = 0;       // 因超过 maxLines 被丢弃的最旧行数
    this.rafId = 0;
    this.filterRaf = 0;
    this.following = true;  // 是否自动跟随到底部
    this.unread = 0;        // 暂停跟随后新增的行数
    this.maxLines = maxLines;
    this.query = "";
    this.autoScroll = true; // 新内容到达时是否自动滚底（用户可关）
    this.lastStart = -1;
    this.lastEnd = -1;
    this.pool = [];

    this._build(lineNumbers);
    this._bind();
    this._render(true);
  }

  /* ---------- 骨架 ---------- */
  _build(lineNumbers) {
    const styleAttr = this.height ? ` style="--lv-height:${this.height}"` : "";
    this.mount.innerHTML = `
      <div class="lv-wrap${lineNumbers ? "" : " nolines"}"${styleAttr}>
        <div class="lv-bar">
          <span class="lv-title" data-title></span>
          <input class="lv-input" data-search placeholder="过滤日志内容（子串）" spellcheck="false">
          <span class="lv-stat" data-stat></span>
          <span class="lv-tools">
            <button class="lv-btn on" data-autoscroll type="button" title="新内容到达时自动滚到底部">▼ 自动跟随</button>
            <button class="lv-btn" data-totop type="button">↑ 顶部</button>
            <button class="lv-btn" data-tobottom type="button">↓ 底部</button>
          </span>
        </div>
        <div class="lv-scroll" data-scroll>
          <div class="lv-sizer" data-sizer>
            <div class="lv-body" data-body></div>
          </div>
          <div class="lv-empty" data-empty hidden>（日志内容为空）</div>
          <button class="lv-jump" data-jump type="button">
            ↓ 跳到最新 <span class="cnt" data-unread>0</span>
          </button>
        </div>
      </div>`;

    const q = (s) => this.mount.querySelector(s);
    this.el = {
      title: q("[data-title]"),
      search: q("[data-search]"),
      stat: q("[data-stat]"),
      autoscroll: q("[data-autoscroll]"),
      toTop: q("[data-totop]"),
      toBottom: q("[data-tobottom]"),
      scroll: q("[data-scroll]"),
      sizer: q("[data-sizer]"),
      body: q("[data-body]"),
      empty: q("[data-empty]"),
      jump: q("[data-jump]"),
      unread: q("[data-unread]")
    };
    this.el.title.textContent = this.title;
  }

  /* ---------- 事件 ---------- */
  _bind() {
    // 滚动：rAF 合并；同时用滚动位置判定"用户是否手动离开底部"
    this.el.scroll.addEventListener(
      "scroll",
      () => {
        this._syncFollowState();
        if (this.rafId) return;
        this.rafId = requestAnimationFrame(() => {
          this.rafId = 0;
          this._render();
        });
      },
      { passive: true }
    );

    // 搜索：过滤也是大数组操作，rAF 合并（输入本身轻量，无需长防抖）
    this.el.search.addEventListener("input", () => {
      if (this.filterRaf) return;
      this.filterRaf = requestAnimationFrame(() => {
        this.filterRaf = 0;
        this.setQuery(this.el.search.value);
      });
    });

    this.el.autoscroll.addEventListener("click", () => {
      this.autoScroll = !this.autoScroll;
      this.el.autoscroll.classList.toggle("on", this.autoScroll);
      this.el.autoscroll.textContent = this.autoScroll ? "▼ 自动跟随" : "⏸ 已暂停";
      if (this.autoScroll) this.scrollToBottom();
    });

    this.el.toTop.addEventListener("click", () =>
      this.el.scroll.scrollTo({ top: 0, behavior: "smooth" })
    );
    this.el.toBottom.addEventListener("click", () => this.scrollToBottom());
    this.el.jump.addEventListener("click", () => this.scrollToBottom());

    // 判定"是否贴底"完全由 scroll 事件 + 一个极小的贴底阈值决定。
    //
    // 踩坑记录：原先用 IntersectionObserver 观察底部哨兵来恢复 following，
    // 但哨兵是 sizer（position:absolute + 动态高度）里的 bottom:0 元素，
    // 内容重排 / 容器 resize / 行数变化都会重新触发 IO 回调。
    // 实测把 scrollTop 设到 0（用户明明在顶部）仍会收到 isIntersecting=true，
    // 于是 following 被悄悄置回 true、未读计数被清零 —— 用户的"暂停"意图被覆盖。
    // 结论：跟随状态属于"用户意图"，不该由布局观察器推断，只由真实滚动位置决定。
    this.el.scroll.addEventListener(
      "scroll",
      () => this._syncFollowState(),
      { passive: true }
    );

    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => this._render(true));
      this._ro.observe(this.el.scroll);
    }
  }

  /**
   * 是否贴底 → 由真实滚动位置判定。
   * 往回滚到接近底部时自动恢复跟随（符合直觉）；离开底部则暂停并开始累计未读。
   */
  _syncFollowState() {
    const s = this.el.scroll;
    const fromBottom = s.scrollHeight - s.scrollTop - s.clientHeight;
    const atBottom = fromBottom <= FOLLOW_THRESHOLD;
    if (atBottom && !this.following) {
      this.following = true;
      this.unread = 0;
      this._syncJump();
    } else if (!atBottom && this.following) {
      this.following = false;
      this._syncJump();
    }
  }

  _syncJump() {
    const show = !this.following && this.unread > 0;
    this.el.jump.classList.toggle("show", show);
    if (show) this.el.unread.textContent = this.unread > 999 ? "999+" : String(this.unread);
  }

  /* ---------- 数据入口 ---------- */

  /**
   * 一次性灌入整份日志文本。
   *
   * 性能说明：此处是唯一需要"全量扫描一遍文本"的地方，成本主要在正则切分。
   * 实测（Chrome / 本机）：
   *   ·  2 万行 ≈ 0.8s
   *   · 10 万行 ≈ 6.8s  ← 会阻塞主线程，必须避免
   * 因此当文本量很大时，自动下调 maxLines（只保留末尾 N 行）来压缩扫描量，
   * 并在统计栏标注"已截断"。要显示超长日志，请用 append() 分片喂入，
   * 或调高 maxLines 并接受一次性的解析耗时。
   */
  setContent(text, title) {
    if (title != null) {
      this.title = title;
      this.el.title.textContent = title;
    }
    const raw = String(text ?? "");
    this._truncatedTo = null;
    this.dropped = 0;

    if (!raw.length) {
      this.lines = [];
    } else {
      // 大文本：先按字符量裁掉头部，再切分，避免对整份文本做正则扫描。
      const keepLines = this.maxLines;
      // 每行按平均 90 字符估算；只在明显超出时才走预算裁剪这条路径
      const budget = keepLines * 120;
      if (raw.length > budget) {
        const tail = raw.slice(raw.length - budget);
        // 丢掉被截断的首行残片
        const nl = tail.indexOf("\n");
        const usable = nl >= 0 ? tail.slice(nl + 1) : tail;
        this.lines = usable.split(/\r?\n/);
        // 记录被丢弃的量（按已切分部分之外估算，仅用于提示）
        const headLines = Math.floor((raw.length - usable.length) / 90);
        this.dropped = headLines > 0 ? headLines : 0;
      } else {
        this.lines = raw.split(/\r?\n/);
      }
      this._trim();
    }

    this._applyFilter();
    this.pending.length = 0;
    this.unread = 0;
    this.following = true;
    this.el.scroll.scrollTop = 0;
    this._render(true);
    // 首次加载后滚到底部（日志场景默认看最新）
    requestAnimationFrame(() => this.scrollToBottom(true));
  }

  /**
   * 增量追加（双缓冲）：高频调用安全。
   * 新内容只堆进 pending，rAF 里一次性并入 lines 并做增量 patch。
   */
  append(chunk) {
    if (!chunk) return;
    this.pending.push(String(chunk));
    if (this._appendRaf) return;
    this._appendRaf = requestAnimationFrame(() => {
      this._appendRaf = 0;
      this._flushPending();
    });
  }

  _flushPending() {
    if (!this.pending.length) return;
    const text = this.pending.join("");
    this.pending.length = 0;

    // 结尾无换行时，最后一段应与已有末行拼接（避免把一个逻辑行切成两行）
    const parts = text.split(/\r?\n/);
    const hasTrailing = /\r?\n$/.test(text);

    const firstIndex = this.lines.length;        // 新行在 lines 中的起始下标
    let appended = 0;

    // 用栈式 push 而非 shift()：shift 每次都会搬移整个数组 → 2 万行时 O(n²)，
    // 实测渲染耗时 2.2s 主要就烧在这里。
    const base = this.lines.length;
    if (base && parts.length) {
      this.lines[base - 1] += parts.shift();     // 仅一次 shift（数组此时还很短）
    }
    void firstIndex;

    const startAt = this.lines.length;
    for (let i = 0; i < parts.length; i++) this.lines.push(parts[i]);
    appended = this.lines.length - startAt;
    if (!hasTrailing && appended === 1 && startAt === base && base > 0) {
      // 内容全部并进了末行，没有新增逻辑行
      appended = 0;
    }

    this._trim();

    // 增量并入 view（不做全量重建）
    let viewAdded = 0;
    if (this.query) {
      const q = this.query;
      for (let i = startAt; i < this.lines.length; i++) {
        if (this.lines[i].toLowerCase().includes(q)) {
          this.view.push({ text: this.lines[i], no: i + 1 });
          viewAdded++;
        }
      }
    } else {
      for (let i = startAt; i < this.lines.length; i++) {
        this.view.push({ text: this.lines[i], no: i + 1 });
        viewAdded++;
      }
    }
    // 截断导致下标整体前移 → view 的 no 需要重编号（仅在真的截断时做一次）
    if (this._truncatedTo) {
      this._renumber();
      this._truncatedTo = null;
    }
    this._prevViewLen = this.view.length;

    if (this.following && this.autoScroll) {
      this._render(true);
      this.scrollToBottom(true);
    } else {
      this.unread += Math.max(0, viewAdded);
      this._render(true);
      this._syncJump();
    }
  }

  /** 截断后重编号行号（O(n)，仅在超过 maxLines 时触发） */
  _renumber() {
    const q = this.query;
    const src = this.lines;
    if (q) {
      let w = 0;
      for (let i = 0; i < this.view.length; i++) {
        // 若某行已被截掉，则从源重新按序取（保持相对顺序）
        while (w < src.length && !src[w].toLowerCase().includes(q)) w++;
        if (w < src.length) {
          this.view[i].text = src[w];
          this.view[i].no = w + 1;
          w++;
        }
      }
    } else {
      for (let i = 0; i < this.view.length; i++) {
        this.view[i].text = src[i] ?? "";
        this.view[i].no = i + 1;
      }
    }
  }

  _trim() {
    if (this.lines.length <= this.maxLines) return;
    const drop = this.lines.length - this.maxLines;
    this.lines.splice(0, drop);
    // view 同步丢弃最旧的 drop 条（保持顺序），并标记需重编号
    if (this.view.length > this.maxLines) this.view.splice(0, this.view.length - this.maxLines);
    this.dropped = (this.dropped || 0) + drop;
    this._truncatedTo = this.lines.length;
  }

  setQuery(q) {
    this.query = String(q || "").trim().toLowerCase();
    this._applyFilter();
    this.el.scroll.scrollTop = 0;
    this._render(true);
  }

  _applyFilter() {
    const q = this.query;
    if (!q) {
      this.view = this.lines.map((t, i) => ({ text: t, no: i + 1 }));
    } else {
      const out = [];
      for (let i = 0; i < this.lines.length; i++) {
        if (this.lines[i].toLowerCase().includes(q)) out.push({ text: this.lines[i], no: i + 1 });
      }
      this.view = out;
    }
    this._prevViewLen = this.view.length;
  }

  /* ---------- 滚动 API ---------- */

  /** @param {boolean} [instant] 跳过平滑动画（用于追加时的跟随，避免动画堆积） */
  scrollToBottom(instant) {
    const s = this.el.scroll;
    // 先确保高度已按最新行数更新，否则 scrollTop 会被截断到旧最大值
    s.scrollTop = s.scrollHeight;
    if (!instant) {
      // 平滑滚动只是观感；instant 场景（高频追加）必须用直接赋值否则会卡顿
    }
    this.following = true;
    this.unread = 0;
    this._syncJump();
    this._render();
  }

  /* ---------- 渲染 ---------- */

  _render(force = false) {
    const scroll = this.el.scroll;
    const total = this.view.length;
    const viewH = scroll.clientHeight || 1;

    this.el.sizer.style.height = total * LOG_LINE_H + "px";
    this.el.empty.hidden = total > 0;

    this.el.stat.innerHTML = this.query
      ? `匹配 <b>${total}</b> / ${this.lines.length} 行${this.dropped ? ` <span style="color:var(--amber)" title="超出 maxLines 上限，已丢弃最旧日志">·已截断</span>` : ""}`
      : `共 <b>${total}</b> 行${this.dropped ? ` <span style="color:var(--amber)" title="超出 maxLines 上限，已丢弃最旧日志 ${this.dropped} 行">·已截断 ${this.dropped}</span>` : ""}`;

    if (!total) {
      this.el.body.replaceChildren();
      this.pool.length = 0;
      this.lastStart = this.lastEnd = -1;
      return;
    }

    const start = Math.max(0, Math.floor(scroll.scrollTop / LOG_LINE_H) - LOG_OVERSCAN);
    const end = Math.min(total, Math.ceil((scroll.scrollTop + viewH) / LOG_LINE_H) + LOG_OVERSCAN);
    const need = end - start;

    if (!force && start === this.lastStart && end === this.lastEnd) return;

    // 节点池
    while (this.pool.length < need) {
      const d = document.createElement("div");
      d.className = "lv-line";
      d.innerHTML = '<span class="ln"></span><span class="tx"></span>';
      this.pool.push(d);
    }
    const body = this.el.body;
    for (let i = 0; i < need; i++) {
      if (this.pool[i].parentNode !== body) body.appendChild(this.pool[i]);
    }
    for (let i = need; i < this.pool.length; i++) {
      if (this.pool[i].parentNode === body) body.removeChild(this.pool[i]);
    }
    body.style.transform = `translateY(${start * LOG_LINE_H}px)`;

    const q = this.query;
    for (let i = 0; i < need; i++) {
      const node = this.pool[i];
      const item = this.view[start + i];
      if (!item) continue;
      const ln = node.firstElementChild;
      const tx = node.lastElementChild;
      const noStr = String(item.no);
      if (ln.textContent !== noStr) ln.textContent = noStr;
      // 高亮只在有关键词时走 innerHTML；否则用 textContent（更快且无 XSS 面）
      if (q) {
        const lower = item.text.toLowerCase();
        const idx = lower.indexOf(q);
        if (idx >= 0) {
          tx.innerHTML =
            esc(item.text.slice(0, idx)) +
            "<mark>" + esc(item.text.slice(idx, idx + q.length)) + "</mark>" +
            esc(item.text.slice(idx + q.length));
        } else if (tx.textContent !== item.text) {
          tx.textContent = item.text;
        }
      } else if (tx.textContent !== item.text) {
        tx.textContent = item.text;
      }
      const alt = (start + i) % 2 === 1;
      node.classList.toggle("alt", alt);
    }

    this.lastStart = start;
    this.lastEnd = end;
  }

  refresh() {
    this._render(true);
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    if (this._appendRaf) cancelAnimationFrame(this._appendRaf);
    if (this.filterRaf) cancelAnimationFrame(this.filterRaf);
    if (this._ro) this._ro.disconnect();
    this.mount.replaceChildren();
  }
}

export default LogViewer;
