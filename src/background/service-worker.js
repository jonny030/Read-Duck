import { MSG, sendToTab } from '../lib/messaging.js';
import { getSettings, DEFAULTS } from '../lib/settings.js';
import * as cache from '../lib/cache.js';
import { probe } from '../ai/capability.js';

/**
 * background service worker。
 *
 * 這裡刻意**不呼叫任何 AI API** —— 內建的 Translator / LanguageModel /
 * LanguageDetector 需要 responsible document 才能檢查 Permissions Policy，
 * 在 Worker 情境不可用。這支檔案只負責：
 *   訊息路由、譯文快取（IndexedDB 在這裡才是擴充功能自己的儲存空間）、
 *   右鍵選單、快捷鍵、工具列徽章。
 */

const MENU = {
  TOGGLE: 'readduck-toggle',
  EXPLAIN: 'readduck-explain',
  SIMPLIFY: 'readduck-simplify',
  TRANSLATE_SEL: 'readduck-translate-selection',
  SIDE_PANEL: 'readduck-side-panel',
  INPUT: 'readduck-input',
  IMAGE: 'readduck-image',
  PDF_LINK: 'readduck-pdf-link',
  PDF_PAGE: 'readduck-pdf-page',
};

/** 網址看起來是不是 PDF。用來決定要不要顯示 PDF 相關的入口。 */
const PDF_URL_PATTERNS = ['*://*/*.pdf', '*://*/*.pdf?*', '*://*/*.PDF'];

chrome.runtime.onInstalled.addListener(async () => {
  // 只補上缺少的預設值，不覆蓋使用者既有設定
  const current = await chrome.storage.sync.get(null);
  const missing = {};
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (!(k in current)) missing[k] = v;
  }
  if (Object.keys(missing).length) await chrome.storage.sync.set(missing);

  createMenus();
});

chrome.runtime.onStartup?.addListener(createMenus);

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU.TOGGLE, title: '切換雙語對照翻譯', contexts: ['page', 'action'],
    });
    chrome.contextMenus.create({
      id: MENU.TRANSLATE_SEL, title: '翻譯選取的文字', contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU.EXPLAIN, title: '解釋選取的文字', contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU.SIMPLIFY, title: '簡化選取的文字', contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU.SIDE_PANEL, title: '開啟摘要側邊欄', contexts: ['page', 'action', 'selection'],
    });
    // 輸入框翻譯只有這一個入口，移除快捷鍵之後更不能少
    chrome.contextMenus.create({
      id: MENU.INPUT, title: '翻譯這個輸入框的內容', contexts: ['editable'],
    });
    chrome.contextMenus.create({
      id: MENU.IMAGE, title: '翻譯圖片中的文字', contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU.PDF_LINK,
      title: '用 ReadDuck 翻譯這個 PDF',
      contexts: ['link'],
      targetUrlPatterns: PDF_URL_PATTERNS,
    });
    chrome.contextMenus.create({
      id: MENU.PDF_PAGE,
      title: '用 ReadDuck 翻譯這個 PDF',
      contexts: ['page', 'action'],
      documentUrlPatterns: PDF_URL_PATTERNS,
    });
    void chrome.runtime.lastError;
  });
}

/**
 * 送訊息給分頁；沒有人接就告訴使用者要重新整理。
 *
 * 重新載入擴充功能之後，已經開著的分頁還跑著舊的 content script，它跟新的
 * service worker 已經斷了連線。sendToTab() 會把 lastError 吞掉並回 null，
 * 於是右鍵選單按下去**完全沒有反應** —— 連錯誤都看不到，使用者只會覺得壞了。
 *
 * 不能重新注入了事：boot.js 有 window.__readduckBooted 這道防重複注入的守衛，
 * 而那個旗標還留在同一個 isolated world 裡，注入進去也會直接 return。
 * 所以改成注入一支自足的函式，在頁面上講清楚要重新整理。
 */
async function sendToTabOrExplain(tabId, type, payload) {
  const res = await sendToTab(tabId, type, payload);
  if (res != null) return res;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: showReloadHint });
  } catch {
    // chrome:// 這類頁面本來就注入不了，也本來就不支援
  }
  return null;
}

/** 注入到頁面裡執行，所以不能參照這支檔案裡的任何東西。 */
function showReloadHint() {
  const id = 'readduck-reload-hint';
  if (document.getElementById(id)) return;
  const el = document.createElement('div');
  el.id = id;
  el.textContent = 'ReadDuck 更新過了，請重新整理這個分頁後再試一次。';
  el.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'top:16px', 'left:50%',
    'transform:translateX(-50%)', 'padding:10px 16px', 'border-radius:10px',
    'background:#111827', 'color:#f8fafc', 'font:600 13px/1.5 system-ui,sans-serif',
    'box-shadow:0 8px 28px rgba(0,0,0,.35)', 'pointer-events:none',
  ].join(';');
  document.documentElement.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  switch (info.menuItemId) {
    case MENU.TOGGLE:
      await sendToTabOrExplain(tab.id, MSG.TOGGLE);
      break;
    case MENU.TRANSLATE_SEL:
      await sendToTabOrExplain(tab.id, MSG.EXPLAIN_SELECTION, { action: 'translate' });
      break;
    case MENU.EXPLAIN:
      await sendToTabOrExplain(tab.id, MSG.EXPLAIN_SELECTION, { action: 'explain' });
      break;
    case MENU.SIMPLIFY:
      await sendToTabOrExplain(tab.id, MSG.EXPLAIN_SELECTION, { action: 'simplify' });
      break;
    case MENU.SIDE_PANEL:
      await openSidePanel(tab);
      break;
    case MENU.INPUT:
      await sendToTabOrExplain(tab.id, MSG.TRANSLATE_INPUT);
      break;
    case MENU.IMAGE:
      // srcUrl 是選單唯一給得到的線索；content script 那邊還會用按右鍵當下
      // 記住的元素來決定面板開在哪裡
      await sendToTabOrExplain(tab.id, MSG.TRANSLATE_IMAGE, { srcUrl: info.srcUrl });
      break;
    case MENU.PDF_LINK:
      openPdfViewer(info.linkUrl);
      break;
    case MENU.PDF_PAGE:
      openPdfViewer(info.pageUrl ?? tab.url);
      break;
  }
});

/**
 * 代 content script 抓圖片。
 *
 * 為什麼不讓 content script 自己抓：MV3 的 content script `fetch` 是「代表所在
 * 網頁的來源」發出的，一樣受網頁的 CORS 限制 —— 擴充功能的 host permissions
 * 幫不上忙。圖床做防盜連或單純沒給 CORS 標頭的網站（漫畫站幾乎都是）就會被擋。
 * service worker 才是有 host permissions、不受 CORS 限制的那一邊。
 *
 * 回傳 data: URL 而不是 Blob —— chrome.runtime 的訊息會做 JSON 序列化，
 * Blob 和 ArrayBuffer 都活不過來。
 */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

async function fetchImage(url) {
  if (!url) return { error: '沒有圖片網址' };
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return { error: `HTTP ${res.status}` };

    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return { error: '這個網址回傳的不是圖片' };

    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_IMAGE_BYTES) return { error: '圖片太大' };
    return { dataUrl: `data:${type.split(';')[0]};base64,${toBase64(buf)}` };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/** 分段轉 base64：一次 apply 整個陣列會爆呼叫堆疊。 */
function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 擷取可見畫面。
 *
 * 圖片抓不到時的後路。防盜連（圖床檢查 Referer）、需要登入的圖、以及任何
 * 我們重新請求就會被拒絕的情況，用這條路都能過 —— 因為擷取的是瀏覽器
 * **已經畫出來的像素**，不必再向伺服器要一次。
 *
 * 代價是解析度只有「顯示尺寸 × devicePixelRatio」，而且只有可見範圍。
 */
async function captureTab(tab) {
  if (!tab?.windowId) return { error: '找不到分頁' };
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { dataUrl };
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

/* ------------------------------------------------------------ 訊息路由 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  switch (msg?.type) {
    case MSG.FETCH_IMAGE:
      fetchImage(msg.payload?.url).then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;

    case MSG.CAPTURE_TAB:
      captureTab(sender.tab).then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;

    case MSG.CACHE_GET:
      cache.getMany(msg.payload?.keys ?? []).then(sendResponse, () => sendResponse({}));
      return true;

    case MSG.CACHE_PUT:
      cache.putMany(msg.payload?.entries ?? []).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e) })
      );
      return true;

    case MSG.CACHE_STATS:
      cache.stats().then(sendResponse);
      return true;

    case MSG.CACHE_CLEAR:
      cache.clear().then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
      return true;

    case MSG.GET_SETTINGS:
      getSettings().then(sendResponse);
      return true;

    case MSG.PAGE_STATE:
      if (tabId != null) updateBadge(tabId, msg.payload);
      sendResponse({ ok: true });
      return false;

    case MSG.TRANSLATE_VIA_OFFSCREEN:
      translateViaOffscreen(msg.payload).then(
        sendResponse,
        (e) => sendResponse({ ok: false, error: String(e) })
      );
      return true;

    case MSG.OPEN_OPTIONS:
      // content script 沒有 chrome.runtime.openOptionsPage()，要繞到這裡
      chrome.runtime.openOptionsPage();
      sendResponse({ ok: true });
      return false;

    case MSG.OPEN_PDF:
      openPdfViewer(msg.payload?.url);
      sendResponse({ ok: true });
      return false;

    case MSG.PROBE:
      runProbe(msg.payload).then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;

    case MSG.OPEN_SIDE_PANEL:
      // 這一行之前不能有任何 await。sidePanel.open() 只在使用者手勢仍然
      // 有效時才被允許，中間插入 await 會讓 activation 過期。
      openSidePanel(sender.tab).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: e?.message || String(e) })
      );
      return true;

    default:
      return false;
  }
});

/* ---------------------------------------------------------------- 徽章 */

async function updateBadge(tabId, state) {
  try {
    const pending = state?.stats?.pending ?? 0;
    const text = !state?.enabled ? '' : pending > 0 ? String(Math.min(pending, 99)) : '✓';
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: pending > 0 ? '#fbbf24' : '#16a34a' });
  } catch {
    // 分頁可能已經關掉了
  }
}

// 換頁時把徽章清掉，免得顯示上一頁的狀態
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

/* ------------------------------------------------------------ 側邊欄 */

/**
 * 開啟側邊欄。
 *
 * 刻意不是 async function —— `chrome.sidePanel.open()` 必須是這個函式執行的
 * **第一件事**。它只在使用者手勢仍然有效時才被允許呼叫，而每一個 await 都會
 * 讓 activation 過期。setOptions 也因此挪到 open 之後（manifest 已經宣告了
 * default_path，開啟本身並不需要它）。
 */
function openSidePanel(tab) {
  if (tab?.id == null) {
    // popup 送來的訊息沒有 sender.tab。那條路徑不該走到這裡 ——
    // popup 有自己的使用者手勢，應該直接呼叫 chrome.sidePanel.open()。
    return Promise.reject(new Error('沒有來源分頁，無法決定要在哪個分頁開啟側邊欄'));
  }
  const tabId = tab.id;
  return chrome.sidePanel.open({ tabId }).then(() =>
    chrome.sidePanel.setOptions({ tabId, path: 'src/sidepanel/sidepanel.html', enabled: true })
  );
}

/* -------------------------------------------------------------- PDF */

/**
 * 用 ReadDuck 自己的檢視器開啟 PDF。
 *
 * 瀏覽器內建的 PDF 檢視器是獨立的外掛程序，content script 碰不到它裡面的
 * 文字，所以沒辦法在上面加譯文 —— 只能另開一個用 PDF.js 自己畫的檢視器。
 * 不帶 url 就開空的檢視器，讓使用者自己拖檔案進去。
 */
function openPdfViewer(url) {
  const viewer = chrome.runtime.getURL('src/pdf/pdf.html');
  chrome.tabs.create({ url: url ? `${viewer}?file=${encodeURIComponent(url)}` : viewer });
}

/* ------------------------------------------------------ 能力探測 / offscreen */

async function runProbe({ target, options } = {}) {
  if (target === 'offscreen') {
    await ensureOffscreen();
    return chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_PROBE, payload: options });
  }
  // 'service-worker'：在這裡直接跑。預期會看到 API 全部不存在 ——
  // 這正是整個架構把 AI 呼叫放在 content script / side panel 的原因。
  return probe(options);
}

let offscreenReady = null;

async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (existing?.length) return;
    await chrome.offscreen.createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: ['DOM_SCRAPING'],
      justification: '內建 AI API 需要 responsible document 才能檢查 Permissions Policy，service worker 無法直接呼叫。',
    });
  })().catch((err) => {
    offscreenReady = null;
    throw err;
  });
  return offscreenReady;
}

/**
 * 由 offscreen document 代為翻譯。
 *
 * 使用時機：網站送出 `Permissions-Policy: translator=()` 把 content script
 * 的呼叫擋掉。offscreen document 屬於擴充功能自己的來源，不受網站的
 * Permissions Policy 影響。
 */
async function translateViaOffscreen(payload) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ type: MSG.OFFSCREEN_TRANSLATE, payload });
}
