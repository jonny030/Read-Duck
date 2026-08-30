import { normalizeAvailability, describeError } from './capability.js';
import { canonical } from './languages.js';

/**
 * Translator 實例池。
 *
 * 同一個語言對重複 create() 很浪費（每次都要初始化模型），所以以
 * `${src}>${tgt}` 為 key 快取。閒置一段時間後 destroy() 釋放記憶體 ——
 * 不 destroy 的話這些實例會一直佔著，長時間開著的分頁會很吃記憶體。
 */

const IDLE_TIMEOUT_MS = 5 * 60_000;

/** create() 需要 sticky user activation。用這個錯誤讓 UI 知道要請使用者點一下。 */
export class NeedsUserActivationError extends Error {
  constructor() {
    super('Translator.create() 需要使用者互動');
    this.name = 'NeedsUserActivationError';
  }
}

export class TranslatorUnavailableError extends Error {
  constructor(availability, sourceLanguage, targetLanguage) {
    super(`Translator 不可用 (${availability}) for ${sourceLanguage} -> ${targetLanguage}`);
    this.name = 'TranslatorUnavailableError';
    this.availability = availability;
    this.sourceLanguage = sourceLanguage;
    this.targetLanguage = targetLanguage;
  }
}

const pool = new Map();          // key -> { promise, instance, timer }
const availabilityCache = new Map(); // key -> availability（不快取 downloading，狀態會變）

function key(src, tgt) { return `${src}>${tgt}`; }

export function isTranslatorPresent() {
  return typeof self !== 'undefined' && 'Translator' in self;
}

export async function checkAvailability(sourceLanguage, targetLanguage) {
  const src = canonical(sourceLanguage);
  const tgt = canonical(targetLanguage);
  const k = key(src, tgt);
  const cached = availabilityCache.get(k);
  if (cached === 'available' || cached === 'unavailable') return cached;

  if (!isTranslatorPresent()) return 'unavailable';
  try {
    const a = normalizeAvailability(
      await self.Translator.availability({ sourceLanguage: src, targetLanguage: tgt })
    );
    availabilityCache.set(k, a);
    return a;
  } catch (e) {
    console.warn('[ReadDuck] Translator.availability failed:', describeError(e));
    return 'unavailable';
  }
}

/**
 * 取得（或建立）Translator。
 * @param {object} opts
 * @param {(loaded:number)=>void} [opts.onDownloadProgress] 0~1
 * @param {boolean} [opts.requireActivation] 若模型尚未下載，是否堅持要有 user activation
 */
export async function getTranslator(sourceLanguage, targetLanguage, opts = {}) {
  const src = canonical(sourceLanguage);
  const tgt = canonical(targetLanguage);
  const k = key(src, tgt);

  const existing = pool.get(k);
  if (existing) {
    touch(k);
    return existing.promise;
  }

  const availability = await checkAvailability(src, tgt);
  if (availability === 'unavailable') {
    throw new TranslatorUnavailableError(availability, src, tgt);
  }

  // 模型還沒下載好時，create() 會觸發下載，而下載需要 user activation。
  // 已經是 'available' 的話不需要互動，自動翻譯才有可能成立。
  if (availability !== 'available' && !hasActivation()) {
    throw new NeedsUserActivationError();
  }

  const promise = self.Translator.create({
    sourceLanguage: src,
    targetLanguage: tgt,
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        opts.onDownloadProgress?.(e.loaded);
      });
    },
  }).then((instance) => {
    const entry = pool.get(k);
    if (entry) entry.instance = instance;
    availabilityCache.set(k, 'available');
    return instance;
  }).catch((err) => {
    pool.delete(k);
    throw err;
  });

  pool.set(k, { promise, instance: null, timer: null });
  touch(k);
  return promise;
}

function hasActivation() {
  try {
    return navigator.userActivation ? navigator.userActivation.isActive : true;
  } catch {
    return true;
  }
}

function touch(k) {
  const entry = pool.get(k);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => release(k), IDLE_TIMEOUT_MS);
}

function release(k) {
  const entry = pool.get(k);
  if (!entry) return;
  pool.delete(k);
  clearTimeout(entry.timer);
  entry.instance?.destroy?.();
}

/** 翻譯一段文字。長文自動走 streaming，避免使用者盯著空白等太久。 */
export async function translateText(text, sourceLanguage, targetLanguage, opts = {}) {
  const { signal, onChunk, streamThreshold = 400 } = opts;
  const translator = await getTranslator(sourceLanguage, targetLanguage, opts);
  touch(key(canonical(sourceLanguage), canonical(targetLanguage)));

  if (onChunk && text.length >= streamThreshold && typeof translator.translateStreaming === 'function') {
    let acc = '';
    const stream = translator.translateStreaming(text, { signal });
    for await (const chunk of stream) {
      acc += chunk;
      onChunk(acc);
    }
    return acc;
  }
  return translator.translate(text, { signal });
}

export function destroyAll() {
  for (const k of [...pool.keys()]) release(k);
  availabilityCache.clear();
}
