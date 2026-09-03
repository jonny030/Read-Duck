import * as ui from './ui.js';
import {
  createSession, forkSession, promptStream, promptOutputLanguages,
  needsDownloadConsent, DOWNLOAD_NOTICE,
} from '../ai/language-model.js';
import { translateText } from '../ai/translator-pool.js';
import { detectLanguage } from '../ai/detector.js';
import { inputRewriteSystemPrompt } from '../ai/prompts.js';
import { canonical, languageName, sameLanguage } from '../ai/languages.js';

/**
 * 輸入框翻譯：把已經打好的內容改寫成目標語言。
 *
 * 目標語言在 Prompt API 支援的輸出語言內時用 Prompt API —— 要送出去給人看的
 * 訊息需要的是「母語者會怎麼講」，而不是逐字直譯。
 *
 * 不在支援清單內（例如中文）時直接用 Translator API。這本來就是純翻譯任務，
 * 繞英文中轉只會多一次資訊損失。
 */

let settings = null;
let session = null;
let busy = false;

export function init(cfg) { settings = cfg; }
export function updateSettings(patch) {
  const langChanged = patch.inputTargetLanguage && patch.inputTargetLanguage !== settings?.inputTargetLanguage;
  // 同 selection.js：提示詞改了就得重建，否則舊 session 還帶著舊的 system prompt
  const promptsChanged = 'customPrompts' in patch;
  settings = { ...settings, ...patch };
  if (langChanged || promptsChanged) { session?.destroy?.(); session = null; }
}
export function destroy() { session?.destroy?.(); session = null; }

/** 由右鍵選單「翻譯這個輸入框的內容」觸發。 */
export async function translateFocusedInput() {
  if (busy) return;
  const el = getEditable();
  if (!el) {
    ui.showToast('請先把游標放進要翻譯的輸入框。', { timeout: 3000 });
    return;
  }
  const original = readValue(el);
  if (!original.trim()) {
    ui.showToast('這個輸入框是空的。', { timeout: 2500 });
    return;
  }

  const target = canonical(settings.inputTargetLanguage);
  busy = true;
  const toast = ui.showToast(`改寫成${languageName(target)}…`, { timeout: 0 });
  try {
    const out = promptOutputLanguages().includes(target)
      ? await rewriteWithModel(original, target, toast)
      : await translateDirectly(original, target, toast);

    if (out === null) { toast.close(); return; }
    writeValue(el, out);
    toast.close();
    ui.showToast(`已改寫成${languageName(target)}`, {
      timeout: 8000,
      actions: [{ label: '復原', onClick: (t) => { writeValue(el, original); t.close(); } }],
    });
  } catch (err) {
    toast.close();
    ui.showToast(`改寫失敗：${err?.message || err}`, { timeout: 5000 });
  } finally {
    busy = false;
  }
}

/** 建 session 與重建分支共用同一份設定。 */
function sessionConfig(target) {
  return {
    systemPrompt: inputRewriteSystemPrompt(target, settings.customPrompts),
    mode: 'balanced',
    outputLanguage: target,
  };
}

/** Prompt API 路線：追求道地的表達，而不是字面翻譯。 */
async function rewriteWithModel(original, target, toast) {
  if (!session) {
    // 走到這個函式時 target 一定在 promptOutputLanguages() 內
    if (await needsDownloadConsent(target)) {
      // showToast 本身就會收掉前一則，不需要先 close
      const agreed = await confirmDownload();
      if (!agreed) return null;
      toast = ui.showToast(`改寫成${languageName(target)}…`, { timeout: 0 });
    }
    session = await createSession({
      ...sessionConfig(target),
      onDownloadProgress: (l) => toast.update(`正在下載裝置端語言模型（只需下載一次）… ${Math.round(l * 100)}%`),
    });
  }
  // 用分支跑，主 session 不會累積上下文（否則下一句會被上一句影響）
  const branch = await forkSession(session, sessionConfig(target));
  try {
    const out = await promptStream(branch, original, {
      onChunk: (p) => toast.update(p.length > 120 ? p.slice(-120) : p),
    });
    return out.trim();
  } finally {
    branch.destroy?.();
  }
}

/** 用提示訊息問使用者要不要下載模型。 */
function confirmDownload() {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    ui.showToast(`${DOWNLOAD_NOTICE.title}\n${DOWNLOAD_NOTICE.body}`, {
      timeout: 0,
      actions: [
        { label: DOWNLOAD_NOTICE.confirm, onClick: (t) => { t.close(); finish(true); } },
        { label: DOWNLOAD_NOTICE.cancel, onClick: (t) => { t.close(); finish(false); } },
      ],
    });
  });
}

/** Translator API 路線：目標語言不在 Prompt API 的支援清單內時走這裡。 */
async function translateDirectly(original, target, toast) {
  const detected = await detectLanguage(original);
  const source = detected?.language ?? 'en';
  if (sameLanguage(source, target)) {
    ui.showToast(`這段已經是${languageName(target)}了。`, { timeout: 3000 });
    return null;
  }
  return translateText(original, source, target, {
    onChunk: (p) => toast.update(p.length > 120 ? p.slice(-120) : p),
    streamThreshold: 120,
    onDownloadProgress: (l) => toast.update(`正在下載裝置端翻譯模型（只需下載一次）… ${Math.round(l * 100)}%`),
  });
}

function getEditable() {
  let el = document.activeElement;
  // 焦點可能在 Shadow DOM 內（例如某些編輯器）
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  if (!el) return null;
  if (el.tagName === 'TEXTAREA') return el;
  if (el.tagName === 'INPUT' && /^(text|search|url|email|tel|)$/i.test(el.type)) return el;
  if (el.isContentEditable) return el;
  return null;
}

function readValue(el) {
  return el.isContentEditable ? el.innerText : el.value;
}

/**
 * 寫回內容。
 * input/textarea 直接改 value 的話，React 之類的受控元件收不到變更，
 * 必須走原生 setter 再手動派發 input 事件。
 */
function writeValue(el, text) {
  if (el.isContentEditable) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    // execCommand 已被標示為 deprecated，但它是目前唯一能讓
    // 富文字編輯器正確接上復原堆疊的方式
    if (!document.execCommand('insertText', false, text)) {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return;
  }

  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  el.focus();
  if (setter) setter.call(el, text); else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  el.setSelectionRange?.(text.length, text.length);
}
