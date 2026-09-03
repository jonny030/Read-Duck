import { MSG } from './messaging.js';

export const TRANSLATION_STYLES = ['underline', 'background', 'blur', 'plain'];

export const DEFAULTS = Object.freeze({
  targetLanguage: 'zh-Hant',
  /** 輸入框翻譯的目標語言。閱讀是翻成中文，但寫東西通常是要翻成外文 */
  inputTargetLanguage: 'en',
  translationStyle: 'underline',
  /** 這些網域一開頁就自動翻譯 */
  autoTranslateDomains: [],
  /** 這些網域完全不作用 */
  neverTranslateDomains: [],
  showFloatingButton: true,
  showSelectionToolbar: true,
  /** 同時 in-flight 的翻譯請求數。內建 API 本身會排隊，開太大沒有意義 */
  concurrency: 3,
  /** 短於這個長度的段落不翻 */
  minTextLength: 4,
  cacheEnabled: true,
  /** 'system' 跟隨作業系統，或明確指定 'light' / 'dark'。見 lib/theme.js */
  theme: 'system',
  /** 譯文字級相對原文的比例 */
  translationFontScale: 1,
  /**
   * 使用者自訂的 system prompt，key 對應 src/ai/prompts.js 的 PROMPTS。
   * 沒有的 key 就用內建的那份。內容由 sanitizeCustomPrompts() 把關。
   */
  customPrompts: {},
});

export async function getSettings() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  // storage.sync 可能存有舊版遺留的 key，用 DEFAULTS 過濾一次
  const out = {};
  for (const k of Object.keys(DEFAULTS)) {
    const v = stored[k] ?? DEFAULTS[k];
    // DEFAULTS 裡的陣列與物件是共用的實例，直接交出去的話呼叫端一改就污染了
    // 預設值。複製一份再給。
    out[k] = Array.isArray(v) ? [...v] : (v && typeof v === 'object' ? { ...v } : v);
  }
  return out;
}

export async function setSettings(patch) {
  await chrome.storage.sync.set(patch);
}

export async function resetSettings() {
  await chrome.storage.sync.clear();
  await chrome.storage.sync.set(DEFAULTS);
}

/** 註冊設定變更監聽，回傳取消函式。 */
export function onSettingsChanged(cb) {
  const handler = (changes, area) => {
    if (area !== 'sync') return;
    const patch = {};
    for (const [k, v] of Object.entries(changes)) {
      if (k in DEFAULTS) patch[k] = v.newValue;
    }
    if (Object.keys(patch).length) cb(patch);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}

/** 從 URL 取出可比對的 hostname；非 http(s) 回 null。 */
export function hostnameOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname;
  } catch {
    return null;
  }
}

/** 網域清單比對，支援子網域（news.example.com 命中 example.com）。 */
export function domainListMatches(list, hostname) {
  if (!hostname) return false;
  return list.some((d) => hostname === d || hostname.endsWith('.' + d));
}
