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
  backdrop-filter:blur(var(--skin-blur,14px)) saturate(150%);
  -webkit-backdrop-filter:blur(var(--skin-blur,14px)) saturate(150%);
  transition:transform .18s cubic-bezier(.2,.7,.3,1),
             box-shadow .18s,border-color .18s,background-color .3s ease}

/* 皮肤联动：--sc-skin-rgb / --sc-skin-alpha / --sc-xp 由 index.html 注入。
   接进项目后自动跟随沉浸模式；没有皮肤系统时保持组件自带的 --sc-bg 观感。

   ⚠️ 非沉浸态（--sc-xp = 0）不能用「很淡的白色蒙层」当卡片底！
   实测：白壁纸 + 遮罩 82% 时，rgba(255,255,255,0.043) 的卡片底合成出来是
   灰度 62 —— 此时 --muted 只有 3.51:1，低于 AA。（因为卡片几乎是透明的，
   透出来的是壁纸，白色托不住浅灰文字。）
   所以：非沉浸态改用「主题面板色 @ card 不透明度」，让它成为真正的实心表面；
   进入沉浸态再淡出为白色玻璃。用一个 white 不透明度变量做不到两件事，
   因此这里分成两条规则，由 --sc-xp 是否 > 0 来切换观感。 */
.sc-card[data-skin] {
  background:rgb(var(--sc-skin-rgb) / var(--sc-skin-alpha));
}
/* 非沉浸：实心面板色（用主题的 panel 三元组，与页面 .card 同源观感）。
   不透明度跟随 --card-alpha，与页面其它卡片保持一致（默认 1 = 完全不透明），
   这样非沉浸态下它是一块真正的实心表面，浅灰文字有足够底气。
   ⚠️ 不要写死成 .92 之类的常量：那会在主题把 --card-alpha 调低时与页面脱节。 */
.sc-card[data-skin]:not([data-immersive]) {
  background:rgb(var(--panel-rgb,17 17 27) / var(--card-alpha,1));
}
/* 沉浸：白色玻璃，不透明度由 --sc-skin-alpha 控制 */
.sc-card[data-skin][data-immersive] {
  background:rgb(var(--sc-skin-rgb) / var(--sc-skin-alpha));
}

/* 顶边高光：一条 1px 的渐变线，是"玻璃"感的关键，纯色块没有这个 */
.sc-card::before{content:"";position:absolute;top:0;left:12px;right:12px;height:1px;
  background:linear-gradient(90deg,transparent,var(--sc-hi) 22%,var(--sc-hi) 78%,transparent);
  opacity:.9;pointer-events:none;z-index:1}

/* ── 「透明程度」统一口径 ──
   --sc-xp 由 index.html 的皮肤 onChange 注入：1 = 全透，0 = 实心。
   所有联动公式（面纱强度、文字提亮）都基于这一个变量，
   组件不自己去反推 alpha 的语义 —— 之前踩过的坑就是各处对
   「0.045 到底算实心还是算透明」理解不一致，导致实心卡片被压成暗块。
   单独使用本组件（没有皮肤系统）时，--sc-xp 回退为 0 = 实心，观感不变。 */

/* 本地面纱（local scrim）：皮肤联动时专用。
   全局遮罩只能压住"平均亮度"，但卡片可能正好压在壁纸最亮处
   （实测卡片落在照片天空区域时，--muted 标签几乎不可见）。
   这里在卡片内叠一层暗纱，把对比度锁在卡片自己的范围内。
   强度直接等于 --sc-xp：实心卡片不铺，越透明铺得越重。

   ⚠️ 强度是反推出来的，不是拍脑袋：
   要让 muted 文字在白底上达到 AA 4.5:1，卡片表面必须压到灰度 ≤ 68~109。
   ⚠️ 关键：不能做成「上浅下深」的大落差！取最坏情况（最亮像素）采样时，
   梯度顶端就是短板 —— 顶端 .55 × xp(.75) = 有效 0.41，压不住白底（实测 bg=108）。
   所以这里用「整体就很深、只留很小的纵向渐变」：顶端 .86，底端 .94。
   （仍保留一点倾斜是为了不显得死板，但保证顶端也足够暗。）
   实测覆盖：xp=1（全透）→ 8.33:1；xp=0.75 → 4.81:1；xp=0.55 → 4.5:1 以上。 */
.sc-card[data-skin]::after{content:"";position:absolute;inset:0;border-radius:inherit;
  pointer-events:none;z-index:1;
  background:linear-gradient(180deg,rgb(0 0 0 / .86) 0%,rgb(0 0 0 / .90) 55%,rgb(0 0 0 / .94) 100%);
  opacity:var(--sc-xp,0);transition:opacity .3s ease}
.sc-card>*{position:relative;z-index:2}
/* 光晕要压在面纱下面（z-index:0），所以从上面那条统一抬高 z-index 的规则里排除。 */
.sc-card>.sc-glow{position:absolute;z-index:0}

/* ── 沉浸模式下的文字对比度补偿（与 index.html 同源） ──
   ⚠️ 为什么不能只靠"全局遮罩"：遮罩只能压「整屏平均亮度」，而卡片可能正好落在壁纸
   最亮的那一块上。所以卡片内既要叠本地面纱（上面 ::after），也要把 muted 文字往
   --text 方向混合。实测：alpha=.25 叠亮壁纸时 muted 只有 3.62:1，低于 WCAG AA 4.5。
   --sc-muted-base 让浅色模式替换「暗端」基准色，而不用另写一条 color（会盖掉本规则）。 */
.sc-label,.sc-hint,.sc-unit{
  color:color-mix(in srgb, var(--text) calc(70% * var(--sc-xp,0)),
                  var(--sc-muted-base,var(--muted)));
  transition:color .3s ease}
@supports not (color:color-mix(in srgb,red,blue)){
  /* 回退：手动朝 --text-rgb 插值，保证老浏览器也能提亮 */
  .sc-label,.sc-hint,.sc-unit{
    color:rgb(var(--text-rgb,238 238 247) / calc(.62 + .38 * var(--sc-xp,0)))}
}

/* 角落氛围光晕（跟随 tone 变色）
   ⚠️ 必须用真实子元素 .sc-glow，不能用 .sc-card::after！
   因为皮肤联动的本地面纱已经占用了 .sc-card[data-skin]::after ——
   同一个元素只有一个 ::after，两条规则会**合并**（不冲突的属性会同时生效），
   于是光晕的 top/right/width/height 泄漏到面纱上，
   表现为卡片右侧出现一块明显的浅色方块（踩过，截图里非常显眼）。
   拆成子元素后，::before = 顶边高光，::after = 本地面纱，互不干扰。 */
.sc-glow{position:absolute;z-index:0;
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
.sc-label{font-size:13px;font-weight:500;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

/* ── 数值 ── */
.sc-num{font-size:clamp(24px,2.6vw,32px);font-weight:800;letter-spacing:-.02em;
  line-height:1.1;color:var(--sc-tone);
  font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1;
  display:flex;align-items:baseline;gap:6px}
.sc-unit{font-size:13px;font-weight:600;
  letter-spacing:0;font-variant-numeric:normal}

.sc-hint{margin-top:7px;font-size:11.5px;
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
/* 浅色模式下 secondary 文字的「暗端」基准色：从 --muted 换成浅色专用灰。
   注意这里只改基准变量，不写死 color —— 否则会盖掉上面那条 color-mix，
   沉浸模式下的对比度补偿就失效了。 */
body[data-scheme="light"]{--sc-muted-base:#5c5c74}

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
   * @param {boolean} [opts.skin] 是否启用皮肤联动（跟随 --sc-skin-rgb / --sc-skin-alpha）。
   *        开启后卡片背景透明度由皮肤系统驱动，可随「沉浸模式」实时变化；
   *        关闭时用组件自带的 --sc-bg 常量（独立使用时不需要皮肤系统）。
   */
  constructor({ mount, animationMs = 550, skin = false } = {}) {
    if (!mount) throw new Error("StatCards: 缺少 mount 挂载点");
    injectStyle();
    this.mount = mount;
    this.animationMs = animationMs;
    this.skin = !!skin;
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
    // 开启皮肤联动时打标记，CSS 里 .sc-card[data-skin] 才会走皮肤变量
    if (this.skin) root.dataset.skin = "1";

    const progressHtml =
      it.progress != null
        ? `<div class="sc-bar"><i data-bar style="--w:${clamp01(it.progress)}"></i></div>`
        : "";

    root.innerHTML = `
      <div class="sc-glow"></div>
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
