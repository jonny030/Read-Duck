import { collect, resetMarks } from './collector.js';
import * as renderer from './renderer.js';
import * as ui from './ui.js';
import { TaskQueue, isAbort } from '../ai/queue.js';
import {
  translateText, checkAvailability,
  NeedsUserActivationError, TranslatorUnavailableError, destroyAll as destroyTranslators,
} from '../ai/translator-pool.js';
import { detectPageLanguage, detectLanguage, MIN_DETECT_LENGTH } from '../ai/detector.js';
import { sameLanguage, canonical, languageName } from '../ai/languages.js';
import { mightAlreadyBe } from './script-detect.js';
import { explainUnavailable, permissionsPolicyAllows } from '../ai/capability.js';
import { cacheKey } from '../lib/hash.js';
import { MSG, send } from '../lib/messaging.js';
import { debounce } from '../lib/dom-utils.js';

/**
 * 雙語對照的核心引擎。
 *
 * 排程策略：只翻譯「使用者快要看到」的段落。內建翻譯 API 是序列化處理的，
 * 一次把整頁 500 段全丟進去，使用者眼前那一段會排在最後面才輪到。
 * 所以用 IntersectionObserver 把可視區的段落插隊、把捲出畫面的取消掉。
 */

const VIEWPORT_MARGIN = '800px 0px';
const CACHE_FLUSH_SIZE = 25;
const CACHE_FLUSH_MS = 1500;

export class PageTranslator {
  #settings;
  #onState;
  #queue;
  #io = null;
  #mo = null;
  #enabled = false;
  #sourceLanguage = null;
  /** id -> unit */
  #units = new Map();
  /** id -> AbortController */
  #inflight = new Map();
  #cacheBuffer = [];
  #flushTimer = null;
  #stats = { total: 0, done: 0, failed: 0 };
  #downloadToast = null;
  #warned = new Set();
  /** 網站用 Permissions-Policy 擋掉 content script 的呼叫時，改走 offscreen document */
  #useOffscreen = false;

  constructor({ settings, onState }) {
    this.#settings = settings;
    this.#onState = onState ?? (() => {});
    this.#queue = new TaskQueue(settings.concurrency);
  }

  get enabled() { return this.#enabled; }
  get sourceLanguage() { return this.#sourceLanguage; }
  get stats() { return { ...this.#stats, pending: this.#queue.size + this.#queue.running }; }

  updateSettings(patch) {
    this.#settings = { ...this.#settings, ...patch };
    if (patch.concurrency) this.#queue.setLimit(patch.concurrency);
    if (patch.translationStyle) renderer.setStyle(patch.translationStyle);
    if (patch.translationFontScale) renderer.setFontScale(patch.translationFontScale);
  }

  /* ------------------------------------------------------------ 開關 */

  async enable() {
    if (this.#enabled) return true;
    this.#enabled = true;
    renderer.setStyle(this.#settings.translationStyle);
    renderer.setFontScale(this.#settings.translationFontScale);

    // 網站可以用 `Permissions-Policy: translator=()` 停用這個頁面的內建翻譯。
    // 這種情況下改由 offscreen document 執行 —— 那是擴充功能自己的來源，
    // 不受網站的 Permissions Policy 管轄。
    this.#useOffscreen = !permissionsPolicyAllows('translator');
    if (this.#useOffscreen) {
      console.info('[ReadDuck] 這個網站以 Permissions-Policy 停用了內建翻譯，改用 offscreen document 執行。');
    }

    const ok = await this.#scan(document.body, { initial: true });
    if (!ok) {
      this.#enabled = false;
      return false;
    }
    this.#installMutationObserver();
    this.#emit();
    return true;
  }

  disable() {
    this.#enabled = false;
    this.#queue.clear();
    for (const ac of this.#inflight.values()) ac.abort();
    this.#inflight.clear();
    this.#io?.disconnect();
    this.#io = null;
    this.#mo?.disconnect();
    this.#mo = null;
    this.#scheduleRescan.cancel?.();
    renderer.teardown();
    resetMarks();
    this.#units.clear();
    this.#stats = { total: 0, done: 0, failed: 0 };
    this.#downloadToast?.close();
    this.#downloadToast = null;
    this.#flushCache();
    this.#emit();
  }

  destroy() {
    this.disable();
    destroyTranslators();
  }

  /* ---------------------------------------------------------- 掃描 */

  async #scan(root, { initial = false } = {}) {
    const units = collect(root, { minTextLength: this.#settings.minTextLength });
    if (!units.length) return true;

    if (!this.#sourceLanguage) {
      const detected = await detectPageLanguage(units.map((u) => u.text));
      if (!detected) {
        if (initial) {
          ui.showToast('無法判斷這個頁面的語言，請確認裝置端語言偵測模型已下載。');
          return false;
        }
        return true;
      }
      this.#sourceLanguage = detected.language;

      if (sameLanguage(this.#sourceLanguage, this.#settings.targetLanguage)) {
        ui.showToast(`這個頁面已經是${languageName(this.#sourceLanguage)}，不需要翻譯。`);
        return false;
      }

      const availability = await checkAvailability(this.#sourceLanguage, this.#settings.targetLanguage);
      if (availability === 'unavailable') {
        const info = explainUnavailable('unavailable', '翻譯');
        ui.showToast(
          `${languageName(this.#sourceLanguage)} → ${languageName(this.#settings.targetLanguage)} 目前無法翻譯。\n${info.body}`,
          { timeout: 12000 }
        );
        return false;
      }
    }

    const usable = [];
    for (const unit of units) {
      if (await this.#shouldSkip(unit)) {
        // 標記留著，避免下一輪掃描又檢查一次
        continue;
      }
      this.#units.set(unit.id, unit);
      usable.push(unit);
    }
    if (!usable.length) return true;

    this.#stats.total += usable.length;
    await this.#applyCache(usable);
    this.#observe(usable.filter((u) => !renderer.has(u.id)));
    this.#emit();
    return true;
  }

  /** 段落本身就已經是目標語言時跳過（混合語言頁面很常見）。 */
  async #shouldSkip(unit) {
    const target = this.#settings.targetLanguage;
    // 書寫系統就不同 -> 一定要翻，不必動用偵測模型
    if (!mightAlreadyBe(unit.text, target)) return false;
    if (unit.text.length < MIN_DETECT_LENGTH) return true; // 太短又長得像目標語言，跳過比誤翻好
    const r = await detectLanguage(unit.text.slice(0, 300));
    return r ? sameLanguage(r.language, target) : true;
  }

  /* ---------------------------------------------------------- 快取 */

  async #applyCache(units) {
    if (!this.#settings.cacheEnabled) return;
    const src = this.#sourceLanguage;
    const tgt = canonical(this.#settings.targetLanguage);
    const keys = units.map((u) => cacheKey(u.text, src, tgt));
    const hits = await send(MSG.CACHE_GET, { keys });
    if (!hits) return;
    units.forEach((unit, i) => {
      const v = hits[keys[i]];
      if (v) {
        renderer.setText(unit, v);
        this.#stats.done++;
      }
    });
  }

  #bufferCache(text, translated) {
    if (!this.#settings.cacheEnabled) return;
    this.#cacheBuffer.push({
      k: cacheKey(text, this.#sourceLanguage, canonical(this.#settings.targetLanguage)),
      v: translated,
    });
    if (this.#cacheBuffer.length >= CACHE_FLUSH_SIZE) {
      this.#flushCache();
    } else {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = setTimeout(() => this.#flushCache(), CACHE_FLUSH_MS);
    }
  }

  #flushCache() {
    clearTimeout(this.#flushTimer);
    if (!this.#cacheBuffer.length) return;
    const entries = this.#cacheBuffer.splice(0, this.#cacheBuffer.length);
    send(MSG.CACHE_PUT, { entries });
  }

  /* ------------------------------------------------------- 可視區排程 */

  #observe(units) {
    if (!units.length) return;
    if (!this.#io) {
      this.#io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const id = entry.target.getAttribute('data-readduck-id');
          const unit = id && this.#units.get(id);
          if (!unit) continue;
          if (entry.isIntersecting) {
            this.#enqueue(unit, entry.intersectionRect.top);
          } else {
            // 捲出畫面而且還沒開始翻的，直接取消，把配額讓給眼前的段落
            const ac = this.#inflight.get(unit.id);
            if (ac && !ac.started) ac.abort();
          }
        }
      }, { rootMargin: VIEWPORT_MARGIN });
    }
    for (const unit of units) this.#io.observe(unit.el);
  }

  #enqueue(unit, viewportTop = 0) {
    if (this.#inflight.has(unit.id) || renderer.has(unit.id)) return;

    const ac = new AbortController();
    ac.started = false;
    this.#inflight.set(unit.id, ac);
    renderer.setPending(unit);

    // 越靠近視窗上緣越先翻
    const priority = Math.abs(viewportTop);

    this.#queue
      .add((signal) => { ac.started = true; return this.#translateUnit(unit, signal); },
        { priority, signal: ac.signal, key: unit.id })
      .catch((err) => {
        if (isAbort(err)) {
          renderer.remove(unit.id);
          return;
        }
        this.#stats.failed++;
        this.#handleError(err, unit);
      })
      .finally(() => {
        this.#inflight.delete(unit.id);
        this.#io?.unobserve(unit.el);
        this.#emit();
      });
  }

  async #translateUnit(unit, signal) {
    const translated = this.#useOffscreen
      ? await this.#translateViaOffscreen(unit.text)
      : await translateText(
        unit.text,
        this.#sourceLanguage,
        this.#settings.targetLanguage,
        {
          signal,
          onChunk: (partial) => renderer.setText(unit, partial),
          onDownloadProgress: (loaded) => this.#showDownloadProgress(loaded),
        }
      );
    if (signal?.aborted) return;
    this.#downloadToast?.close();
    this.#downloadToast = null;
    renderer.setText(unit, translated);
    this.#stats.done++;
    this.#bufferCache(unit.text, translated);
  }

  /** 走 offscreen document 時沒有串流，只能整段回來。 */
  async #translateViaOffscreen(text) {
    const res = await send(MSG.TRANSLATE_VIA_OFFSCREEN, {
      text,
      sourceLanguage: this.#sourceLanguage,
      targetLanguage: this.#settings.targetLanguage,
    });
    if (!res?.ok) throw new Error(res?.error || 'offscreen document 無回應');
    return res.translated;
  }

  #showDownloadProgress(loaded) {
    const pct = Math.round(loaded * 100);
    if (!this.#downloadToast) {
      this.#downloadToast = ui.showToast('正在下載裝置端翻譯模型（只需下載一次）…', {
        timeout: 0,
        progress: loaded,
      });
    }
    this.#downloadToast.update(`正在下載裝置端翻譯模型（只需下載一次）… ${pct}%`, loaded);
  }

  #handleError(err, unit) {
    if (err instanceof NeedsUserActivationError) {
      renderer.remove(unit.id);
      this.#warnOnce('activation', () => {
        ui.showToast('第一次使用需要下載模型，瀏覽器規定必須由你點一下才能開始。', {
          timeout: 0,
          actions: [{
            label: '開始下載',
            onClick: (t) => { t.close(); this.#retryAll(); },
          }],
        });
      });
      return;
    }
    if (err instanceof TranslatorUnavailableError) {
      renderer.setError(unit, '此語言對不支援');
      this.#warnOnce('unavailable', () => {
        ui.showToast(
          `${languageName(err.sourceLanguage)} → ${languageName(err.targetLanguage)} 這個語言組合目前無法翻譯。`,
          { timeout: 10000 }
        );
      });
      return;
    }
    console.warn('[ReadDuck] 段落翻譯失敗', err);
    renderer.setError(unit, `翻譯失敗：${err?.message || err}。點此重試`, () => {
      renderer.remove(unit.id);
      this.#stats.failed = Math.max(0, this.#stats.failed - 1);
      this.#enqueue(unit, 0);
    });
  }

  #warnOnce(key, fn) {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    fn();
  }

  /** user activation 拿到之後，把畫面上還沒翻的重新排一次。 */
  #retryAll() {
    this.#warned.delete('activation');
    for (const unit of this.#units.values()) {
      if (!renderer.has(unit.id)) this.#enqueue(unit, 0);
    }
  }

  /* -------------------------------------------------- 動態內容 */

  #scheduleRescan = debounce(() => {
    if (!this.#enabled) return;
    this.#scan(document.body).catch((e) => console.warn('[ReadDuck] rescan failed', e));
  }, 400);

  #installMutationObserver() {
    this.#mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        // 忽略自己注入的節點，否則會無限迴圈
        if (m.target instanceof Element && m.target.closest('[data-readduck]')) continue;
        for (const node of m.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute?.('data-readduck')) continue;
          if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
            this.#scheduleRescan();
            return;
          }
        }
      }
    });
    this.#mo.observe(document.body, { childList: true, subtree: true });
  }

  #emit() {
    this.#onState(this.stats);
  }
}
