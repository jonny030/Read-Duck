import { MSG } from '../lib/messaging.js';
import { probe } from '../ai/capability.js';
import { translateText } from '../ai/translator-pool.js';

/**
 * offscreen document：一個沒有畫面、但**有 document** 的執行環境。
 *
 * 存在的理由只有一個 —— 內建 AI API 需要 responsible document 才能檢查
 * Permissions Policy，service worker 沒有。當網站用
 * `Permissions-Policy: translator=()` 把 content script 擋掉時，
 * 翻譯就改由這裡執行。
 */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case MSG.OFFSCREEN_PROBE:
      probe(msg.payload).then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;

    case MSG.OFFSCREEN_TRANSLATE: {
      const { text, sourceLanguage, targetLanguage } = msg.payload ?? {};
      translateText(text, sourceLanguage, targetLanguage).then(
        (translated) => sendResponse({ ok: true, translated }),
        (err) => sendResponse({ ok: false, error: `${err?.name}: ${err?.message}` })
      );
      return true;
    }

    default:
      return false;
  }
});
