/**
 * 有並行上限的工作佇列，支援優先權與取消。
 *
 * 為什麼需要：內建翻譯 API 本身是序列化處理的（請求會排隊），一次丟 300 段
 * 進去只會讓「使用者正在看的那一段」排在最後面。這個佇列讓可視區的段落
 * 可以插隊，捲出畫面的工作可以直接取消。
 */
export class TaskQueue {
  #limit;
  #running = 0;
  #items = [];       // { priority, seq, run, resolve, reject, cancelled }
  #seq = 0;
  #paused = false;

  constructor(limit = 3) {
    this.#limit = Math.max(1, limit);
  }

  get size() { return this.#items.length; }
  get running() { return this.#running; }

  setLimit(n) {
    this.#limit = Math.max(1, n | 0);
    this.#pump();
  }

  pause() { this.#paused = true; }
  resume() { this.#paused = false; this.#pump(); }

  /**
   * @param {(signal: AbortSignal) => Promise<any>} run
   * @param {{ priority?: number, signal?: AbortSignal, key?: any }} opts
   *        priority 越小越先跑。
   */
  add(run, { priority = 0, signal, key } = {}) {
    return new Promise((resolve, reject) => {
      const item = { priority, seq: this.#seq++, run, resolve, reject, key, cancelled: false, signal };
      if (signal) {
        if (signal.aborted) return reject(abortError());
        signal.addEventListener('abort', () => {
          if (item.cancelled) return;
          item.cancelled = true;
          const i = this.#items.indexOf(item);
          if (i >= 0) {
            this.#items.splice(i, 1);
            reject(abortError());
          }
        }, { once: true });
      }
      this.#items.push(item);
      this.#pump();
    });
  }

  /** 重新指定某個 key 的優先權（例如段落捲進畫面了）。 */
  reprioritize(key, priority) {
    for (const item of this.#items) {
      if (item.key === key) item.priority = priority;
    }
  }

  /** 清掉所有還沒開始的工作。已經在跑的無法從這裡中止，請用各自的 signal。 */
  clear() {
    const pending = this.#items.splice(0, this.#items.length);
    for (const item of pending) {
      item.cancelled = true;
      item.reject(abortError());
    }
  }

  #pump() {
    while (!this.#paused && this.#running < this.#limit && this.#items.length) {
      // 每次取最小 priority，同 priority 依加入順序（穩定）
      let best = 0;
      for (let i = 1; i < this.#items.length; i++) {
        const a = this.#items[i], b = this.#items[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      const item = this.#items.splice(best, 1)[0];
      if (item.cancelled) continue;

      this.#running++;
      Promise.resolve()
        .then(() => item.run(item.signal))
        .then(item.resolve, item.reject)
        .finally(() => {
          this.#running--;
          this.#pump();
        });
    }
  }
}

export function abortError() {
  return new DOMException('Aborted', 'AbortError');
}

export function isAbort(err) {
  return err?.name === 'AbortError';
}
