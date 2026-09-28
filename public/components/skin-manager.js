/**
 * skin-manager.js — 零构建版「本地化皮肤与个性化定制系统」
 *
 * 对标 Vue3 + Pinia 那套方案的职责，但**不引入任何框架**：
 *   Pinia store 的 state     → 本类的 this.state
 *   store 的 applyTheme()    → 本类的 apply()
 *   root.style.setProperty() → 同一个思路，注入到 document.documentElement
 *   JSON 配置文件            → public/skins/*.json（浏览器原生 fetch 读取）
 *
 * 设计要点
 * ────────
 * 1. 「主题」与「皮肤」正交：主题（body[data-theme]）管色相，皮肤管材质
 *    （壁纸 / 遮罩 / 卡片透明度 / 模糊）。两者通过不同的 CSS 变量层叠加，
 *    互不覆盖 —— 换皮肤不会重置主题，换主题也不会丢壁纸。
 *
 * 2. ⚠️ 透明度必须走「RGB 三元组 + 独立 alpha」两段式，不能写死 rgba()。
 *    写死 rgba(17,17,27,.9) 想动态调到 .4 就只能整条规则换掉，做不到逐帧实时；
 *    改成 rgb(var(--panel-rgb) / var(--card-alpha)) 后，改一个数字即生效。
 *    这是整套「实时调节」能力的地基。
 *
 *    ⚠️⚠️ 但三元组必须是**空格分隔**（`17 17 27`），不能是逗号分隔（`17,17,27`）！
 *    现代 rgb() 的斜杠语法 `rgb(<channels> / <alpha>)` 要求 channels 空格分隔。
 *    写成逗号版本时该声明**语法非法、被整条丢弃**，而且不会回退到默认值 ——
 *    因为这条规则权重更高，「本该兜底」的 background:var(--sc-bg) 也救不回来，
 *    最终表现为元素背景彻底透明（实测 getComputedStyle 返回 rgba(0,0,0,0)）。
 *    这个 bug 很隐蔽：变量值打印出来是对的、CSS 也「看起来没问题」，
 *    只有断言最终计算值才会暴露。
 *
 * 3. 所有变量注入在 :root（documentElement）上，不在 body 上 ——
 *    因为 body 上有 data-theme 主题变量，两套东西放同一层容易互相踩。
 *
 * 4. 性能：setProperty 只写变化的键（不整批重写），并且壁纸/模糊这类
 *    触发合成的属性用 CSS transition 过渡，避免闪烁。
 */

const STORE_KEY = "ql_skin_v1";        // localStorage 键
const SKIN_DIR = "skins/";             // 相对 public/

/** 变量名集中管理，避免散落在代码里拼字符串 */
export const VARS = {
  wallpaper: "--skin-wallpaper",       // url(...) 或 none
  mask: "--skin-mask",                 // 遮罩透明度 0~1
  cardAlpha: "--card-alpha",           // 卡片/面板透明度 0~1
  blur: "--skin-blur",                 // 玻璃模糊 px
  accent: "--skin-accent",             // 可选：皮肤自带强调色
  masked: "--skin-masked",             // 0/1：是否启用壁纸（用于 ::before 显隐）
};

/** 一套皮肤的默认值。缺字段时用它兜底，保证任何时候都有完整状态 */
export const DEFAULTS = {
  id: "default",
  name: "纯净原版",
  desc: "",
  wallpaper: "",
  mask: 0.82,
  cardAlpha: 1,
  immersive: false,
  blur: 12,
  accent: "",
  theme: "",
};

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

export class SkinManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dir]        皮肤目录（相对站点根，默认 "skins/"）
   * @param {boolean}[opts.persist]    是否持久化到 localStorage
   * @param {Function}[opts.onChange]  状态变更回调 (state, changedKeys) => void
   */
  constructor({ dir = SKIN_DIR, persist = true, onChange } = {}) {
    this.dir = dir;
    this.persist = persist;
    this.onChange = onChange || (() => {});
    this.state = { ...DEFAULTS };
    this.list = [];                    // 可用皮肤元信息
    this._last = {};                   // 上一次写入的变量值，用于只写变化项
    this.applied = false;
  }

  /* ─────────────── 加载 ─────────────── */

  /** 读取清单 + 逐个皮肤文件。任何一个失败都不影响其余。 */
  async loadList() {
    let ids = [];
    try {
      const r = await fetch(this.dir + "index.json", { cache: "no-store" });
      if (r.ok) ids = (await r.json()).skins || [];
    } catch {
      // 清单拿不到时，退化为「只知道内置 default」，界面不至于空白
      ids = [DEFAULTS.id];
    }
    const out = [];
    for (const id of ids) {
      try {
        const r = await fetch(`${this.dir}${id}.json`, { cache: "no-store" });
        if (!r.ok) continue;
        out.push({ ...DEFAULTS, ...(await r.json()) });
      } catch {
        /* 单个皮肤损坏就跳过，不整体失败 */
      }
    }
    if (!out.length) out.push({ ...DEFAULTS });
    this.list = out;
    return out;
  }

  /* ─────────────── 应用 ─────────────── */

  /**
   * 把 state 注入 CSS 变量。只写变化过的键。
   * @param {object} [patch] 增量状态（可选）
   */
  apply(patch) {
    if (patch) Object.assign(this.state, patch);
    const s = this.state;

    // 沉浸模式是「cardAlpha 是否生效」的总开关，这里把它展开成最终值
    const finalCardAlpha = s.immersive ? clamp01(s.cardAlpha) : 1;

    const next = {
      [VARS.wallpaper]: s.wallpaper ? `url("${String(s.wallpaper).replace(/"/g, "%22")}")` : "none",
      [VARS.mask]: String(clamp01(s.mask)),
      [VARS.cardAlpha]: String(finalCardAlpha),
      [VARS.blur]: `${Math.max(0, Number(s.blur) || 0)}px`,
      [VARS.masked]: s.wallpaper ? "1" : "0",
    };
    // 强调色是可选覆盖：空字符串时要「撤销覆盖」而不是设成空值
    if (s.accent) next[VARS.accent] = s.accent;

    const root = document.documentElement.style;
    const changedKeys = [];
    for (const k in next) {
      if (this._last[k] !== next[k]) {
        root.setProperty(k, next[k]);
        this._last[k] = next[k];
        changedKeys.push(k);
      }
    }
    if (!s.accent && this._last[VARS.accent] !== undefined) {
      root.removeProperty(VARS.accent);
      delete this._last[VARS.accent];
      changedKeys.push(VARS.accent);
    }

    const needMaskedAttr = s.wallpaper ? "1" : "0";
    if (document.documentElement.dataset.skinWall !== needMaskedAttr) {
      document.documentElement.dataset.skinWall = needMaskedAttr;
    }

    this.applied = true;
    if (this.persist) this._save();
    // 首次 apply 时也要通知 —— 外部（如统计卡片）的联动变量需要在初始化阶段就被写入，
    // 否则要等到用户第一次拖动滑块才生效，表现为「初次进入卡片没背景」。
    const first = !this._notified;
    this._notified = true;
    if (changedKeys.length || first) this.onChange(this.state, changedKeys);
    return changedKeys;
  }

  /**
   * 切到某套皮肤（按 id 或直接给对象）。
   * 保留用户手改过的项会被皮肤覆盖 —— 这是「换肤」的预期语义。
   */
  use(idOrSkin) {
    const skin =
      typeof idOrSkin === "string"
        ? this.list.find((x) => x.id === idOrSkin)
        : idOrSkin;
    if (!skin) return false;
    // theme 字段是「皮肤联动主题」的可选能力，交给外部处理
    const { theme, ...rest } = skin;
    this.apply(rest);
    this.pendingTheme = theme || "";
    return true;
  }

  /* ─────────────── 单项调节（实时） ─────────────── */

  setWallpaper(url) { return this.apply({ wallpaper: String(url || "").trim() }); }
  setMask(v) { return this.apply({ mask: clamp01(v) }); }
  setCardAlpha(v) { return this.apply({ cardAlpha: clamp01(v) }); }
  setImmersive(on) { return this.apply({ immersive: !!on }); }
  setBlur(px) { return this.apply({ blur: Math.max(0, Number(px) || 0) }); }
  setAccent(color) { return this.apply({ accent: String(color || "").trim() }); }

  /** 恢复初始（不动主题） */
  reset() { this.apply({ ...DEFAULTS }); }

  /* ─────────────── 持久化 ─────────────── */

  _save() {
    try {
      localStorage.setItem(
        STORE_KEY,
        JSON.stringify({
          id: this.state.id,
          wallpaper: this.state.wallpaper,
          mask: this.state.mask,
          cardAlpha: this.state.cardAlpha,
          immersive: this.state.immersive,
          blur: this.state.blur,
          accent: this.state.accent,
        })
      );
    } catch {
      /* 隐私模式 / 配额满 → 静默降级为「本次会话有效」 */
    }
  }

  /** 启动时恢复上次状态：先 apply 默认值（保证变量齐全），再叠加存档 */
  restore() {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    } catch {
      saved = null;
    }
    const base = this.list.find((x) => x.id === (saved && saved.id)) || null;
    this.apply(base ? { ...base, ...saved } : saved || {});
    return this.state;
  }
}

export default SkinManager;
