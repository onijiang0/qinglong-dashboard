/**
 * poller — 数据层节流 / 防抖 / 退避封装（零依赖，原生 ES Module）
 * ---------------------------------------------------------------
 * 直击现有代码的第三座大山：
 *   `setInterval(() => { if (!document.hidden) loadTasks() }, 30000)`
 *   —— 无条件全量拉取、无视页面可见性、失败后仍按固定间隔硬撞。
 *
 * 提供两个东西：
 *   1. `throttle` / `debounce` —— 通用限流原语（带 leading/trailing 与 cancel）
 *   2. `Poller` —— 自管理轮询器：
 *      · 可见性门控：页面隐藏 / 切走 tab 自动停，回到前台立即补一次
 *      · 数据指纹：内容没变则不触发渲染回调（省掉无意义重绘）
 *      · 指数退避：连续失败时拉长间隔，成功即复位
 *      · 并发去重：上一次请求未返回则跳过本次（避免请求堆积）
 *      · 抖动：±15% 随机，避免多客户端同时打面板
 *
 * 用法：
 *   import { Poller, throttle, debounce } from "./poller.js";
 *
 *   const poller = new Poller({
 *     interval: 30000,
 *     fetcher: () => api("/api/tasks"),
 *     onData: (data, meta) => { if (meta.changed) vt.setData(data.data); },
 *   });
 *   poller.start();
 *   poller.poke();      // 手动触发一次（如点"刷新"按钮）
 *   poller.setInterval(15000);  // 动态改间隔
 */

/* ------------------------- 限流原语 ------------------------- */

/**
 * 节流：单位时间内最多执行一次（time window 模式）。
 * @param {Function} fn
 * @param {number} wait
 * @param {{leading?:boolean, trailing?:boolean}} [opts]
 */
export function throttle(fn, wait, { leading = true, trailing = true } = {}) {
  let last = 0;
  let timer = null;
  let lastArgs = null;
  let lastThis = null;

  const invoke = (t) => {
    last = t;
    fn.apply(lastThis, lastArgs);
    lastArgs = lastThis = null;
  };

  const throttled = function (...args) {
    const now = Date.now();
    if (!last && !leading) last = now;
    const remaining = wait - (now - last);
    lastArgs = args;
    lastThis = this;

    if (remaining <= 0 || remaining > wait) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke(now);
    } else if (!timer && trailing) {
      timer = setTimeout(() => {
        timer = null;
        invoke(Date.now());
      }, remaining);
    }
  };

  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    last = 0;
    lastArgs = lastThis = null;
  };
  throttled.flush = () => {
    if (timer && lastArgs) {
      clearTimeout(timer);
      timer = null;
      invoke(Date.now());
    }
  };
  return throttled;
}

/**
 * 防抖：停止触发 wait 毫秒后执行一次。
 * @param {Function} fn
 * @param {number} wait
 * @param {{leading?:boolean, maxWait?:number}} [opts]
 */
export function debounce(fn, wait, { leading = false, maxWait = 0 } = {}) {
  let timer = null;
  let maxTimer = null;
  let lastArgs = null;
  let lastThis = null;
  let calledLeading = false;

  const invoke = () => {
    if (!lastArgs) return;
    fn.apply(lastThis, lastArgs);
    lastArgs = lastThis = null;
  };

  const clear = () => {
    if (timer) clearTimeout(timer);
    if (maxTimer) clearTimeout(maxTimer);
    timer = maxTimer = null;
  };

  const debounced = function (...args) {
    lastArgs = args;
    lastThis = this;

    if (leading && !calledLeading) {
      calledLeading = true;
      invoke();
    }
    clear();
    timer = setTimeout(() => {
      timer = null;
      calledLeading = false;
      invoke();
    }, wait);

    // maxWait：即使一直在触发，也保证至少每 maxWait 执行一次
    if (maxWait > 0 && !maxTimer) {
      maxTimer = setTimeout(() => {
        maxTimer = null;
        calledLeading = true;
        invoke();
      }, maxWait);
    }
  };

  debounced.cancel = () => {
    clear();
    lastArgs = lastThis = null;
    calledLeading = false;
  };
  debounced.flush = () => {
    clear();
    invoke();
    calledLeading = false;
  };
  return debounced;
}

/* ------------------------- 轮询器 ------------------------- */

const DEFAULTS = {
  interval: 30000,
  minInterval: 5000,
  maxInterval: 300000, // 退避上限 5 分钟
  backoffFactor: 1.8,
  jitter: 0.15, // ±15%
  pauseWhenHidden: true,
  detectChange: true
};

export class Poller {
  /**
   * @param {object} opts
   * @param {() => Promise<any>} opts.fetcher  拉取函数
   * @param {(data:any, meta:{changed:boolean, first:boolean, durationMs:number, error?:Error}) => void} opts.onData
   * @param {(err:Error, meta:{failures:number, nextInterval:number}) => void} [opts.onError]
   * @param {number} [opts.interval]
   */
  constructor({ fetcher, onData, onError, interval, ...rest } = {}) {
    if (typeof fetcher !== "function") throw new Error("Poller: 缺少 fetcher");
    if (typeof onData !== "function") throw new Error("Poller: 缺少 onData");

    this.opts = { ...DEFAULTS, ...rest, ...(interval ? { interval } : {}) };
    this.fetcher = fetcher;
    this.onData = onData;
    this.onError = onError || (() => {});

    this.timer = null;
    this.running = false;
    this.inFlight = false;
    this.failures = 0;
    this.currentInterval = this.opts.interval;
    this.lastFingerprint = null;
    this.firstDone = false;
    this._onVisibility = null;
  }

  start({ immediate = true } = {}) {
    if (this.running) return;
    this.running = true;

    if (this.opts.pauseWhenHidden && typeof document !== "undefined") {
      this._onVisibility = () => {
        if (document.hidden) {
          clearTimeout(this.timer);
          this.timer = null;
        } else {
          // 回到前台：立刻补一次，然后恢复正常节奏
          this.poke();
        }
      };
      document.addEventListener("visibilitychange", this._onVisibility);
    }

    if (immediate) this.poke();
    else this._schedule();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    this.timer = null;
    if (this._onVisibility && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this._onVisibility);
      this._onVisibility = null;
    }
  }

  /** 手动立即触发一次（会跳过当前等待），并重置失败计数 */
  poke() {
    if (!this.running) this.running = true;
    clearTimeout(this.timer);
    this.timer = null;
    this._tick();
  }

  setInterval(ms) {
    this.opts.interval = Math.max(this.opts.minInterval, Number(ms) || 0);
    this.currentInterval = this.opts.interval;
    if (this.running) this._schedule();
  }

  /** 页面隐藏且开启了门控 → 不排下一次 */
  _schedule() {
    clearTimeout(this.timer);
    if (!this.running) return;
    if (this.opts.pauseWhenHidden && typeof document !== "undefined" && document.hidden) {
      this.timer = null;
      return; // visibilitychange 会唤醒
    }
    const j = 1 + (Math.random() * 2 - 1) * this.opts.jitter;
    const delay = Math.round(this.currentInterval * j);
    this.timer = setTimeout(() => this._tick(), delay);
  }

  async _tick() {
    if (this.inFlight) {
      // 上一次还没回来（慢请求）→ 跳过本次，不堆积
      this._schedule();
      return;
    }
    this.inFlight = true;
    const t0 = performance.now();
    try {
      const data = await this.fetcher();
      const durationMs = Math.round(performance.now() - t0);

      // 成功 → 复位退避
      this.failures = 0;
      this.currentInterval = this.opts.interval;

      let changed = true;
      if (this.opts.detectChange) {
        const fp = fingerprint(data);
        changed = fp !== this.lastFingerprint;
        this.lastFingerprint = fp;
      }
      const first = !this.firstDone;
      this.firstDone = true;

      this.onData(data, { changed, first, durationMs });
    } catch (error) {
      this.failures++;
      // 指数退避（带上限）
      this.currentInterval = Math.min(
        this.opts.maxInterval,
        this.opts.interval * Math.pow(this.opts.backoffFactor, this.failures)
      );
      this.onError(error, { failures: this.failures, nextInterval: this.currentInterval });
    } finally {
      this.inFlight = false;
      this._schedule();
    }
  }
}

/**
 * 轻量数据指纹：用于"内容没变就不重绘"。
 * 只抽取会驱动 UI 变化的字段，避免 JSON.stringify 全量序列化 500+ 条的开销。
 */
export function fingerprint(data) {
  const list = data?.data;
  if (!Array.isArray(list)) {
    // 非列表响应（如 /api/system）→ 退化为浅比较关键字段
    if (list && typeof list === "object") {
      return Object.keys(list)
        .map((k) => k + ":" + String(list[k]))
        .join("|");
    }
    return String(data?.code ?? data ?? "");
  }
  // 列表：id + status + isDisabled + lastExecutionTime 足以判定"需不需要重绘"
  let h = list.length + ":";
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    h += t.id + "," + t.status + "," + t.isDisabled + "," + (t.lastExecutionTime || 0) + ";";
  }
  return h;
}

export default Poller;
