/**
 * 瀏覽器內建 AI 的能力探測與人話化的引導訊息。
 *
 * Chrome 與 Microsoft Edge 的 API 形狀一樣，這裡的探測邏輯兩邊共用；
 * 版本門檻、內部頁面網址、硬體需求這些差異都來自 lib/browser.js。
 *
 * 重要背景（決定了整個擴充功能的架構）：
 * Translator / LanguageModel / LanguageDetector 需要一個 responsible document
 * 才能檢查 Permissions Policy，因此**在 Worker 情境不可用** —— 包含 MV3 的
 * background service worker。所有 AI 呼叫必須發生在 content script、side panel、
 * popup、options 或 offscreen document 這類「有 document」的地方。
 */

import { currentBrowser, currentVersion } from '../lib/browser.js';

export const API_NAMES = ['LanguageModel', 'Translator', 'LanguageDetector', 'Summarizer'];

/** 規格用過兩套 availability 字串，統一成新的一套。 */
export function normalizeAvailability(v) {
  switch (v) {
    case 'readily':        return 'available';
    case 'after-download': return 'downloadable';
    case 'no':             return 'unavailable';
    default:               return v ?? 'unavailable';
  }
}

export function apiPresent(name) {
  return typeof self !== 'undefined' && name in self;
}

/** 這個執行情境有沒有 document？沒有的話 AI API 一定不能用。 */
export function hasDocumentContext() {
  return typeof document !== 'undefined' && document != null;
}

/**
 * 完整探測。給 diagnostics 頁與錯誤 UI 用。
 * @returns {Promise<object>}
 */
export async function probe({
  sourceLanguage = 'en',
  targetLanguage = 'zh-Hant',
  /** LanguageModel.availability() 也是一次 request，同樣必須帶輸出語言 */
  outputLanguage = 'en',
} = {}) {
  const report = {
    context: guessContext(),
    browser: currentBrowser().id,
    browserVersion: currentVersion(),
    hasDocument: hasDocumentContext(),
    // 只放進原始資料供回報問題時參考，不上診斷頁的表格 —— 它的值完全由
    // 「探測是怎麼被觸發的」決定，不會隨裝置或模型狀態變化，放上去只是雜訊。
    // 真正需要手勢的地方（模型尚未下載時的 Translator.create()）由
    // translator-pool.js 的 NeedsUserActivationError 自己處理。
    userActivation: typeof navigator !== 'undefined' && navigator.userActivation
      ? { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }
      : null,
    present: {},
    availability: {},
    params: null,
    errors: {},
  };

  for (const name of API_NAMES) report.present[name] = apiPresent(name);

  if (report.present.Translator) {
    try {
      report.availability.Translator = normalizeAvailability(
        await self.Translator.availability({ sourceLanguage, targetLanguage })
      );
    } catch (e) { report.errors.Translator = describeError(e); }
  }
  if (report.present.LanguageDetector) {
    try {
      report.availability.LanguageDetector = normalizeAvailability(
        await self.LanguageDetector.availability()
      );
    } catch (e) { report.errors.LanguageDetector = describeError(e); }
  }
  if (report.present.LanguageModel) {
    try {
      report.availability.LanguageModel = normalizeAvailability(
        await self.LanguageModel.availability({
          expectedOutputs: [{ type: 'text', languages: [outputLanguage] }],
        })
      );
    } catch (e) { report.errors.LanguageModel = describeError(e); }
    try {
      // params() 是擴充功能 / Origin Trial 才拿得到的能力
      report.params = await self.LanguageModel.params();
    } catch (e) { report.errors.LanguageModelParams = describeError(e); }
  }
  return report;
}

function guessContext() {
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
    return 'service-worker';
  }
  if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) return 'worker';
  if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
    const here = location.href;
    if (here.startsWith(chrome.runtime.getURL(''))) return 'extension-page';
    return 'content-script';
  }
  return 'page';
}

export function describeError(err) {
  if (!err) return 'unknown';
  return `${err.name || 'Error'}: ${err.message || String(err)}`;
}

/**
 * 把技術性的失敗轉成使用者看得懂的說明 + 可行動的建議。
 * UI 直接顯示這個結果，不要自己拼字串。
 */
export function explainUnavailable(availability, apiName = 'AI') {
  const browser = currentBrowser();
  switch (availability) {
    case 'available':
      return null;
    case 'downloading':
      return {
        title: '模型下載中',
        body: `${apiName} 的裝置端模型正在下載，完成後就能使用。`,
        actions: [],
      };
    case 'downloadable':
      return {
        title: '需要先下載模型',
        body: `第一次使用 ${apiName} 需要下載裝置端模型（數 GB），只需下載一次。`,
        actions: [{ label: '開始下載', kind: 'download' }],
      };
    case 'unavailable':
    default:
      return {
        title: `這台裝置無法使用${browser.name}的內建 AI`,
        body: [
          `ReadDuck 需要${browser.name}內建的裝置端模型，請確認：`,
          ...browser.requirements.map((r) => `• ${r}`),
          ...(browser.promptNote ? ['', browser.promptNote] : []),
        ].join('\n'),
        actions: [{ label: '檢視模型狀態', kind: 'open', url: browser.internalsUrl }],
      };
  }
}

/**
 * 目前的頁面有沒有被 Permissions Policy 擋掉。
 * 網站若送出 `Permissions-Policy: translator=()` 就會擋住 content script 的呼叫，
 * 此時要降級走 offscreen document。
 */
export function permissionsPolicyAllows(feature) {
  try {
    if (typeof document === 'undefined' || !document.featurePolicy?.allowsFeature) return true;
    return document.featurePolicy.allowsFeature(feature);
  } catch {
    return true; // 查不到就當作允許，真的失敗時 create() 會拋錯，那邊有 fallback
  }
}
