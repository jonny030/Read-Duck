import * as ui from './ui.js';
import { translateText, NeedsUserActivationError, TranslatorUnavailableError } from '../ai/translator-pool.js';
import { detectLanguage, MIN_DETECT_LENGTH } from '../ai/detector.js';
import {
  createSession, forkSession, planOutputLanguage, isLanguageModelPresent,
  checkAvailability as checkLmAvailability,
  needsDownloadConsent, DOWNLOAD_NOTICE,
} from '../ai/language-model.js';
import { promptLocalized } from '../ai/localize.js';
import { explainSystemPrompt, simplifySystemPrompt } from '../ai/prompts.js';
import { explainUnavailable, explainModelError } from '../ai/capability.js';
import { currentBrowser } from '../lib/browser.js';
import { sameLanguage, languageName } from '../ai/languages.js';
import { mightAlreadyBe } from './script-detect.js';
import { MSG, send } from '../lib/messaging.js';

/**
 * 劃選即譯 / 劃選解釋。
 *
 * 每個動作都用 clone() 出來的分支 session 跑，一次性的提問不會污染
 * 長期 session 的上下文，也不會互相排隊。
 *
 * 「解釋」與「簡化」的輸出語言由 planOutputLanguage() 決定 —— 目標語言是
 * 中文時模型輸出英文，再由 promptLocalized() 逐句轉成中文。
 */

const MIN_SELECTION = 2;
const MAX_SELECTION = 4000;

/** action -> 基底 session（含 system prompt）。實際提問用它的 clone。 */
const baseSessions = new Map();

let settings = null;
let active = null;   // 目前進行中的動作 { controller }
let attached = false;
let lastText = '';

export function init(cfg) {
  settings = cfg;
  if (attached) return;
  attached = true;
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('scroll', onScroll, { passive: true, capture: true });
}

export function updateSettings(patch) {
  const langChanged = patch.targetLanguage && patch.targetLanguage !== settings?.targetLanguage;
  settings = { ...settings, ...patch };
  // system prompt 裡寫死了輸出語言，語言換了就得重建 session
  if (langChanged) destroySessions();
}

function destroySessions() {
  for (const p of baseSessions.values()) {
    Promise.resolve(p).then((s) => s.destroy?.()).catch(() => {});
  }
  baseSessions.clear();
}

export function destroy() {
  if (!attached) return;
  attached = false;
  document.removeEventListener('mouseup', onMouseUp, true);
  document.removeEventListener('keyup', onKeyUp, true);
  document.removeEventListener('mousedown', onMouseDown, true);
  document.removeEventListener('scroll', onScroll, { capture: true });
  cancelActive();
  ui.hideToolbar();
  ui.closePanel();
  destroySessions();
}

/* ------------------------------------------------------------- 事件 */

function onMouseDown(e) {
  // 點在我們自己的 UI 上不要收掉工具列
  if (e.composedPath().some((n) => n instanceof Element && n.hasAttribute?.('data-readduck'))) return;
  ui.hideToolbar();
  if (ui.isPanelOpen()) ui.closePanel();
}

function onMouseUp(e) {
  if (e.composedPath().some((n) => n instanceof Element && n.hasAttribute?.('data-readduck'))) return;
  // 等瀏覽器把選取範圍確定下來
  setTimeout(maybeShowToolbar, 0);
}

function onKeyUp(e) {
  if (e.key === 'Escape') { ui.hideToolbar(); cancelActive(); return; }
  if (e.shiftKey || e.key.startsWith('Arrow')) setTimeout(maybeShowToolbar, 0);
}

function onScroll() {
  // 工具列是 absolute 定位、跟著頁面座標走，捲動不需要重算；
  // 但選取範圍被捲離畫面時收掉比較不礙眼
  if (!ui.isPanelOpen()) ui.hideToolbar();
}

function maybeShowToolbar() {
  if (!settings?.showSelectionToolbar) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return ui.hideToolbar();

  const text = sel.toString().trim();
  if (text.length < MIN_SELECTION) return ui.hideToolbar();

  // 在輸入框裡選字是要編輯，不是要翻譯
  const anchor = sel.anchorNode;
  const el = anchor?.nodeType === Node.ELEMENT_NODE ? anchor : anchor?.parentElement;
  if (el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]')) return ui.hideToolbar();

  lastText = text.slice(0, MAX_SELECTION);
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) return ui.hideToolbar();

  const buttons = [
    { label: '譯', onClick: () => run('translate', rect) },
    { label: '解釋', onClick: () => run('explain', rect) },
    { label: '簡化', onClick: () => run('simplify', rect) },
    { label: '摘要側欄', onClick: openSidePanel },
  ];
  ui.showToolbar(rect, buttons);
}

async function openSidePanel() {
  ui.hideToolbar();
  const res = await send(MSG.OPEN_SIDE_PANEL);
  if (!res?.ok) ui.showToast(`無法開啟側邊欄：${res?.error ?? '沒有回應'}`, { timeout: 5000 });
}

/**
 * 由右鍵選單觸發：對目前選取的文字執行動作。
 * 走的是和工具列一樣的路徑，只是不需要先顯示工具列。
 */
export function runOnSelection(action) {
  const sel = window.getSelection();
  const text = sel?.toString().trim() ?? '';
  if (text.length < MIN_SELECTION) {
    ui.showToast('請先選取一段文字。', { timeout: 2500 });
    return;
  }
  lastText = text.slice(0, MAX_SELECTION);
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  run(action, rect);
}

/* ------------------------------------------------------------- 動作 */

const TITLES = {
  translate: '翻譯',
  explain: '解釋',
  simplify: '簡化',
};

function cancelActive() {
  active?.controller.abort();
  active = null;
}

async function run(action, rect) {
  ui.hideToolbar();
  cancelActive();

  const text = lastText;
  const controller = new AbortController();
  active = { controller };

  const panel = ui.showPanel(rect, `ReadDuck · ${TITLES[action]}`, {
    onClose: () => cancelActive(),
    actions: [{
      label: '複製',
      onClick: (p) => {
        navigator.clipboard?.writeText(p.getText()).then(
          () => ui.showToast('已複製', { timeout: 1500 }),
          () => ui.showToast('複製失敗', { timeout: 2000 })
        );
      },
    }],
  });
  panel.setStatus('處理中…');

  try {
    if (action === 'translate') {
      await runTranslate(text, panel, controller.signal);
    } else {
      await runPrompt(action, text, panel, controller.signal);
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    panel.setError(describeFailure(err));
  } finally {
    if (active?.controller === controller) active = null;
  }
}

async function runTranslate(text, panel, signal) {
  let source = 'en';
  if (text.length >= MIN_DETECT_LENGTH) {
    const r = await detectLanguage(text);
    if (r) source = r.language;
  } else if (!mightAlreadyBe(text, settings.targetLanguage)) {
    source = 'en';
  }

  const target = settings.targetLanguage;
  if (sameLanguage(source, target)) {
    panel.setStatus(`這段已經是${languageName(source)}了。`);
    return;
  }

  panel.setStatus(`${languageName(source)} → ${languageName(target)} 翻譯中…`);
  const out = await translateText(text, source, target, {
    signal,
    streamThreshold: 120,
    onChunk: (partial) => panel.setText(partial, true),
  });
  panel.setText(out, false);
}

async function runPrompt(action, text, panel, signal) {
  if (!isLanguageModelPresent()) {
    const b = currentBrowser();
    panel.setError(
      `這個瀏覽器沒有 Prompt API（需要 ${b.name} ${b.promptMinVersion} 以上`
      + (b.promptNeedsFlag ? `，並在 ${b.flagsUrl} 啟用「${b.promptFlag}」` : '')
      + '）。'
    );
    return;
  }
  const plan = planOutputLanguage(settings.targetLanguage);
  const availability = await checkLmAvailability(plan.modelLanguage);
  if (availability !== 'available' && availability !== 'downloadable' && availability !== 'downloading') {
    const info = explainUnavailable(availability, 'Prompt API');
    panel.setError(`${info.title}\n\n${info.body}`);
    return;
  }

  // 數 GB 的下載不能因為使用者按了「解釋」就自己開始
  if (availability === 'downloadable') {
    const agreed = await panel.setConfirm({
      title: DOWNLOAD_NOTICE.title,
      message: DOWNLOAD_NOTICE.body,
      confirmLabel: DOWNLOAD_NOTICE.confirm,
      cancelLabel: DOWNLOAD_NOTICE.cancel,
      signal,
    });
    if (!agreed) { panel.close(); return; }
  }
  panel.setStatus('處理中…');

  const session = await getBranch(action, plan, panel, signal);
  const out = await promptLocalized(session, text, {
    plan,
    signal,
    onChunk: (partial) => panel.setText(partial, true),
  });
  panel.setText(out, false);
  session.destroy?.();
}

/** 取得基底 session 的分支。基底只建立一次，之後每次操作 clone。 */
async function getBranch(action, plan, panel, signal) {
  const config = {
    systemPrompt: action === 'explain'
      ? explainSystemPrompt(plan.modelLanguage)
      : simplifySystemPrompt(plan.modelLanguage),
    mode: action === 'explain' ? 'balanced' : 'precise',
    outputLanguage: plan.modelLanguage,
  };

  if (!baseSessions.has(action)) {
    baseSessions.set(action, createSession({
      ...config,
      onDownloadProgress: (loaded) => {
        panel.setStatus(`正在下載裝置端語言模型（只需下載一次）… ${Math.round(loaded * 100)}%`);
      },
    }).catch((err) => {
      baseSessions.delete(action);
      throw err;
    }));
  }
  const base = await baseSessions.get(action);
  // 不支援 cloning 的瀏覽器（Edge）會退回用同一份設定重建
  return forkSession(base, config, { signal });
}

function describeFailure(err) {
  if (err instanceof NeedsUserActivationError) {
    return '第一次使用需要下載模型，請再點一次按鈕以開始下載。';
  }
  if (err instanceof TranslatorUnavailableError) {
    return `${languageName(err.sourceLanguage)} → ${languageName(err.targetLanguage)} 這個語言組合目前無法翻譯。`;
  }
  if (err?.name === 'QuotaExceededError') {
    return `選取的內容太長了（需要 ${err.requested} tokens，上限 ${err.contextWindow}）。請選少一點再試。`;
  }
  if (err?.name === 'NotSupportedError') {
    return '模型不支援這個語言或輸入類型。';
  }
  // 模型服務直接透出來的錯誤碼（崩潰、kErrorUnknown）要另外解釋，
  // 原樣顯示對使用者沒有任何幫助
  return `發生錯誤：${explainModelError(err)}`;
}
