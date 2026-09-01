import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';
import { groupParagraphs } from './extract.js';
import { getSettings } from '../lib/settings.js';
import {
  translateText, checkAvailability,
  NeedsUserActivationError, TranslatorUnavailableError,
} from '../ai/translator-pool.js';
import { detectPageLanguage } from '../ai/detector.js';
import { sameLanguage, canonical, languageName } from '../ai/languages.js';
import { TaskQueue, isAbort } from '../ai/queue.js';
import { explainUnavailable } from '../ai/capability.js';
import { cacheKey } from '../lib/hash.js';
import { MSG, send } from '../lib/messaging.js';
import * as ui from '../content/ui.js';

/**
 * ReadDuck 的 PDF 檢視器：左邊原始頁面，右邊譯文。
 *
 * 為什麼需要自己做一個：瀏覽器內建的 PDF 檢視器是獨立的外掛程序，
 * content script 完全碰不到它裡面的文字，沒有任何辦法在上面加譯文。
 * 所以只能用 PDF.js 自己把頁面畫出來、自己抽文字。
 *
 * 頁面是延遲處理的 —— 捲到才畫、才翻。幾百頁的文件不會一開啟就卡住。
 *
 * 兩種呈現方式，工具列可切換：
 * - side-by-side（預設）：左邊乾淨原文，右邊同一頁疊上譯文。兩邊都保留 PDF 的
 *   原始版面，可以直接對照。右邊那份不會再渲染一次 PDF —— 渲染完把點陣圖複製
 *   過去就好。
 * - overlay：只顯示疊上譯文的那一份，適合專心讀譯文。
 *
 * 譯文停在原地不會因為滑過而淡出 —— 那會在閱讀和選取文字時很干擾。想看原文
 * 的話，滑鼠停留會顯示原句的提示。
 */

const $ = (id) => document.getElementById(id);

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('vendor/pdfjs/pdf.worker.min.mjs');

const ZOOM_STEPS = [0.5, 0.65, 0.8, 1, 1.25, 1.5, 2];

let settings = null;
let doc = null;
let queue = null;
let observer = null;
let zoomIndex = 3;
let mode = 'side-by-side';
let sourceLanguage = null;
let sourceUrl = null;
/** pageNumber -> row */
const rows = new Map();
let stats = { total: 0, done: 0 };
let warned = new Set();

init().catch((err) => showNotice('err', `初始化失敗：${err.message}`));

async function init() {
  settings = await getSettings();
  queue = new TaskQueue(settings.concurrency);
  setMode(mode);
  bindUi();

  if (settings.showFloatingButton) mountFab();

  const file = new URLSearchParams(location.search).get('file');
  if (!file) return;

  sourceUrl = file;
  $('openNative').hidden = false;
  await openUrl(file);
}

function bindUi() {
  $('openFile').addEventListener('click', () => $('filePicker').click());
  $('filePicker').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) openFile(f);
  });
  $('toggleMode').addEventListener('click', () => setMode(mode === 'overlay' ? 'side-by-side' : 'overlay'));
  $('zoomIn').addEventListener('click', () => setZoom(zoomIndex + 1));
  $('zoomOut').addEventListener('click', () => setZoom(zoomIndex - 1));
  $('openNative').addEventListener('click', () => {
    if (sourceUrl) chrome.tabs.create({ url: sourceUrl });
  });

  // 拖進來就開啟。本機檔案走這條路完全不需要「允許存取檔案網址」權限。
  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    document.body.classList.remove('dragging');
    const f = [...(e.dataTransfer?.files ?? [])].find((x) => /pdf$/i.test(x.type) || /\.pdf$/i.test(x.name));
    if (f) openFile(f);
  });
}

/* ------------------------------------------------------------ 開檔 */

async function openUrl(url) {
  setStatus('讀取中…');
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await load(await res.arrayBuffer(), decodeURIComponent(url.split('/').pop() || 'PDF'));
  } catch (err) {
    showNotice('err',
      `無法讀取這個 PDF：${err.message}\n`
      + '如果它是本機檔案，請改用上方的「開啟本機檔案」，或把檔案拖進這個視窗。');
    setStatus('讀取失敗');
  }
}

async function openFile(file) {
  setStatus('讀取中…');
  try {
    await load(await file.arrayBuffer(), file.name);
  } catch (err) {
    showNotice('err', `無法讀取這個 PDF：${err.message}`);
    setStatus('讀取失敗');
  }
}

async function load(data, name) {
  reset();
  hideNotice();
  $('docTitle').textContent = name;

  doc = await pdfjsLib.getDocument({ data }).promise;
  $('pages').innerHTML = '';

  for (let n = 1; n <= doc.numPages; n++) $('pages').appendChild(createRow(n));

  observer = new IntersectionObserver(onVisible, { root: $('pages'), rootMargin: '600px 0px' });
  for (const row of rows.values()) observer.observe(row.shell);

  updateStatus();
  checkTranslator();
}

/* ------------------------------------------------------ 浮動按鈕 */

/**
 * 掛上和一般網頁相同的浮動鴨子。
 *
 * 這裡是擴充功能頁面，沒有 content script，所以要自己掛。ui.js 不依賴任何
 * chrome.* API，可以直接重用。
 *
 * 設定頁由本頁直接呼叫 openOptionsPage()，不繞 service worker。
 */
function mountFab() {
  ui.showFab({
    title: 'ReadDuck：切換譯文顯示方式',
    // 一般網頁上鴨子是開關翻譯，PDF 一定會翻，所以改成切換呈現方式
    onClick: () => setMode(mode === 'overlay' ? 'side-by-side' : 'overlay'),
    onOptions: () => chrome.runtime.openOptionsPage(),
  });
}

function reset() {
  observer?.disconnect();
  observer = null;
  queue.clear();
  rows.clear();
  stats = { total: 0, done: 0 };
  sourceLanguage = null;
  warned = new Set();
  doc?.destroy?.();
  doc = null;
}

/* ---------------------------------------------------------- 版面 */

function createRow(pageNumber) {
  const row = document.createElement('div');
  row.className = 'page-row';

  // 左：乾淨原文。右：同一頁 + 譯文覆蓋層
  const clean = document.createElement('div');
  clean.className = 'page-shell page-clean';
  const cleanCanvas = document.createElement('canvas');
  cleanCanvas.className = 'page-canvas';
  clean.append(cleanCanvas, badge(pageNumber));

  const shell = document.createElement('div');
  shell.className = 'page-shell';
  const canvas = document.createElement('canvas');
  canvas.className = 'page-canvas';
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  shell.append(canvas, overlay, badge(pageNumber));

  const note = document.createElement('div');
  note.className = 'page-note';
  note.hidden = true;

  row.append(clean, shell, note);
  rows.set(pageNumber, {
    pageNumber, row, clean, cleanCanvas, shell, canvas, overlay, note,
    started: false, slots: [], cssViewport: null,
  });
  return row;
}

function badge(pageNumber) {
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = String(pageNumber);
  return num;
}

function onVisible(entries) {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const pageNumber = Number(entry.target.parentElement?.dataset.page
      ?? [...rows.values()].find((r) => r.shell === entry.target)?.pageNumber);
    const row = rows.get(pageNumber);
    if (!row || row.started) continue;
    row.started = true;
    observer.unobserve(row.shell);
    processPage(row).catch((err) => console.warn('[ReadDuck] PDF 頁面處理失敗', err));
  }
}

async function processPage(row) {
  const page = await doc.getPage(row.pageNumber);
  await renderCanvas(page, row);
  await translatePage(page, row);
}

async function renderCanvas(page, row) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = ZOOM_STEPS[zoomIndex];

  // 兩個 viewport：畫布用實體像素（清晰），覆蓋層定位用 CSS 像素
  const deviceViewport = page.getViewport({ scale: scale * dpr });
  const cssViewport = page.getViewport({ scale });
  row.cssViewport = cssViewport;
  row.dpr = dpr;

  row.canvas.width = deviceViewport.width;
  row.canvas.height = deviceViewport.height;
  row.canvas.style.width = `${cssViewport.width}px`;
  row.canvas.style.height = `${cssViewport.height}px`;
  row.shell.style.width = `${cssViewport.width}px`;
  row.shell.style.height = `${cssViewport.height}px`;

  await page.render({
    canvasContext: row.canvas.getContext('2d'),
    viewport: deviceViewport,
  }).promise;

  // 左邊那份直接複製點陣圖，不重新渲染一次 PDF
  row.cleanCanvas.width = deviceViewport.width;
  row.cleanCanvas.height = deviceViewport.height;
  row.cleanCanvas.style.width = `${cssViewport.width}px`;
  row.cleanCanvas.style.height = `${cssViewport.height}px`;
  row.cleanCanvas.getContext('2d').drawImage(row.canvas, 0, 0);

  layoutOverlay(row);
}

/* ------------------------------------------------------ 譯文覆蓋層 */

/** 依段落座標把譯文方塊擺回原文的位置。縮放後也要重跑一次。 */
function layoutOverlay(row) {
  const vp = row.cssViewport;
  if (!vp) return;
  for (const slot of row.slots) {
    if (!slot.ovEl) continue;
    const { x0, x1, yTop, yBottom } = slot.bbox;
    const [left, top] = vp.convertToViewportPoint(x0, yTop);
    const [right, bottom] = vp.convertToViewportPoint(x1, yBottom);

    // 往外擴一點點：PDF 回報的字元寬度會有誤差，剛好貼齊的話原文的最後
    // 一個字會從覆蓋層右緣露出來。
    const pad = 2;
    slot.ovEl.style.left = `${Math.min(left, right) - pad}px`;
    slot.ovEl.style.top = `${Math.min(top, bottom) - pad}px`;
    slot.ovEl.style.width = `${Math.abs(right - left) + pad * 2}px`;
    slot.ovEl.style.minHeight = `${Math.abs(bottom - top) + pad * 2}px`;
    slot.ovEl.style.fontSize = `${slot.fontSize * vp.scale}px`;
    if (slot.translated) fitText(slot.ovEl);
  }
}

/**
 * 譯文長度和原文不一樣，塞不進原本的框時把字縮小。
 * 縮到下限還是放不下就讓它往下溢出 —— 蓋住下一段總比截斷內容好。
 */
function fitText(el) {
  const base = parseFloat(el.style.fontSize) || 12;
  const min = base * 0.6;
  let size = base;
  el.style.fontSize = `${size}px`;
  while (el.scrollHeight > el.clientHeight + 1 && size > min) {
    size -= Math.max(0.5, base * 0.05);
    el.style.fontSize = `${size}px`;
  }
}

/**
 * 把整頁的像素一次讀出來。
 *
 * 每個段落各自呼叫 getImageData 會讓一頁產生上百次 GPU→CPU 讀回，Chrome 會
 * 警告「Multiple readback operations」。改成整頁讀一次、之後在記憶體裡取樣。
 *
 * 順帶一提，getContext('2d', { willReadFrequently: true }) 這個選項只有在
 * 該畫布**第一次**取得 context 時才生效；renderCanvas 已經先建立過 context 了，
 * 之後再傳都會被忽略。而且那個選項會強迫畫布走軟體繪製，反而拖慢 PDF 渲染 ——
 * 減少讀回次數才是對的解法。
 *
 * @returns {ImageData|null}
 */
function readPagePixels(row) {
  try {
    const ctx = row.canvas.getContext('2d');
    return ctx.getImageData(0, 0, row.canvas.width, row.canvas.height);
  } catch {
    return null;   // 畫布被污染或尺寸為 0
  }
}

/**
 * 取樣段落四周的顏色當作覆蓋層底色。
 * 一律用白色的話，深色底的 PDF 會出現一塊白斑。
 */
function sampleBackground(row, bbox, pixels) {
  if (!pixels) return null;
  const vp = row.cssViewport;
  const dpr = row.dpr ?? 1;
  const [left, top] = vp.convertToViewportPoint(bbox.x0, bbox.yTop);
  const [right, bottom] = vp.convertToViewportPoint(bbox.x1, bbox.yBottom);
  const x0 = Math.min(left, right), x1 = Math.max(left, right);
  const y0 = Math.min(top, bottom), y1 = Math.max(top, bottom);

  const channels = [[], [], []];
  for (let i = 1; i <= 5; i++) {
    const x = x0 + ((x1 - x0) * i) / 6;
    for (const y of [y0 - 3, y1 + 3]) {   // 段落上下緣外側 = 頁面底色
      const dx = Math.round(x * dpr);
      const dy = Math.round(y * dpr);
      if (dx < 0 || dy < 0 || dx >= pixels.width || dy >= pixels.height) continue;
      const at = (dy * pixels.width + dx) * 4;
      channels[0].push(pixels.data[at]);
      channels[1].push(pixels.data[at + 1]);
      channels[2].push(pixels.data[at + 2]);
    }
  }
  if (!channels[0].length) return null;

  const mid = (arr) => arr.sort((a, b) => a - b)[arr.length >> 1];
  return `rgb(${mid(channels[0])}, ${mid(channels[1])}, ${mid(channels[2])})`;
}

/* ---------------------------------------------------------- 翻譯 */

async function translatePage(page, row) {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const paragraphs = groupParagraphs(content.items, viewport.width)
    .filter((p) => p.text.trim().length >= settings.minTextLength);

  if (!paragraphs.length) {
    showNote(row, '這一頁沒有可抽取的文字（可能是掃描檔或純圖片）。');
    return;
  }

  if (!sourceLanguage) {
    const detected = await detectPageLanguage(paragraphs.map((p) => p.text));
    sourceLanguage = detected?.language ?? null;
    if (sourceLanguage && sameLanguage(sourceLanguage, settings.targetLanguage)) {
      showNotice('warn', `這份文件已經是${languageName(sourceLanguage)}，不需要翻譯。`);
    }
    updateStatus();
  }

  if (!sourceLanguage || sameLanguage(sourceLanguage, settings.targetLanguage)) {
    showNote(row, `這一頁已經是${languageName(settings.targetLanguage)}，不需要翻譯。`);
    return;
  }

  row.overlay.innerHTML = '';

  // 整頁像素只讀一次，取樣完就讓它被回收
  const pixels = readPagePixels(row);

  const slots = paragraphs.map((p) => {
    const ovEl = document.createElement('div');
    ovEl.className = 'ov pending';
    ovEl.title = p.text;      // 滑鼠停留可看原文
    row.overlay.appendChild(ovEl);

    const bg = sampleBackground(row, p.bbox, pixels);
    if (bg) ovEl.style.background = bg;

    return { text: p.text, bbox: p.bbox, fontSize: p.fontSize, ovEl, translated: null };
  });
  row.slots = slots;
  layoutOverlay(row);

  stats.total += slots.length;
  updateStatus();

  const target = canonical(settings.targetLanguage);
  const keys = slots.map((s) => cacheKey(s.text, sourceLanguage, target));
  const hits = settings.cacheEnabled ? (await send(MSG.CACHE_GET, { keys }) ?? {}) : {};

  const pending = [];
  slots.forEach((slot, i) => {
    const cached = hits[keys[i]];
    if (cached) {
      fill(row, slot, cached);
      stats.done++;
    } else {
      pending.push({ slot, key: keys[i] });
    }
  });
  updateStatus();

  const buffer = [];
  await Promise.all(pending.map(({ slot, key }, i) => queue
    .add((signal) => translateSlot(row, slot, key, buffer, signal), { priority: i })
    .catch((err) => {
      if (isAbort(err)) return;
      handleError(err, slot);
    })));

  if (buffer.length && settings.cacheEnabled) send(MSG.CACHE_PUT, { entries: buffer });
}

async function translateSlot(row, slot, key, buffer, signal) {
  const translated = await translateText(
    slot.text, sourceLanguage, settings.targetLanguage, { signal }
  );
  if (signal?.aborted) return;
  fill(row, slot, translated);
  buffer.push({ k: key, v: translated });
  stats.done++;
  updateStatus();
}

function fill(row, slot, text) {
  slot.translated = text;
  slot.ovEl.className = 'ov';
  slot.ovEl.textContent = text;
  // 覆蓋層被隱藏時量不到尺寸，切回 overlay 模式時會再排一次
  if (mode === 'overlay') fitText(slot.ovEl);
}

/** 頁面層級的說明（沒有文字、不需要翻譯）。 */
function showNote(row, text) {
  row.note.textContent = text;
  row.note.hidden = false;
}

function handleError(err, slot) {
  if (err instanceof NeedsUserActivationError) {
    warnOnce('activation', () =>
      showNotice('warn', '第一次使用需要下載翻譯模型，瀏覽器規定必須由你操作才能開始。請按一下頁面任一處後重新整理。'));
  } else if (err instanceof TranslatorUnavailableError) {
    warnOnce('unavailable', () =>
      showNotice('err', `${languageName(err.sourceLanguage)} → ${languageName(err.targetLanguage)} 這個語言組合目前無法翻譯。`));
  }
  slot.ovEl.className = 'ov failed';
  slot.ovEl.title = `翻譯失敗：${err?.message || err}`;
  slot.ovEl.textContent = '翻譯失敗';
}

function warnOnce(key, fn) {
  if (warned.has(key)) return;
  warned.add(key);
  fn();
}

async function checkTranslator() {
  if (!('Translator' in self)) {
    showNotice('err', explainUnavailable('unavailable', '翻譯').body);
    return;
  }
  const availability = await checkAvailability(sourceLanguage || 'en', settings.targetLanguage);
  if (availability === 'unavailable') {
    showNotice('err', explainUnavailable('unavailable', '翻譯').body);
  }
}

/* ---------------------------------------------------------- 模式 */

function setMode(next) {
  mode = next;
  document.body.dataset.mode = mode;
  // 按鈕顯示的是「按下去會切到哪一種」
  $('toggleMode').textContent = mode === 'overlay' ? '左右對照' : '只看譯文';
  // display:none 的元素量不到尺寸，切回來時要重新縮放字級
  if (mode === 'overlay') for (const row of rows.values()) layoutOverlay(row);
}

/* ---------------------------------------------------------- 縮放 */

function setZoom(index) {
  const next = Math.min(Math.max(index, 0), ZOOM_STEPS.length - 1);
  if (next === zoomIndex || !doc) { zoomIndex = next; updateZoomLabel(); return; }
  zoomIndex = next;
  updateZoomLabel();

  // 只重畫已經畫過的頁面，其餘的等捲到再說
  for (const row of rows.values()) {
    if (!row.started) continue;
    doc.getPage(row.pageNumber)
      .then((page) => renderCanvas(page, row))
      .catch(() => {});
  }
}

function updateZoomLabel() {
  $('zoomLabel').textContent = `${Math.round(ZOOM_STEPS[zoomIndex] * 100)}%`;
}

/* ---------------------------------------------------------- 狀態 */

function setStatus(text) { $('docStatus').textContent = text; }

function updateStatus() {
  const pending = Math.max(0, stats.total - stats.done);
  ui.setFabState(pending === 0 && stats.total > 0, pending > 0 ? String(Math.min(pending, 99)) : '');

  if (!doc) return;
  const parts = [`${doc.numPages} 頁`];
  if (sourceLanguage) {
    parts.push(`${languageName(sourceLanguage)} → ${languageName(settings.targetLanguage)}`);
  }
  if (stats.total) parts.push(`已翻譯 ${stats.done}/${stats.total} 段`);
  setStatus(parts.join(' · '));
}

function showNotice(kind, text) {
  const el = $('notice');
  el.className = `notice ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

function hideNotice() { $('notice').hidden = true; }
