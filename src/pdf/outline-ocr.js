import {
  createSession, forkSession, planOutputLanguage, needsDownloadConsent, checkAvailability, isQuotaError,
} from '../ai/language-model.js';
import { pdfOutlineTranscribeSystemPrompt } from '../ai/prompts.js';
import { isModelCrashError, explainModelError } from '../ai/capability.js';
import { planComposites, parseTranscript } from './outlines.js';

/**
 * 辨識畫成圖形的文字（找外框、整理成行的純邏輯在 outlines.js）。
 *
 * 流程：把有外框字的那一塊頁面用高解析度畫出來 → 每一行裁下來排進拼貼圖、
 * 左邊印上編號 → 模型照編號逐行轉錄 → 對回每一行的位置。
 *
 * 模型只轉錄、不翻譯 —— 和圖片翻譯同樣的分工，翻譯交給專用的 Translator。
 * 語言模型是數 GB 的下載，建立 session 之前一律先問過使用者（硬限制 #3）；
 * 圖片是另一種模態，查 availability 時要帶 image，否則查到的是純文字模型。
 */

/** 拼貼圖裡每一行的字高（像素）。太小模型讀不清楚，太大一張圖放不了幾行 */
const TARGET_TEXT_PX = 28;
const MAX_SCALE = 5;
/** 裁切時四周多留的邊（pt），墨跡邊緣才不會被切掉 */
const CROP_PAD = 1.5;

export class OutlineReader {
  #customPrompts;
  #askConsent;
  #onDownloadProgress;
  #session = null;
  #config = null;
  #declined = false;

  /**
   * @param {object} o
   * @param {object} [o.customPrompts] 使用者覆寫的 prompt
   * @param {() => Promise<boolean>} o.askConsent 模型還沒下載時問使用者要不要下載
   * @param {(loaded: number) => void} [o.onDownloadProgress]
   */
  constructor({ customPrompts, askConsent, onDownloadProgress } = {}) {
    this.#customPrompts = customPrompts;
    this.#askConsent = askConsent ?? (async () => false);
    this.#onDownloadProgress = onDownloadProgress;
  }

  /** 轉錄用的輸出語言：原文的語言（Prompt API 支援的話），否則英文。 */
  static languageFor(sourceLanguage) {
    return planOutputLanguage(sourceLanguage).modelLanguage;
  }

  /** @returns {Promise<'available'|'downloadable'|'downloading'|'unavailable'>} */
  availability(sourceLanguage) {
    return checkAvailability(OutlineReader.languageFor(sourceLanguage), { image: true });
  }

  /**
   * 辨識這些線段。
   * @param page PDF.js 的頁面
   * @param {Array} segments outlineSegments() 裡值得辨識的那些
   * @returns {Promise<Map<object, string>|null>} 線段 → 文字；使用者不下載模型時是 null
   */
  async read(page, segments, sourceLanguage, { signal, onProgress } = {}) {
    const language = OutlineReader.languageFor(sourceLanguage);
    if (!(await this.#ensureSession(language, signal))) return null;

    const region = await renderRegion(page, segments);
    try {
      const crops = segments.map((s) => cropRect(s, region.toPixel));
      const sheets = planComposites(crops);
      const texts = new Map();
      for (const [n, sheet] of sheets.entries()) {
        onProgress?.(n + 1, sheets.length);
        const image = await composeSheet(region.canvas, crops, sheet);
        const rows = new Set(sheet.rows.map((r) => r.index));
        for (const [label, text] of parseTranscript(await this.#ask(image, sheet, signal))) {
          // 模型偶爾會編出不在這張圖上的編號，不能讓它蓋掉別張圖的結果
          if (rows.has(label - 1)) texts.set(segments[label - 1], text);
        }
      }
      return texts;
    } finally {
      region.canvas.width = 0;   // 高解析度的大畫布，用完馬上釋放
    }
  }

  destroy() {
    this.#session?.destroy?.();
    this.#session = null;
  }

  async #ensureSession(language, signal) {
    if (this.#session && this.#config?.outputLanguage === language) return true;
    if (this.#declined) return false;
    if (await needsDownloadConsent(language, { image: true })) {
      if (!(await this.#askConsent())) {
        this.#declined = true;
        return false;
      }
    }
    this.#session?.destroy?.();
    const config = {
      systemPrompt: pdfOutlineTranscribeSystemPrompt(language, this.#customPrompts),
      mode: 'precise',
      outputLanguage: language,
      imageInput: true,
    };
    this.#session = await createSession({ ...config, signal, onDownloadProgress: this.#onDownloadProgress });
    this.#config = config;
    return true;
  }

  /** 每張拼貼圖用獨立的分支，避免前一張的輸出影響下一張、上下文愈積愈滿。 */
  async #ask(image, sheet, signal) {
    const first = sheet.rows[0].index + 1;
    const last = sheet.rows[sheet.rows.length - 1].index + 1;
    const branch = await forkSession(this.#session, this.#config, { signal });
    try {
      return await branch.prompt([{
        role: 'user',
        content: [
          { type: 'text', value: `Transcribe rows [${first}] to [${last}].` },
          { type: 'image', value: image },
        ],
      }], { signal });
    } catch (err) {
      // 取消與崩潰原樣拋出。崩潰要讓呼叫端整份文件停手 —— 瀏覽器對重複崩潰有
      // 斷路器，一張一張各試一次會很快把額度用光，連其他 AI 功能一起停用
      if (err?.name === 'AbortError' || isModelCrashError(err)) throw err;
      if (!isQuotaError(err)) console.warn('[ReadDuck] 圖形文字辨識失敗：', explainModelError(err));
      return '';
    } finally {
      branch.destroy?.();
    }
  }
}

/**
 * 把包住所有線段的那一塊頁面畫到畫布上，解析度讓一般的字高約 TARGET_TEXT_PX。
 * 只畫那一塊：整頁用這個解析度畫，一頁 A4 就要將近 50 MB。
 */
async function renderRegion(page, segments) {
  const heights = segments.map((s) => s.h).sort((a, b) => a - b);
  const typical = heights[heights.length >> 1] || 8;
  const scale = Math.min(MAX_SCALE, Math.max(1, TARGET_TEXT_PX / typical));
  const vp = page.getViewport({ scale });

  const x0 = Math.min(...segments.map((s) => s.x0)) - CROP_PAD;
  const x1 = Math.max(...segments.map((s) => s.x1)) + CROP_PAD;
  const y0 = Math.min(...segments.map((s) => s.y0)) - CROP_PAD;
  const y1 = Math.max(...segments.map((s) => s.y1)) + CROP_PAD;
  const corners = [vp.convertToViewportPoint(x0, y1), vp.convertToViewportPoint(x1, y0)];
  const left = Math.floor(Math.min(corners[0][0], corners[1][0]));
  const top = Math.floor(Math.min(corners[0][1], corners[1][1]));
  const right = Math.ceil(Math.max(corners[0][0], corners[1][0]));
  const bottom = Math.ceil(Math.max(corners[0][1], corners[1][1]));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, right - left);
  canvas.height = Math.max(1, bottom - top);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -left, -top] }).promise;

  const toPixel = (x, y) => {
    const [px, py] = vp.convertToViewportPoint(x, y);
    return [px - left, py - top];
  };
  return { canvas, toPixel };
}

function cropRect(seg, toPixel) {
  const [l, t] = toPixel(seg.x0 - CROP_PAD, seg.y1 + CROP_PAD);
  const [r, b] = toPixel(seg.x1 + CROP_PAD, seg.y0 - CROP_PAD);
  const x = Math.max(0, Math.floor(Math.min(l, r)));
  const y = Math.max(0, Math.floor(Math.min(t, b)));
  return { x, y, w: Math.max(1, Math.ceil(Math.abs(r - l))), h: Math.max(1, Math.ceil(Math.abs(b - t))) };
}

/** 一張拼貼圖：每一行左邊印上 [編號]，右邊是裁下來的那一行。 */
async function composeSheet(source, crops, sheet) {
  const out = new OffscreenCanvas(sheet.width, sheet.height);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'middle';
  for (const row of sheet.rows) {
    const c = crops[row.index];
    ctx.drawImage(source, c.x, c.y, c.w, c.h, row.x, row.y, row.w, row.h);
    ctx.font = `bold ${Math.round(Math.min(18, Math.max(12, row.h * 0.7)))}px sans-serif`;
    ctx.fillText(`[${row.index + 1}]`, 4, row.y + row.h / 2);
  }
  return out.convertToBlob({ type: 'image/png' });
}
