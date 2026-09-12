import * as pdfjsLib from '../../vendor/pdfjs/pdf.min.mjs';
import { groupParagraphs, isTranslatable } from './extract.js';
import { filledPathBoxes, outlineSegments, worthReading, groupOutlineBlocks } from './outlines.js';
import { OutlineReader } from './outline-ocr.js';
import { getSettings } from '../lib/settings.js';
import { initTheme } from '../lib/theme.js';
import {
  translateText, checkAvailability,
  NeedsUserActivationError, TranslatorUnavailableError,
} from '../ai/translator-pool.js';
import { detectPageLanguage } from '../ai/detector.js';
import { sameLanguage, canonical, languageName } from '../ai/languages.js';
import { TaskQueue, isAbort } from '../ai/queue.js';
import { explainUnavailable, isModelCrashError, explainModelError } from '../ai/capability.js';
import { cacheKey } from '../lib/hash.js';
import { MSG, send } from '../lib/messaging.js';
import { base64ToBytes, isPdfBytes, sniffNonPdf } from '../lib/binary.js';
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
/** 原本顯示這份 PDF 的分頁。先請它把檔案交過來，見 content/pdf-source.js */
let sourceTabId = null;
/** pageNumber -> row */
const rows = new Map();
let stats = { total: 0, done: 0, reading: null };
let warned = new Set();

/**
 * 畫成圖形的文字（見 outlines.js / outline-ocr.js）。一次只辨識一頁：語言模型一次
 * 只能做一件事，而且崩潰有斷路器 —— 崩潰一次就整個停手（ocrStopped），這個分頁
 * 之後都不再試。
 */
let ocrQueue = null;
let outlineReader = null;
let ocrController = null;
let ocrStopped = false;
/** 外框字至少要有這麼多行值得辨識，才動用語言模型（零星幾個多半是圖上的標籤） */
const MIN_OUTLINE_LINES = 2;

init().catch((err) => showNotice('err', `初始化失敗：${err.message}`));

async function init() {
  initTheme();
  settings = await getSettings();
  // 檢視器的浮動鴨子和網頁上是同一套 Shadow DOM UI，主題要另外餵給它
  ui.setTheme(settings.theme);
  queue = new TaskQueue(settings.concurrency);
  ocrQueue = new TaskQueue(1);
  setMode(mode);
  bindUi();

  if (settings.showFloatingButton) mountFab();

  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  sourceTabId = Number(params.get('tab')) || null;
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
  // 先向正在顯示這份 PDF 的分頁要：那邊同源、帶得到登入狀態，還可能直接命中
  // 瀏覽器快取。拿不到（分頁關了、跨來源、失聯）才由這裡自己抓。
  const fromTab = await fetchFromSourceTab(url);
  const result = fromTab.bytes ? fromTab : await fetchDirect(url);
  if (!result.bytes) {
    showNotice('err', explainFetchFailure(pickMostTelling(fromTab, result)));
    setStatus('讀取失敗');
    return;
  }
  try {
    await load(result.bytes, pdfName(url));
  } catch (err) {
    showNotice('err', `無法解析這個 PDF：${err.message}`);
    setStatus('讀取失敗');
  }
}

async function fetchFromSourceTab(url) {
  if (!sourceTabId || !chrome.tabs?.sendMessage) return { kind: 'no-source' };
  try {
    const r = await chrome.tabs.sendMessage(sourceTabId, { type: MSG.FETCH_PDF, payload: { url } });
    if (r?.base64) return { bytes: base64ToBytes(r.base64) };
    return r ?? { kind: 'no-source' };
  } catch {
    // 分頁已經關了，或那邊的 content script 失聯（擴充功能剛重新載入）
    return { kind: 'no-source' };
  }
}

async function fetchDirect(url) {
  let res;
  try {
    res = await fetch(url, { credentials: 'include' });
  } catch (e) {
    return { kind: 'network', error: String(e?.message || e) };
  }
  if (!res.ok) return { kind: 'http', status: res.status };
  const buf = await res.arrayBuffer();
  // 先驗再交給 PDF.js。伺服器回網頁的話 PDF.js 只會說「Invalid PDF structure」
  if (!isPdfBytes(buf)) return { kind: sniffNonPdf(buf) };
  return { bytes: new Uint8Array(buf) };
}

/** 兩條路都失敗時，挑最能說明狀況的那一個講給使用者聽。 */
function pickMostTelling(...fails) {
  const rank = { html: 0, xml: 0, json: 0, http: 1, empty: 2, 'too-large': 2, unknown: 3 };
  return fails
    .filter((f) => f && f.kind in rank)
    .sort((a, b) => rank[a.kind] - rank[b.kind])[0]
    ?? fails[fails.length - 1] ?? { kind: 'network' };
}

function explainFetchFailure(f) {
  const next = sourceTabId
    ? '\n\n請回到原本的分頁重新整理 PDF，再立刻點上面的鴨子開啟。'
    : '\n\n如果你在瀏覽器裡看得到這份 PDF，請直接點 PDF 上的鴨子開啟 —— '
      + 'ReadDuck 會沿用那個分頁已經載入的檔案。';
  switch (f.kind) {
    case 'html':
    case 'xml':
    case 'json':
      return '伺服器回傳的是網頁，不是 PDF。通常是登入頁、機器人驗證頁，或下載連結已經過期'
        + '（ScienceDirect 那類有簽章的下載網址只有幾分鐘效期）。' + next;
    case 'http':
      return (f.status === 401 || f.status === 403
        ? `伺服器拒絕了這個請求（HTTP ${f.status}）。這份 PDF 可能需要登入，或下載連結已經過期。`
        : `伺服器回應 HTTP ${f.status}。`) + next;
    case 'empty':
      return '伺服器回傳了空的內容。' + next;
    case 'too-large':
      return '這份 PDF 太大，無法從原本的分頁轉交過來。請下載後用上方的「開啟本機檔案」開啟。';
    default:
      return `讀不到這個網址（${f.error ?? '沒有回應'}）。\n`
        + '如果它是本機檔案，請改用上方的「開啟本機檔案」，或把檔案拖進這個視窗。';
  }
}

/** 標題用檔名，不要把一長串簽章參數也放進去。 */
function pdfName(url) {
  try {
    // 相對路徑也要能解析（本機測試與拖放以外的內部開啟都可能給相對網址）
    const last = new URL(url, location.href).pathname.split('/').pop();
    return decodeURIComponent(last) || 'PDF';
  } catch {
    return 'PDF';
  }
}

async function openFile(file) {
  setStatus('讀取中…');
  try {
    const buf = await file.arrayBuffer();
    if (!isPdfBytes(buf)) throw new Error('這個檔案不是 PDF');
    await load(buf, file.name);
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
  ocrQueue.clear();
  ocrController?.abort();
  ocrController = null;
  outlineReader?.destroy();
  outlineReader = null;
  rows.clear();
  stats = { total: 0, done: 0, reading: null };
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
  scheduleOutlines(page, row);
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

/**
 * 往外擴一點點：PDF 回報的字元寬度會有誤差，剛好貼齊的話原文的最後一個字
 * 會從覆蓋層右緣露出來。內距用同一個值抵銷，譯文的起點仍對齊原文的左緣。
 */
const PAD = 2;
/** 譯文最多縮到原字級的這個比例；再小就難以閱讀，寧可往下延伸 */
const MIN_SHRINK = 0.6;
/** 譯文可以往下借用的空白，最多這麼多行（相對行高）—— 再多就可能蓋到圖表 */
const BORROW_LINES = 2;

/** 依段落座標把譯文方塊擺回原文的位置。縮放後也要重跑一次。 */
function layoutOverlay(row) {
  const vp = row.cssViewport;
  if (!vp) return;
  const toBox = ({ x0, x1, yTop, yBottom }) => {
    const [left, top] = vp.convertToViewportPoint(x0, yTop);
    const [right, bottom] = vp.convertToViewportPoint(x1, yBottom);
    return {
      left: Math.min(left, right) - PAD, right: Math.max(left, right) + PAD,
      top: Math.min(top, bottom) - PAD, bottom: Math.max(top, bottom) + PAD,
    };
  };
  const boxes = row.slots.map((slot) => toBox(slot.bbox));
  const obstacles = (row.obstacles ?? []).map(toBox);

  row.slots.forEach((slot, i) => {
    const el = slot.ovEl;
    if (!el) return;
    const box = boxes[i];
    const size = slot.fontSize * vp.scale;
    // 行距照原文（基線到基線），用倍數寫，縮字級時行距跟著縮
    const ratio = slot.lineGap ? Math.min(Math.max(slot.lineGap / slot.fontSize, 1.05), 2.2) : 1.25;

    el.style.left = `${box.left}px`;
    el.style.top = `${box.top}px`;
    el.style.width = `${box.right - box.left}px`;
    el.style.minHeight = `${box.bottom - box.top}px`;
    el.style.padding = `${PAD}px`;
    el.style.lineHeight = String(ratio);
    el.style.textAlign = slot.align === 'justify' ? 'justify' : slot.align;
    // 首行縮排照原文；負值是懸掛縮排（條列符號、文獻編號），用左內距把其餘各行推回去
    const indent = (slot.indent ?? 0) * vp.scale;
    el.style.textIndent = `${indent}px`;
    el.style.paddingLeft = `${PAD + Math.max(0, -indent)}px`;

    slot.baseSize = size;
    slot.room = roomFor(box, [...boxes.filter((_, j) => j !== i), ...obstacles], vp.height, size * ratio * BORROW_LINES);
    el.style.fontSize = `${size}px`;
    if (slot.translated) fitText(slot);
  });
}

/**
 * 譯文最多能長到多高：原文的框，加上下方到下一塊文字之前的空白（有上限）。
 * 只看水平範圍有重疊的 —— 旁邊那一欄的段落擋不到這一段。
 */
function roomFor(box, others, pageHeight, borrow) {
  let limit = Math.min(pageHeight, box.bottom + borrow);
  for (const other of others) {
    if (other.top < box.top + 1) continue;
    if (other.left >= box.right || other.right <= box.left) continue;
    limit = Math.min(limit, other.top);
  }
  return Math.max(limit, box.bottom) - box.top;
}

/**
 * 譯文長度和原文不一樣。放得下就維持原字級；放不下先借用下方的空白，
 * 還是不夠才縮字（二分搜尋找放得下的最大字級）。縮到下限仍放不下就讓它
 * 往下溢出 —— 蓋住一點下一段總比截斷內容好。
 */
function fitText(slot) {
  const el = slot.ovEl;
  const base = slot.baseSize || parseFloat(el.style.fontSize) || 12;
  const fits = (size) => {
    el.style.fontSize = `${size}px`;
    return el.scrollHeight <= slot.room + 1;
  };
  if (fits(base)) return;
  let lo = base * MIN_SHRINK;
  let hi = base;
  if (!fits(lo)) return;
  for (let step = 0; step < 7; step++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid; else hi = mid;
  }
  fits(lo);
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

/** 段落框在畫布上的範圍（CSS 像素）。 */
function cssRect(row, bbox) {
  const vp = row.cssViewport;
  const [left, top] = vp.convertToViewportPoint(bbox.x0, bbox.yTop);
  const [right, bottom] = vp.convertToViewportPoint(bbox.x1, bbox.yBottom);
  return { x0: Math.min(left, right), x1: Math.max(left, right), y0: Math.min(top, bottom), y1: Math.max(top, bottom) };
}

const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;

/**
 * 取樣段落四周一圈的顏色當作覆蓋層底色。
 * 一律用白色的話，深色底的 PDF 會出現一塊白斑。取出現最多的顏色而不是平均：
 * 表格的格線、隔壁格子的字只佔少數，平均會把它們混進來，變成一塊灰。
 * 取樣的圈要有兩層：格子的上下緣常常剛好貼著表格的粗格線，只看一層的話，
 * 上下兩排全落在黑線上，出現最多的就變成黑色。
 * @returns {number[]|null} [r, g, b]
 */
function sampleBackground(row, bbox, pixels) {
  if (!pixels) return null;
  const dpr = row.dpr ?? 1;
  const { x0, x1, y0, y1 } = cssRect(row, bbox);
  const points = [];
  for (const d of [3, 7]) {
    for (let i = 0; i <= 10; i++) {
      const x = x0 + ((x1 - x0) * i) / 10;
      points.push([x, y0 - d], [x, y1 + d]);
    }
    for (let i = 0; i <= 4; i++) {
      const y = y0 + ((y1 - y0) * i) / 4;
      points.push([x0 - d, y], [x1 + d, y]);
    }
  }

  const groups = new Map();
  for (const [x, y] of points) {
    const dx = Math.round(x * dpr);
    const dy = Math.round(y * dpr);
    if (dx < 0 || dy < 0 || dx >= pixels.width || dy >= pixels.height) continue;
    const at = (dy * pixels.width + dx) * 4;
    const c = [pixels.data[at], pixels.data[at + 1], pixels.data[at + 2]];
    const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  if (!groups.size) return null;
  const common = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  return [0, 1, 2].map((k) => Math.round(common.reduce((sum, c) => sum + c[k], 0) / common.length));
}

/**
 * 取樣原文的字色：段落框裡離底色最遠的那些像素。
 * 論文的正文常是深灰（The Lancet 是 #231f20）、標題是品牌色、色塊上是白字 ——
 * 一律用黑色，譯文就和原文不像同一份文件。
 * 反鋸齒讓筆畫邊緣是混色，所以只取最深的兩成再取中位數。
 * @returns {number[]|null} [r, g, b]
 */
function sampleInk(row, bbox, pixels, bg) {
  if (!pixels || !bg) return null;
  const dpr = row.dpr ?? 1;
  const r = cssRect(row, bbox);
  const x0 = Math.max(0, Math.round(r.x0 * dpr)), x1 = Math.min(pixels.width, Math.round(r.x1 * dpr));
  const y0 = Math.max(0, Math.round(r.y0 * dpr)), y1 = Math.min(pixels.height, Math.round(r.y1 * dpr));
  const stepX = Math.max(1, Math.floor((x1 - x0) / 80));
  const stepY = Math.max(1, Math.floor((y1 - y0) / 40));

  const ink = [];
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const at = (y * pixels.width + x) * 4;
      const c = [pixels.data[at], pixels.data[at + 1], pixels.data[at + 2]];
      const d = Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]);
      if (d > 90) ink.push([d, ...c]);
    }
  }
  if (ink.length < 5) return null;
  ink.sort((a, b) => b[0] - a[0]);
  const darkest = ink.slice(0, Math.max(5, Math.ceil(ink.length * 0.2)));
  const mid = (k) => darkest.map((p) => p[k]).sort((a, b) => a - b)[darkest.length >> 1];
  return [mid(1), mid(2), mid(3)];
}

/**
 * 原文的字型：襯線或無襯線、粗細。
 *
 * 內嵌字型的字形只涵蓋原文用到的字，拿來顯示譯文沒有用，所以只取它的「樣子」，
 * 交給瀏覽器依譯文語言挑對應的系統字型（覆蓋層掛了 lang，中文才不會用到
 * 日文字形）。粗細看字型名稱與 PDF.js 的旗標；襯線看 PDF.js 依字型描述判斷
 * 出來的 fallback 名稱。
 */
function typeface(page, styles, fontName) {
  const family = styles?.[fontName]?.fontFamily ?? '';
  let font = null;
  try {
    // 字型在畫頁面時就載入了；還沒載入時 get() 會丟例外
    if (fontName && page.commonObjs.has(fontName)) font = page.commonObjs.get(fontName);
  } catch { /* 拿不到就用預設 */ }
  const name = (font?.name ?? '').replace(/^[A-Z]{6}\+/, '');   // 去掉子集前綴 ABCDEF+
  const weight = (font?.black || /black|heavy/i.test(name)) ? 800
    : (font?.bold || /bold/i.test(name)) ? 700
      : /semibold|demi/i.test(name) ? 600 : 400;
  return { family: genericFamily(name, family), weight };
}

/**
 * 襯線與否先看字型名稱，認不出來才用 PDF.js 的判斷。PDF.js 只認得標準字型的
 * 名稱與字型描述裡的旗標，IEEE 的 TimesLTStd 就被它當成無襯線。
 * 先比對無襯線，因為「Sans Serif」這種名稱兩個字都有。
 */
function genericFamily(name, pdfjsFamily) {
  if (/mono|courier|consol|menlo/i.test(name)) return 'monospace';
  if (SANS_FONTS.test(name)) return 'sans-serif';
  if (SERIF_FONTS.test(name)) return 'serif';
  if (/mono/i.test(pdfjsFamily)) return 'monospace';
  return /serif/i.test(pdfjsFamily) && !/sans/i.test(pdfjsFamily) ? 'serif' : 'sans-serif';
}
const SANS_FONTS = /sans|arial|helvetica|gothic|formata|frutiger|myriad|calibri|verdana|segoe|roboto|lato|univers|futura|gill|shaker|hei|dotum|gulim/i;
const SERIF_FONTS = /serif|times|georgia|garamond|minion|palatino|cambria|baskerville|caslon|century|scala|charter|utopia|cmr|lmroman|stix|mincho|song|ming|batang/i;

/* ---------------------------------------------------------- 翻譯 */

async function translatePage(page, row) {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const all = groupParagraphs(content.items, viewport.width);
  const paragraphs = all.filter((p) => p.text.trim().length >= settings.minTextLength && isTranslatable(p.text));
  // 辨識畫成圖形的文字時要用到：哪裡已經是真正的文字、這一頁的字型長什麼樣
  row.styles = content.styles;
  row.textBoxes = textBoxesOf(content.items);
  row.mainFont = dominantFont(all);
  // 不翻的文字（公式、表格裡的數字）仍然在頁面上，譯文往下借空白時不能蓋住它們
  row.obstacles = all.filter((p) => !paragraphs.includes(p)).map((p) => p.bbox);

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
  // 讓瀏覽器挑對的字形：同一個漢字，繁中、簡中、日文的標準字形不一樣
  row.overlay.lang = settings.targetLanguage;

  const slots = createSlots(row, page, paragraphs);
  row.slots = slots;
  layoutOverlay(row);
  await translateSlots(row, slots);
}

/**
 * 每個段落一個譯文方塊：底色、字色從畫布取樣，字型照原文。
 * 畫成圖形的文字沒有字型資訊，用這一頁正文的字型（fallbackFont）。
 */
function createSlots(row, page, paragraphs, fallbackFont) {
  // 整頁像素只讀一次，取樣完就讓它被回收
  const pixels = readPagePixels(row);

  return paragraphs.map((p) => {
    const ovEl = document.createElement('div');
    ovEl.className = 'ov pending';
    ovEl.title = p.text;      // 滑鼠停留可看原文
    row.overlay.appendChild(ovEl);

    const bg = sampleBackground(row, p.bbox, pixels);
    if (bg) ovEl.style.background = rgb(bg);
    const ink = sampleInk(row, p.bbox, pixels, bg);
    if (ink) ovEl.style.color = rgb(ink);
    const face = typeface(page, row.styles, p.fontName ?? fallbackFont);
    ovEl.style.fontFamily = face.family;
    ovEl.style.fontWeight = String(face.weight);

    return {
      text: p.text, bbox: p.bbox, fontSize: p.fontSize,
      lineGap: p.lineGap, align: p.align, indent: p.indent,
      ovEl, translated: null,
    };
  });
}

/** 翻譯這些方塊：先查快取，其餘排進佇列。 */
async function translateSlots(row, slots) {
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

/* ---------------------------------------------------- 畫成圖形的文字 */

function scheduleOutlines(page, row) {
  if (ocrStopped) return;
  ocrQueue.add(() => readOutlines(page, row), { priority: row.pageNumber })
    .catch((err) => {
      if (isAbort(err) || err?.name === 'AbortError') return;
      if (isModelCrashError(err)) {
        // 整份文件停手：一頁一頁各試一次，很快就會把瀏覽器的崩潰額度用光，
        // 連其他 AI 功能一起被停用
        ocrStopped = true;
        ocrQueue.clear();
        showNotice('err', explainModelError(err));
        return;
      }
      console.warn('[ReadDuck] 圖形文字辨識失敗', err);
    });
}

/**
 * 找出這一頁畫成圖形的文字，辨識、併回段落、疊上譯文。
 *
 * 有些出版商（IEEE Access 的表格）把字轉成外框再畫：畫面上是字，PDF 裡卻沒有
 * 文字，PDF.js 抽不出來。這些字只能用看的 —— 交給裝置端語言模型辨識。
 */
async function readOutlines(page, row) {
  if (ocrStopped || !doc) return;
  const boxes = filledPathBoxes(await page.getOperatorList(), pdfjsLib.OPS);
  const segments = outlineSegments(boxes, row.textBoxes ?? []);
  if (!segments.length) return;

  // 外框字不管有沒有辨識都在頁面上：其他譯文往下借空白時不能蓋住它們
  row.obstacles = [...(row.obstacles ?? []), ...segments.map((s) => ({
    x0: s.x0, x1: s.x1, yTop: s.y1, yBottom: s.y0,
  }))];
  layoutOverlay(row);

  const wanted = segments.filter(worthReading);
  if (wanted.length < MIN_OUTLINE_LINES) return;
  if (!sourceLanguage || sameLanguage(sourceLanguage, settings.targetLanguage)) return;

  outlineReader ??= new OutlineReader({
    customPrompts: settings.customPrompts,
    askConsent: askOutlineConsent,
    onDownloadProgress: (loaded) => setStatus(`下載語言模型… ${Math.round(loaded * 100)}%`),
  });
  if (await outlineReader.availability(sourceLanguage) === 'unavailable') {
    warnOnce('outline-unavailable', () => showNotice('warn',
      `第 ${row.pageNumber} 頁有些文字畫成了圖形（例如表格），PDF 裡沒有文字可抽。`
      + '辨識它們需要能讀圖片的裝置端語言模型，這個瀏覽器目前沒有，所以那些地方不會翻譯。'));
    return;
  }

  const texts = await outlineTexts(page, row, wanted);
  if (!texts?.size) return;
  const blocks = groupOutlineBlocks([...texts].map(([seg, text]) => ({ seg, text })), segments)
    .filter((b) => b.text.length >= settings.minTextLength && isTranslatable(b.text));
  if (!blocks.length) return;

  row.overlay.lang = settings.targetLanguage;
  const slots = createSlots(row, page, blocks, row.mainFont);
  row.slots.push(...slots);
  layoutOverlay(row);
  await translateSlots(row, slots);
}

/** 辨識結果先查快取：同一份文件再開一次不必重新辨識。沒有的才送模型。 */
async function outlineTexts(page, row, segments) {
  const fingerprint = doc.fingerprints?.[0] ?? sourceUrl ?? '';
  const keys = segments.map((s) => cacheKey(
    `${fingerprint}|${row.pageNumber}|${[s.x0, s.y0, s.x1, s.y1].map(Math.round).join(',')}`, 'outline', 'ocr-v1'));
  const hits = settings.cacheEnabled ? (await send(MSG.CACHE_GET, { keys }) ?? {}) : {};
  const texts = new Map();
  const todo = [];
  segments.forEach((s, i) => {
    if (hits[keys[i]]) texts.set(s, hits[keys[i]]);
    else todo.push(s);
  });
  if (!todo.length) return texts;

  ocrController ??= new AbortController();
  stats.reading = row.pageNumber;
  updateStatus();
  try {
    const read = await outlineReader.read(page, todo, sourceLanguage, { signal: ocrController.signal });
    if (!read) return texts;   // 使用者不下載模型
    const entries = [];
    for (const [s, text] of read) {
      texts.set(s, text);
      entries.push({ k: keys[segments.indexOf(s)], v: text });
    }
    if (entries.length && settings.cacheEnabled) send(MSG.CACHE_PUT, { entries });
    return texts;
  } finally {
    stats.reading = null;
    updateStatus();
  }
}

/**
 * 模型還沒下載時先問過使用者（數 GB，硬限制 #3）。按鈕本身就是使用者手勢，
 * 開始下載需要它。
 */
function askOutlineConsent() {
  return new Promise((resolve) => {
    ui.showToast('這份 PDF 有些文字畫成了圖形（例如表格），要用裝置端語言模型辨識才能翻譯。'
      + '模型有數 GB，只需下載一次。', {
      timeout: 0,
      actions: [
        { label: '下載模型並辨識', onClick: (t) => { t.close(); resolve(true); } },
        { label: '不用了', onClick: (t) => { t.close(); resolve(false); } },
      ],
    });
  });
}

/** 真正文字的範圍（PDF 座標）。外框和它們重疊的不是畫成圖形的字。 */
function textBoxesOf(items) {
  return items.filter((it) => it.str?.trim()).map((it) => {
    const t = it.transform ?? [1, 0, 0, 1, 0, 0];
    const h = it.height || Math.abs(t[3]) || 10;
    return { x0: t[4], x1: t[4] + (it.width ?? 0), y0: t[5] - h * 0.25, y1: t[5] + h };
  });
}

/** 這一頁正文用得最多的字型。 */
function dominantFont(paragraphs) {
  const weight = new Map();
  for (const p of paragraphs) weight.set(p.fontName, (weight.get(p.fontName) ?? 0) + p.text.length);
  return [...weight.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
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
  // 左右對照時右邊那份也是看得到的；只有被隱藏時量不到尺寸，切換模式時會再排一次
  if (slot.ovEl.offsetParent) fitText(slot);
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
  if (stats.reading) parts.push(`辨識第 ${stats.reading} 頁畫成圖形的文字…`);
  setStatus(parts.join(' · '));
}

function showNotice(kind, text) {
  const el = $('notice');
  el.className = `notice ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

function hideNotice() { $('notice').hidden = true; }
