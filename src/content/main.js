import { PageTranslator } from './page-translator.js';
import * as selection from './selection.js';
import * as inputTranslate from './input-translate.js';
import * as ui from './ui.js';
import { extractArticle } from './collector.js';
import { getSettings, onSettingsChanged, hostnameOf, domainListMatches } from '../lib/settings.js';
import { throttle, isPdfDocument } from '../lib/dom-utils.js';
import { MSG, send } from '../lib/messaging.js';
import { destroyAll as destroyTranslators } from '../ai/translator-pool.js';
import { probe } from '../ai/capability.js';
import { reset as resetDetector } from '../ai/detector.js';

/**
 * content script 的總機。
 *
 * 所有 AI 呼叫都發生在這一層（以及 side panel），不會發生在 service worker ——
 * 內建 AI API 需要 responsible document 才能檢查 Permissions Policy，
 * 在 Worker 情境根本不存在。
 */

let settings = null;
let translator = null;
let ready = false;

async function boot() {
  settings = await getSettings();

  const host = hostnameOf(location.href);
  if (domainListMatches(settings.neverTranslateDomains, host)) {
    // 不啟動任何功能，但仍要回應狀態查詢 —— 否則 popup 會誤以為
    // 這個分頁沒載入 ReadDuck，叫使用者去重新整理。
    chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
      if (msg?.type === MSG.QUERY_STATE) {
        sendResponse({ ready: true, disabledByDomain: true, enabled: false, hostname: host });
      }
      return false;
    });
    return;
  }

  // Chrome 內建的 PDF 檢視器裡沒有可翻譯的 HTML 文字，段落收集、劃選、
  // 輸入框翻譯全都用不上。只掛一顆把它導到 ReadDuck 檢視器的鴨子。
  if (isPdfDocument()) {
    mountPdfFab();
    ready = true;
    chrome.runtime.onMessage.addListener(onPdfMessage);
    return;
  }

  translator = new PageTranslator({ settings, onState: onTranslatorState });
  selection.init(settings);
  inputTranslate.init(settings);

  if (settings.showFloatingButton) mountFab();

  onSettingsChanged(applySettings);
  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener('pagehide', cleanup);

  ready = true;

  if (domainListMatches(settings.autoTranslateDomains, host)) {
    // 自動翻譯只有在模型已經下載好時才可能成功 —— 尚未下載時
    // Translator.create() 需要 user activation，這裡會安靜地失敗並提示使用者點一下。
    translator.enable().catch((e) => console.warn('[ReadDuck] 自動翻譯失敗', e));
  }
}

function mountFab() {
  ui.showFab({
    onClick: toggle,
    onContextMenu: () => openSidePanel(),
    onSummary: openSidePanel,
    onOptions: () => send(MSG.OPEN_OPTIONS),
  });
  ui.setFabState(false, '');
}

/**
 * 請 service worker 開啟側邊欄。
 * 失敗時一定要讓使用者看到 —— 側邊欄開不起來最常見的原因是使用者手勢
 * 已經過期，那種情況安靜地什麼都不發生最難查。
 */
async function openSidePanel() {
  const res = await send(MSG.OPEN_SIDE_PANEL);
  if (!res?.ok) {
    ui.showToast(`無法開啟側邊欄：${res?.error ?? '沒有回應'}`, { timeout: 5000 });
  }
}

/** Chrome 內建 PDF 檢視器上的鴨子：點下去用 ReadDuck 的檢視器重新開啟。 */
function mountPdfFab() {
  if (!settings.showFloatingButton) return;
  ui.showFab({
    title: 'ReadDuck：用可翻譯的檢視器開啟這個 PDF',
    onClick: () => send(MSG.OPEN_PDF, { url: location.href }),
    onOptions: () => send(MSG.OPEN_OPTIONS),
  });
}

/** PDF 頁面上只需要回答狀態查詢，讓 popup 知道這裡是什麼情況。 */
function onPdfMessage(msg, _sender, sendResponse) {
  if (msg?.type !== MSG.QUERY_STATE) return false;
  sendResponse({ ready: true, isPdf: true, enabled: false, hostname: hostnameOf(location.href) });
  return false;
}

function applySettings(patch) {
  settings = { ...settings, ...patch };
  translator?.updateSettings(patch);
  selection.updateSettings(patch);
  inputTranslate.updateSettings(patch);

  if ('showFloatingButton' in patch) {
    if (patch.showFloatingButton) mountFab();
    else ui.hideFab();
  }
  if ('targetLanguage' in patch && translator?.enabled) {
    // 目標語言換了，整頁重翻
    translator.disable();
    translator.enable();
  }
}

/** 回報給 service worker，讓工具列圖示的徽章跟著更新。節流避免訊息洗版。 */
const reportState = throttle(() => send(MSG.PAGE_STATE, pageState()), 500);

function onTranslatorState(stats) {
  const pending = stats.pending;
  ui.setFabState(translator.enabled, pending > 0 ? String(Math.min(pending, 99)) : '');
  reportState();
}

function pageState() {
  return {
    ready,
    enabled: !!translator?.enabled,
    sourceLanguage: translator?.sourceLanguage ?? null,
    targetLanguage: settings?.targetLanguage ?? null,
    hostname: hostnameOf(location.href),
    stats: translator?.stats ?? null,
  };
}

async function toggle() {
  if (!translator) return pageState();
  if (translator.enabled) translator.disable();
  else await translator.enable();
  ui.setFabState(translator.enabled, '');
  reportState();
  return pageState();
}

function onMessage(msg, _sender, sendResponse) {
  switch (msg?.type) {
    case MSG.TOGGLE:
      toggle().then(sendResponse);
      return true;

    case MSG.SET_ENABLED:
      (async () => {
        if (msg.payload?.enabled && !translator.enabled) await translator.enable();
        else if (!msg.payload?.enabled && translator.enabled) translator.disable();
        ui.setFabState(translator.enabled, '');
        sendResponse(pageState());
      })();
      return true;

    case MSG.QUERY_STATE:
      sendResponse(pageState());
      return false;

    case MSG.TRANSLATE_INPUT:
      inputTranslate.translateFocusedInput();
      sendResponse({ ok: true });
      return false;

    case MSG.EXPLAIN_SELECTION:
      selection.runOnSelection(msg.payload?.action || 'explain');
      sendResponse({ ok: true });
      return false;

    case MSG.PROBE:
      probe(msg.payload?.options).then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;

    case MSG.EXTRACT_ARTICLE:
      sendResponse(extractArticle());
      return false;

    default:
      return false;
  }
}

function cleanup() {
  translator?.destroy();
  selection.destroy();
  inputTranslate.destroy();
  destroyTranslators();
  resetDetector();
  ui.teardownUi();
}

boot().catch((err) => console.error('[ReadDuck] 啟動失敗', err));
