/**
 * StatCards — 数据统计卡片（毛玻璃 / 类 HyperOS 风格，完整深色模式）
 * ---------------------------------------------------------------
 * 设计目标：
 *  1. 玻璃质感：backdrop-filter + 顶边高光 + 内描边，而非"半透明色块"
 *  2. 深色模式完备：四套主题共用同一套玻璃参数，主题只覆写色相
 *  3. 数据驱动：四张卡片由数组生成，不再 HTML 复制粘贴
 *  4. 数字稳定：font-variant-numeric: tabular-nums，避免数值跳动时宽度抖动
 *  5. 性能克制：backdrop-filter 有合成开销 → @supports 守卫 + reduced-motion 降级
 *
 * 用法：
 *   import { StatCards } from "./stat-cards.js";
 *   const cards = new StatCards({ mount: document.getElementById("cards") });
 *   cards.setData([
 *     { key:"total",   label:"任务总数",     value:423, hint:"定时任务",      tone:"accent" },
 *     { key:"running", label:"运行中",       value:6,   hint:"status = 0",   tone:"green", pulse:true },
 *     { key:"recent",  label:"24h 内执行过", value:381, hint:"按上次执行时间", tone:"accent",
 *       progress:0.9 },
 *     { key:"disabled",label:"已禁用",       value:36,  hint:"未参与调度",    tone:"amber",
 *       progress:0.085, progressTone:"amber" },
 *   ]);
 *   cards.update("running", { value: 7 });   // 原地更新单项（不重建 DOM）
 */

const STYLE_ID = "stat-cards-style";

/**
 * 玻璃参数集中在这里。四套主题只覆写色相（--accent 等），
 * 玻璃的三要素（底色/描边/顶边高光）由本组件统一提供，
 * 避免"每加一个主题就要补三行玻璃变量"的维护负担。
 */
const CSS = `
.sc-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}

/* ── 卡片本体 ── */
.sc-card{position:relative;isolation:isolate;min-width:0;
  border-radius:16px;padding:18px 18px 16px;overflow:hidden;
  /* 玻璃三要素：半透明底 + 细描边 + 顶边高光 */
  background:var(--sc-bg);
  border:1px solid var(--sc-brd);
  box-shadow:var(--sc-shadow);
  backdrop-filter:blur(14px) saturate(150%);
  -webkit-backdrop-filter:blur(14px) saturate(150%);
  transition:transform .18s cubic-bezier(.2,.7,.3,1),
             box-shadow .18s,border-color .18s}

/* 顶边高光：一条 1px 的渐变线，是"玻璃"感的关键，纯色块没有这个 */
.sc-card::before{content:"";position:absolute;top:0;left:12px;right:12px;height:1px;
  background:linear-gradient(90deg,transparent,var(--sc-hi) 22%,var(--sc-hi) 78%,transparent);
  opacity:.9;pointer-events:none}

/* 角落氛围光晕（跟随 tone 变色） */
.sc-card::after{content:"";position:absolute;z-index:-1;
  top:-56px;right:-42px;width:150px;height:150px;border-radius:50%;
  background:radial-gradient(circle,var(--sc-glow) 0%,transparent 70%);
  opacity:.5;pointer-events:none}

.sc-card:hover{transform:translateY(-2px);
  border-color:var(--sc-brd-hover);box-shadow:var(--sc-shadow-hover)}

/* ── 卡片头部：图标 + 标签 ── */
.sc-head{display:flex;align-items:center;gap:9px;margin-bottom:12px}
.sc-ico{width:28px;height:28px;border-radius:9px;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  font-size:14px;line-height:1;color:var(--sc-tone);
  background:var(--sc-tone-dim);border:1px solid var(--sc-tone-brd)}
.sc-label{color:var(--muted);font-size:13px;font-weight:500;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── 数值 ── */
.sc-num{font-size:clamp(24px,2.6vw,32px);font-weight:800;letter-spacing:-.02em;
  line-height:1.1;color:var(--sc-tone);
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
  display:flex;align-items:baseline;gap:6px}
.sc-unit{font-size:13px;font-weight:600;color:var(--muted);
  letter-spacing:0;font-variant-numeric:normal}

.sc-hint{margin-top:7px;font-size:11.5px;color:var(--muted);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── 运行中转圈点 ── */
.sc-pulse{width:7px;height:7px;border-radius:50%;background:var(--sc-tone);
  flex-shrink:0;position:relative;align-self:center}
.sc-pulse::after{content:"";position:absolute;inset:-3px;border-radius:50%;
  background:var(--sc-tone);opacity:.35;animation:scPulse 2s ease-out infinite}
@keyframes scPulse{0%{transform:scale(.6);opacity:.5}
  70%{transform:scale(1.9);opacity:0}100%{opacity:0}}

/* ── 迷你进度条 ── */
.sc-bar{margin-top:12px;height:5px;border-radius:99px;overflow:hidden;
  background:var(--sc-track)}
.sc-bar i{display:block;height:100%;border-radius:99px;width:0;
  background:linear-gradient(90deg,var(--sc-tone),var(--sc-tone-soft));
  transition:width .5s cubic-bezier(.2,.7,.3,1)}

/* ── tone 变体：只改"色相相关"的局部变量 ── */
.sc-card[data-tone="accent"]{--sc-tone:var(--accentSoft);--sc-tone-soft:var(--accent);
  --sc-tone-dim:var(--accentDim);--sc-tone-brd:var(--sc-brd)}
.sc-card[data-tone="green"]{--sc-tone:var(--green);--sc-tone-soft:var(--green);
  --sc-tone-dim:rgba(61,220,151,.12);--sc-tone-brd:rgba(61,220,151,.22)}
.sc-card[data-tone="amber"]{--sc-tone:var(--amber);--sc-tone-soft:var(--amber);
  --sc-tone-dim:rgba(239,179,39,.12);--sc-tone-brd:rgba(239,179,39,.22)}
.sc-card[data-tone="red"]{--sc-tone:var(--red);--sc-tone-soft:var(--red);
  --sc-tone-dim:rgba(255,100,124,.12);--sc-tone-brd:rgba(255,100,124,.22)}
.sc-card[data-tone="muted"]{--sc-tone:var(--text);--sc-tone-soft:var(--muted);
  --sc-tone-dim:rgba(146,146,173,.12);--sc-tone-brd:var(--sc-brd)}

/* ── 玻璃变量：定义在 :root，四套主题自动继承（保持深色为默认基调） ── */
:root{
  --sc-bg:rgba(255,255,255,.045);
  --sc-brd:rgba(255,255,255,.085);
  --sc-brd-hover:rgba(255,255,255,.16);
  --sc-hi:rgba(255,255,255,.5);
  --sc-glow:rgba(255,255,255,.07);
  --sc-track:rgba(255,255,255,.07);
  --sc-shadow:0 1px 2px rgba(0,0,0,.28),0 10px 28px -14px rgba(0,0,0,.6);
  --sc-shadow-hover:0 2px 4px rgba(0,0,0,.3),0 16px 36px -14px rgba(0,0,0,.7);
}

/* 浅色模式：显式声明式（data-scheme="light"）优先，不依赖系统偏好。
   ⚠️ 踩坑记录：之前只在 @media(prefers-color-scheme:light) 里覆写玻璃变量，
   但没有同时把「文字/数值色」也切成深色，结果是浅底 + 浅字 → 数字完全看不清。
   而且无头浏览器/部分环境默认报告 light，导致"本该深色的面板"意外套用了浅色底。
   所以：浅色模式必须同时给出 bg + brd + 文字色调，才是一个完整可用的主题。 */
body[data-scheme="light"]{
  --sc-bg:rgba(255,255,255,.66);
  --sc-brd:rgba(15,17,30,.09);
  --sc-brd-hover:rgba(15,17,30,.18);
  --sc-hi:rgba(255,255,255,.95);
  --sc-glow:rgba(15,17,30,.045);
  --sc-track:rgba(15,17,30,.08);
  --sc-shadow:0 1px 2px rgba(15,17,30,.06),0 10px 26px -16px rgba(15,17,30,.28);
  --sc-shadow-hover:0 2px 4px rgba(15,17,30,.09),0 16px 34px -16px rgba(15,17,30,.34);
  /* 浅色下主文字色由页面主题提供；但若页面没切，这里兜底保证对比度 */
  --sc-text-fallback:#141420;
  --sc-muted-fallback:#5c5c74;
}
/* 浅色模式下的 tone 也要加深，否则浅底上 #bca8ff 这类浅紫对比度不足 */
body[data-scheme="light"] .sc-card[data-tone="accent"]{--sc-tone:#5b3ed6;--sc-tone-soft:#7c5cff;--sc-tone-dim:rgba(109,74,255,.1);--sc-tone-brd:rgba(109,74,255,.2)}
body[data-scheme="light"] .sc-card[data-tone="green"]{--sc-tone:#0f8a5a;--sc-tone-soft:#12a06a;--sc-tone-dim:rgba(18,160,106,.1);--sc-tone-brd:rgba(18,160,106,.2)}
body[data-scheme="light"] .sc-card[data-tone="amber"]{--sc-tone:#9a6508;--sc-tone-soft:#b8790a;--sc-tone-dim:rgba(184,121,10,.1);--sc-tone-brd:rgba(184,121,10,.22)}
body[data-scheme="light"] .sc-card[data-tone="red"]{--sc-tone:#c22544;--sc-tone-soft:#d92b4b;--sc-tone-dim:rgba(217,43,75,.1);--sc-tone-brd:rgba(217,43,75,.2)}
body[data-scheme="light"] .sc-card[data-tone="muted"]{--sc-tone:#141420;--sc-tone-soft:#5c5c74}
body[data-scheme="light"] .sc-label,
body[data-scheme="light"] .sc-hint,
body[data-scheme="light"] .sc-unit{color:#5c5c74}

/* 系统偏好浅色 且 未显式声明深色时，才算浅色。
   （用户显式选择优先；无头环境默认 light 也不会把深色面板弄坏。） */
@media(prefers-color-scheme:light){
  body:not([data-scheme="dark"]):not([data-scheme="light"]){
    --sc-bg:rgba(255,255,255,.62);
    --sc-brd:rgba(15,17,30,.08);
    --sc-brd-hover:rgba(15,17,30,.16);
    --sc-hi:rgba(255,255,255,.95);
    --sc-glow:rgba(15,17,30,.04);
    --sc-track:rgba(15,17,30,.08);
    --sc-shadow:0 1px 2px rgba(15,17,30,.06),0 10px 26px -16px rgba(15,17,30,.25);
    --sc-shadow-hover:0 2px 4px rgba(15,17,30,.08),0 16px 34px -16px rgba(15,17,30,.3);
  }
  /* 只有页面确实是浅底时，才需要加深 tone；本项目默认深色，
     故这里不对 tone 做修改，避免"深色页面被浅色偏好误伤"。 */
}

/* 优雅降级：不支持 backdrop-filter 时不假装玻璃，改用实心面板色 */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
  .sc-card{background:var(--panel);backdrop-filter:none;-webkit-backdrop-filter:none}
  .sc-card::before{opacity:.35}
}

/* 动效敏感 / 低端设备：关掉动画与位移，保留静态玻璃观感 */
@media(prefers-reduced-motion:reduce){
  .sc-card,.sc-bar i{transition:none}
  .sc-card:hover{transform:none}
  .sc-pulse::after{animation:none;opacity:0}
}

/* ── 响应式 ── */
@media(max-width:1100px){.sc-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:520px){
  .sc-grid{grid-template-columns:1fr;gap:10px}
  .sc-card{padding:15px}
}
`;

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

/** 数字动画：从当前显示值过渡到目标值（用 rAF + easeOut，不用 setInterval） */
function animateNumber(from, to, dur, onFrame) {
  if (from === to) return () => {};
  let raf = 0;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
    onFrame(Math.round(from + (to - from) * e));
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}

export class StatCards {
  /**
   * @param {object} opts
   * @param {HTMLElement} opts.mount
   * @param {number} [opts.animationMs] 数字滚动时长，0 = 关闭
   */
  constructor({ mount, animationMs = 550 } = {}) {
    if (!mount) throw new Error("StatCards: 缺少 mount 挂载点");
    injectStyle();
    this.mount = mount;
    this.animationMs = animationMs;
    this.items = [];
    this.nodes = new Map(); // key -> { root, numEl, barEl, hintEl, ... }
    this.cancels = new Map();

    const grid = document.createElement("div");
    grid.className = "sc-grid";
    this.mount.replaceChildren(grid);
    this.grid = grid;
  }

  /**
   * @param {Array<{key,label,value,hint,tone,icon,unit,pulse,progress,progressTone}>} items
   */
  setData(items) {
    this.items = items || [];
    // 结构变化时才重建 DOM；纯数值变化走 update 路径
    this._rebuild();
  }

  _rebuild() {
    this.grid.replaceChildren();
    this.nodes.clear();
    for (const it of this.items) {
      this.grid.appendChild(this._createCard(it));
    }
  }

  _createCard(it) {
    const root = document.createElement("div");
    root.className = "sc-card";
    root.dataset.tone = it.tone || "accent";
    root.dataset.key = it.key;

    const progressHtml =
      it.progress != null
        ? `<div class="sc-bar"><i data-bar style="--w:${clamp01(it.progress)}"></i></div>`
        : "";

    root.innerHTML = `
      <div class="sc-head">
        <div class="sc-ico">${it.icon || "▦"}</div>
        <div class="sc-label"></div>
        ${it.pulse ? '<span class="sc-pulse" data-pulse></span>' : ""}
      </div>
      <div class="sc-num"><span data-num></span><span class="sc-unit" data-unit></span></div>
      <div class="sc-hint" data-hint></div>
      ${progressHtml}`;

    const node = {
      root,
      labelEl: root.querySelector(".sc-label"),
      numEl: root.querySelector("[data-num]"),
      unitEl: root.querySelector("[data-unit]"),
      hintEl: root.querySelector("[data-hint]"),
      barEl: root.querySelector("[data-bar]")
    };
    node.labelEl.textContent = it.label || "";
    node.unitEl.textContent = it.unit || "";
    node.hintEl.textContent = it.hint || "";
    node.hintEl.title = it.hint || "";
    node.numEl.textContent = fmtNum(it.value);
    node.rafDispose = () => {};
    if (node.barEl) {
      // 下一帧设宽度，让 transition 生效
      requestAnimationFrame(() => {
        node.barEl.style.width = clamp01(it.progress) * 100 + "%";
      });
    }
    if (it.progressTone) {
      root.dataset.progressTone = it.progressTone;
    }
    this.nodes.set(it.key, node);
    return root;
  }

  /** 原地更新单项（不重建 DOM）；changed = {value,hint,tone,progress,...} */
  update(key, changed = {}) {
    const node = this.nodes.get(key);
    if (!node) return;

    if ("value" in changed) {
      const from = Number(node.numEl.textContent.replace(/[^\d.-]/g, "")) || 0;
      const to = Number(changed.value) || 0;
      if (node.rafDispose) node.rafDispose();
      if (this.animationMs > 0 && Math.abs(to - from) > 0) {
        node.rafDispose = animateNumber(from, to, this.animationMs, (v) => {
          node.numEl.textContent = fmtNum(v);
        });
      } else {
        node.numEl.textContent = fmtNum(to);
      }
    }
    if ("hint" in changed) {
      node.hintEl.textContent = changed.hint || "";
      node.hintEl.title = changed.hint || "";
    }
    if ("label" in changed && changed.label != null) node.labelEl.textContent = changed.label;
    if ("tone" in changed && changed.tone) node.root.dataset.tone = changed.tone;
    if ("progress" in changed && node.barEl) {
      node.barEl.style.width = clamp01(changed.progress) * 100 + "%";
    }
  }

  /** 批量更新：{ key: changedObj } */
  updateAll(map) {
    for (const [k, v] of Object.entries(map || {})) this.update(k, v);
  }

  destroy() {
    for (const n of this.nodes.values()) if (n.rafDispose) n.rafDispose();
    this.nodes.clear();
    this.mount.replaceChildren();
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 千分位 + 保留最多 1 位小数 */
function fmtNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 1 });
}

export { fmtNum };
export default StatCards;
