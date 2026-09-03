import * as ui from './ui.js';
import {
  createSession, forkSession, planOutputLanguage,
  needsDownloadConsent, DOWNLOAD_NOTICE, isQuotaError,
} from '../ai/language-model.js';
import { imageTranscribeSystemPrompt } from '../ai/prompts.js';
import { localizeText } from '../ai/localize.js';
import { planTiles, groupBoxes, detectTextRegions } from '../ai/image-tiles.js';
import { isModelCrashError, explainModelError } from '../ai/capability.js';
import { languageName } from '../ai/languages.js';
import { MSG, send } from '../lib/messaging.js';

/**
 * 圖片文字翻譯。
 *
 * 管線：抓圖 → 找出文字區塊 → 模型逐塊轉錄 → Translator 轉成目標語言 → 面板。
 *
 * 譯文**不疊回圖片上**：Prompt API 只給文字不給座標，而系統 OCR 的座標
 * 雖然準、卻要使用者自己去開實驗性旗標。面板兩邊都能用，也方便核對原文。
 * 模型只做轉錄、不做翻譯 —— 轉錄對小模型容易得多，翻譯交給專用模型，
 * 和文字那條管線同樣的分工。
 *
 * 只由右鍵選單觸發，不會自動掃描頁面上的圖片：一張大圖會被切成好幾塊，
 * 每塊都是一次模型呼叫，自動處理一頁上的幾十張圖會讓瀏覽器停擺。
 */

let settings = null;
/** 最後一次按右鍵的圖片。右鍵選單只給得到網址，拿不到元素本身。 */
let lastImage = null;
let controller = null;
let busy = false;

export function init(cfg) {
  settings = cfg;
  document.addEventListener('contextmenu', rememberImage, true);
}

export function updateSettings(patch) {
  settings = { ...settings, ...patch };
}

export function destroy() {
  document.removeEventListener('contextmenu', rememberImage, true);
  controller?.abort();
  controller = null;
  lastImage = null;
}

/**
 * 記住游標下的圖片。
 *
 * 右鍵選單的 info 只帶 srcUrl，沒有元素 —— 而我們需要元素才知道面板要開在
 * 哪裡。用 srcUrl 反查 `img[src="..."]` 在 srcset、lazy-load、同圖多處出現時
 * 都不可靠，直接在按下右鍵的當下記起來最準。
 */
function rememberImage(e) {
  const el = e.composedPath?.().find((n) => n instanceof HTMLImageElement)
    ?? (e.target instanceof HTMLImageElement ? e.target : null);
  lastImage = el ?? null;
}

/**
 * 翻譯圖片中的文字。
 * @param {string} srcUrl 右鍵選單給的圖片網址，用來對照與備援
 */
export async function translateImage(srcUrl) {
  if (busy) {
    ui.showToast('已經有一張圖片在辨識中，請等它完成。', { timeout: 3000 });
    return;
  }

  const el = lastImage?.isConnected ? lastImage : null;
  const rect = el?.getBoundingClientRect() ?? centerRect();
  const target = settings.targetLanguage;

  controller?.abort();
  controller = new AbortController();
  const { signal } = controller;

  const panel = ui.showPanel(rect, 'ReadDuck · 圖片文字', {
    onClose: () => controller?.abort(),
    actions: [{
      label: '複製',
      onClick: (p) => {
        navigator.clipboard?.writeText(p.getText()).then(
          () => ui.showToast('已複製', { timeout: 1500 }),
          () => ui.showToast('複製失敗', { timeout: 2000 }),
        );
      },
    }],
  });

  busy = true;
  try {
    panel.setStatus('讀取圖片…');
    const { blob, captured } = await loadImage(el, srcUrl, signal);
    const bitmap = await createImageBitmap(blob);
    const tiles = await planRegions(bitmap);

    const plan = planOutputLanguage(target);
    // 圖片是另一種模態，模型資料可能是另外一份，下載一律先問過
    if (await needsDownloadConsent(plan.modelLanguage, { image: true })) {
      const agreed = await panel.setConfirm({
        title: DOWNLOAD_NOTICE.title,
        message: DOWNLOAD_NOTICE.body,
        confirmLabel: DOWNLOAD_NOTICE.confirm,
        cancelLabel: DOWNLOAD_NOTICE.cancel,
        signal,
      });
      if (!agreed) { bitmap.close?.(); panel.close?.(); return; }
    }

    const raw = await transcribe(bitmap, tiles, plan, signal, (done, total) => {
      panel.setStatus(total > 1 ? `辨識中… ${done}/${total} 塊` : '辨識中…');
    });
    bitmap.close?.();

    if (!raw) {
      panel.setStatus('這張圖裡沒有讀得出來的文字。');
      return;
    }

    panel.setStatus(`翻譯成${languageName(target)}…`);
    const translated = await localizeText(raw, plan, { signal });
    // 走截圖那條路時要講一聲：解析度和涵蓋範圍都和原圖不同，
    // 讀得不完整時使用者才知道是什麼原因
    const note = captured
      ? '\n\n（這張圖無法直接讀取，改用畫面擷取。只涵蓋看得到的部分，把圖片捲到完整可見可以讀得更全。）'
      : '';
    panel.setText(format(translated, raw) + note, false);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    panel.setError(describeFailure(err));
  } finally {
    busy = false;
  }
}

/**
 * 決定要把圖片切成哪些區塊送進模型。
 *
 * 系統 OCR 可用的話就只裁真正有文字的地方 —— 那些區塊通常遠小於模型的
 * 768px，完全不會被縮小，而且呼叫次數比盲切格線少得多。
 * 不可用（沒開旗標、或平台不支援）就退回等距切塊。
 */
async function planRegions(bitmap) {
  const detected = await detectTextRegions(bitmap);
  if (detected.available && detected.boxes.length) {
    const groups = groupBoxes(detected.boxes);
    if (groups.length) return groups.map((g) => clampBox(g, bitmap));
  }
  return planTiles(bitmap.width, bitmap.height);
}

/** 群組的留邊可能超出圖片邊界，裁切前收回來。 */
function clampBox(g, size) {
  const x = Math.max(0, Math.min(g.x, size.width - 1));
  const y = Math.max(0, Math.min(g.y, size.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(g.width, size.width - x)),
    height: Math.max(1, Math.min(g.height, size.height - y)),
  };
}

/**
 * 拿到圖片的 Blob。
 *
 * **一律繞到 service worker 去抓。** MV3 的 content script `fetch` 是「代表所在
 * 網頁的來源」發出的，照樣受網頁的 CORS 限制 —— 擴充功能的 host permissions
 * 在這裡幫不上忙。圖床做防盜連、或單純沒送 CORS 標頭的網站（漫畫站幾乎都是）
 * 就會被擋掉，而那正是這個功能最需要能用的場景。
 *
 * 例外是 blob: 與 data:：blob: 是網頁自己建立的，只有網頁的情境解析得了，
 * service worker 抓不到；data: 本來就在手上，繞一圈只是浪費。
 */
async function loadImage(el, srcUrl, signal) {
  const url = srcUrl || el?.currentSrc || el?.src;

  // blob: 是網頁自己建立的，只有網頁的情境解析得了；data: 本來就在手上
  if (url?.startsWith('blob:') || url?.startsWith('data:')) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`圖片讀取失敗（HTTP ${res.status}）`);
    return { blob: await res.blob(), captured: false };
  }

  if (url) {
    const r = await send(MSG.FETCH_IMAGE, { url });
    if (r?.dataUrl) {
      const res = await fetch(r.dataUrl, { signal });
      return { blob: await res.blob(), captured: false };
    }
    // 抓不到就走截圖那條路 —— 防盜連、要登入的圖、CDN 擋掉非網頁請求，
    // 重新請求一次都會再被拒絕一次，但畫面上的像素一定拿得到
    const shot = await captureFromScreen(el, signal);
    if (shot) return { blob: shot, captured: true };
    throw new ImageFetchError(r?.error ?? '沒有回應');
  }

  const shot = await captureFromScreen(el, signal);
  if (shot) return { blob: shot, captured: true };
  throw new ImageFetchError('找不到圖片網址');
}

/**
 * 從畫面上裁出這張圖片。
 *
 * 擷取的是瀏覽器已經畫出來的像素，所以防盜連、CORS、登入牆全都繞得過。
 * 代價是只有可見範圍，而且解析度是「顯示尺寸 × devicePixelRatio」——
 * 圖片被縮小顯示的話，小字可能比原圖更難讀。
 */
async function captureFromScreen(el, signal) {
  if (!el?.isConnected) return null;

  const rect = el.getBoundingClientRect();
  // 只取和視窗相交的那一塊
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right - left < 8 || bottom - top < 8) return null;   // 幾乎沒露出來

  const r = await send(MSG.CAPTURE_TAB);
  if (!r?.dataUrl) return null;

  const shot = await createImageBitmap(await (await fetch(r.dataUrl, { signal })).blob());
  try {
    // 擷取的圖是實體像素，版面座標要乘上 devicePixelRatio 才對得上
    const dpr = shot.width / window.innerWidth;
    const sx = Math.round(left * dpr);
    const sy = Math.round(top * dpr);
    const sw = Math.max(1, Math.round((right - left) * dpr));
    const sh = Math.max(1, Math.round((bottom - top) * dpr));

    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d').drawImage(shot, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas.convertToBlob();
  } finally {
    shot.close?.();
  }
}

/** 抓圖失敗。和模型的錯誤分開，說明才給得準。 */
class ImageFetchError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'ImageFetchError';
  }
}

/** 逐塊辨識再接起來。每塊用獨立分支，避免前一塊的輸出影響下一塊。 */
async function transcribe(bitmap, tiles, plan, signal, onProgress) {
  const config = {
    systemPrompt: imageTranscribeSystemPrompt(plan.modelLanguage, settings.customPrompts),
    mode: 'precise',
    outputLanguage: plan.modelLanguage,
    imageInput: true,
  };
  const session = await createSession({ ...config, signal });

  const parts = [];
  try {
    for (let i = 0; i < tiles.length; i++) {
      onProgress(i + 1, tiles.length);
      const piece = await cropTile(bitmap, tiles[i]);
      const branch = await forkSession(session, config, { signal });
      try {
        const answer = await branch.prompt([{
          role: 'user',
          content: [
            { type: 'text', value: 'Transcribe the text in this image.' },
            { type: 'image', value: piece },
          ],
        }], { signal });
        const text = answer.trim();
        if (text && text !== 'NO_TEXT') parts.push(text);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        // 崩潰就整個停手：一張大圖有好幾塊，每塊各試一次會很快把瀏覽器的
        // 崩潰額度用光，連帶讓其他 AI 功能一起不能用
        if (isModelCrashError(err)) throw err;
        if (isQuotaError(err)) { console.warn('[ReadDuck] 這一塊超出上下文，略過'); continue; }
        console.warn(`[ReadDuck] 第 ${i + 1} 塊辨識失敗：`, explainModelError(err));
      } finally {
        branch.destroy?.();
      }
    }
  } finally {
    session.destroy?.();
  }
  return parts.join('\n');
}

/** 從原圖裁一塊出來。整張就是一塊時不必多繞一次畫布。 */
async function cropTile(bitmap, tile) {
  if (tile.x === 0 && tile.y === 0
      && tile.width === bitmap.width && tile.height === bitmap.height) {
    return bitmap;
  }
  const canvas = new OffscreenCanvas(tile.width, tile.height);
  canvas.getContext('2d').drawImage(
    bitmap, tile.x, tile.y, tile.width, tile.height, 0, 0, tile.width, tile.height,
  );
  return canvas.convertToBlob();
}

/** 譯文在前、原文在後 —— 使用者要的是譯文，原文是拿來核對的。 */
function format(translated, raw) {
  if (translated.trim() === raw.trim()) return raw;
  return `${translated}\n\n—— 原文 ——\n${raw}`;
}

function describeFailure(err) {
  if (err?.name === 'NotSupportedError') {
    return '這個瀏覽器的語言模型不支援圖片輸入。目前只有 Chrome 支援。';
  }
  if (err?.name === 'ImageFetchError') {
    return `讀不到這張圖片（${err.message}）。\n`
      + '圖片可能需要登入才看得到，或伺服器擋掉了非瀏覽網頁的請求。';
  }
  return explainModelError(err);
}

/** 拿不到圖片元素時（例如它已經被移除）把面板開在畫面中央。 */
function centerRect() {
  const x = window.innerWidth / 2;
  const y = window.innerHeight / 3;
  return { left: x, right: x, top: y, bottom: y, width: 0, height: 0 };
}
