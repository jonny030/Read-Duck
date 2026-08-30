/**
 * 把 PDF.js 抽出來的文字片段組回段落。
 *
 * PDF 檔案裡沒有「段落」這種東西 —— 只有一堆帶座標的文字片段。要翻譯就得先
 * 還原出段落，否則會變成一行一行分開送去翻，語意會斷掉、品質很差。
 *
 * 這支檔案刻意寫成純函式（輸入是普通物件，不碰 DOM 也不碰 PDF.js），
 * 才能在 node 裡直接測。
 */

/** 同一行的基線容許誤差，相對於文字高度 */
const LINE_TOLERANCE = 0.5;
/** 行距超過中位數的這個倍數就視為換段 */
const PARAGRAPH_GAP_RATIO = 1.55;
/** 縮排超過這個比例（相對欄寬）視為新段落 */
const INDENT_RATIO = 0.02;
/** 上一行明顯沒寫滿、又以句號結尾，視為段落結束 */
const SHORT_LINE_RATIO = 0.85;

const SENTENCE_END = /[.!?\u3002\uff01\uff1f\uff1a:\uff1b;]["'\u2019\u201d)\]]?$/;
const CJK = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const HYPHEN_END = /[\u2010-\u2014-]$/;

/**
 * @param {Array<{str:string, transform:number[], width:number, height:number}>} rawItems
 * @param {number} pageWidth viewport 寬度（PDF 使用者座標）
 * @returns {Array<{ text, column, bbox, fontSize }>} 依閱讀順序排列的段落
 *   bbox 是 PDF 使用者座標（原點左下、y 軸向上）：{ x0, x1, yTop, yBottom }
 *   譯文要疊回原文位置就需要它。
 */
export function groupParagraphs(rawItems, pageWidth) {
  const items = normalizeItems(rawItems);
  if (!items.length) return [];

  const paragraphs = [];
  for (const region of layoutRegions(items, pageWidth)) {
    const lines = buildLines(region.items);
    for (const paragraph of mergeLines(lines)) {
      paragraphs.push({ ...paragraph, column: region.column });
    }
  }
  return paragraphs;
}

function normalizeItems(rawItems) {
  const out = [];
  for (const it of rawItems ?? []) {
    const str = it.str ?? '';
    if (!str.trim()) continue;
    const t = it.transform ?? [1, 0, 0, 1, 0, 0];
    const height = it.height || Math.abs(t[3]) || 10;
    out.push({
      text: str,
      x: t[4],
      y: t[5],          // PDF 座標原點在左下，y 越大越靠上
      w: it.width ?? 0,
      h: height,
    });
  }
  return out;
}

/**
 * 版面分析：把一頁拆成依閱讀順序排列的區塊。
 *
 * 論文的雙欄版面幾乎一定會有跨欄的元素 —— 標題、作者、摘要、寬圖說、頁尾。
 * 先前的做法要求「完全沒有東西橫跨中線」才認定為雙欄，只要有一個標題就整個
 * 失效，退回單欄處理，左右兩欄同高度的文字就會被當成同一行併在一起。
 *
 * 改成：
 *   1. 找出中間那條「大部分列都沒有東西跨過」的空白槽（標題只跨過少數幾列，
 *      不會把它蓋掉）
 *   2. 把項目分成跨欄 / 左欄 / 右欄
 *   3. 用跨欄區塊把頁面切成幾條橫帶
 *   4. 由上而下輸出：跨欄區塊 → 該橫帶的左欄 → 右欄 → 下一個跨欄區塊 …
 *
 * @returns {Array<{ items: Array, column: number }>} 依閱讀順序排列
 */
function layoutRegions(items, pageWidth) {
  const gutter = findGutter(items, pageWidth);
  if (gutter == null) return [{ items, column: 0 }];

  const spanning = [], left = [], right = [];
  for (const it of items) {
    if (it.x < gutter && it.x + it.w > gutter) spanning.push(it);
    else if (it.x + it.w <= gutter) left.push(it);
    else right.push(it);
  }

  // 兩側都要有足夠的量才算真的分欄，否則可能只是一張置中的圖
  const minSide = Math.max(4, Math.floor(items.length * 0.15));
  if (left.length < minSide || right.length < minSide) return [{ items, column: 0 }];

  const lineHeight = median(items.map((i) => i.h)) || 10;
  const bands = clusterSpanning(spanning, lineHeight * 1.8);

  const regions = [];
  let ceiling = Infinity;
  for (const band of bands) {
    pushColumns(regions, left, right, band.top, ceiling);
    regions.push({ items: band.items, column: 0 });
    ceiling = band.bottom;
  }
  pushColumns(regions, left, right, -Infinity, ceiling);

  return regions.filter((r) => r.items.length);
}

/** 取出落在某個垂直區間內的左右欄項目，左欄先、右欄後。 */
function pushColumns(regions, left, right, lowY, highY) {
  const within = (arr) => arr.filter((it) => it.y < highY && it.y >= lowY);
  const l = within(left);
  const r = within(right);
  if (l.length) regions.push({ items: l, column: 0 });
  if (r.length) regions.push({ items: r, column: 1 });
}

/** 把跨欄項目依垂直距離聚成幾個橫幅（標題和頁尾各自成一塊）。 */
function clusterSpanning(items, gap) {
  const sorted = [...items].sort((a, b) => b.y - a.y);
  const clusters = [];
  let current = null;

  for (const it of sorted) {
    if (current && current.bottom - it.y <= gap) {
      current.items.push(it);
      current.top = Math.max(current.top, it.y + it.h);
      current.bottom = Math.min(current.bottom, it.y);
    } else {
      current = { items: [it], top: it.y + it.h, bottom: it.y };
      clusters.push(current);
    }
  }
  return clusters;
}

/**
 * 找出中間的欄間空白槽。
 *
 * 關鍵在於「以列為單位計票」而不是「只要有一個項目跨過就否決」：跨欄標題
 * 只會跨過少數幾列，真正的欄間空白在絕大多數列上都是空的。
 *
 * @returns {number|null} 空白槽的中心 x，找不到就回 null（視為單欄）
 */
function findGutter(items, pageWidth) {
  if (items.length < 16 || !pageWidth) return null;

  const rowHeight = (median(items.map((i) => i.h)) || 10) * 1.2;
  const rows = new Map();
  for (const it of items) {
    const key = Math.round(it.y / rowHeight);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(it);
  }
  const rowList = [...rows.values()];
  if (rowList.length < 6) return null;

  const SAMPLES = 80;
  const lo = pageWidth * 0.3;
  const hi = pageWidth * 0.7;
  const allowed = Math.max(1, Math.floor(rowList.length * 0.25));

  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const x = lo + ((hi - lo) * i) / (SAMPLES - 1);
    let crossing = 0;
    for (const row of rowList) {
      if (row.some((it) => it.x < x && it.x + it.w > x)) crossing++;
    }
    samples.push({ x, crossing });
  }

  // 取最寬的一段「跨越列數夠少」的區間
  let best = null;
  let start = null;
  for (let i = 0; i <= samples.length; i++) {
    const clear = i < samples.length && samples[i].crossing <= allowed;
    if (clear && start === null) start = i;
    if (!clear && start !== null) {
      const from = samples[start].x;
      const to = samples[i - 1].x;
      if (!best || to - from > best.width) best = { width: to - from, center: (from + to) / 2 };
      start = null;
    }
  }

  if (!best || best.width < pageWidth * 0.015) return null;
  return best.center;
}

/** 把文字片段依基線併成一行。 */
function buildLines(items) {
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  let current = null;

  for (const it of sorted) {
    const tolerance = it.h * LINE_TOLERANCE;
    if (current && Math.abs(current.y - it.y) <= tolerance) {
      current.items.push(it);
    } else {
      current = { y: it.y, items: [it] };
      lines.push(current);
    }
  }

  return lines.map((line) => {
    const parts = [...line.items].sort((a, b) => a.x - b.x);
    return {
      y: line.y,
      x0: Math.min(...parts.map((p) => p.x)),
      x1: Math.max(...parts.map((p) => p.x + p.w)),
      h: median(parts.map((p) => p.h)),
      text: joinPieces(parts),
    };
  }).filter((line) => line.text.trim());
}

/**
 * 同一行內的片段之間要不要補空白：PDF 常常把一個單字拆成好幾段，
 * 靠水平間距判斷比一律補空白準得多。
 */
function joinPieces(parts) {
  let out = '';
  let prev = null;
  for (const p of parts) {
    if (prev) {
      const gap = p.x - (prev.x + prev.w);
      const needsSpace = gap > prev.h * 0.18
        && !/\s$/.test(out)
        && !CJK.test(out.slice(-1))
        && !CJK.test(p.text[0]);
      if (needsSpace) out += ' ';
    }
    out += p.text;
    prev = p;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** 把行併成段落。 */
function mergeLines(lines) {
  if (!lines.length) return [];

  const gaps = [];
  for (let i = 1; i < lines.length; i++) gaps.push(lines[i - 1].y - lines[i].y);
  const typicalGap = median(gaps.filter((g) => g > 0)) || median(lines.map((l) => l.h)) || 12;
  const columnWidth = Math.max(...lines.map((l) => l.x1)) - Math.min(...lines.map((l) => l.x0));

  const paragraphs = [];
  let buffer = [];

  const flush = () => {
    if (buffer.length) {
      const text = joinLines(buffer);
      if (text) paragraphs.push({ text, bbox: boundsOf(buffer), fontSize: median(buffer.map((l) => l.h)) });
    }
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines[i - 1];

    if (prev && buffer.length) {
      const gap = prev.y - line.y;
      const paragraphLeft = Math.min(...buffer.map((l) => l.x0));
      const indented = columnWidth > 0 && line.x0 - paragraphLeft > columnWidth * INDENT_RATIO;
      const prevEndedSentence = SENTENCE_END.test(prev.text)
        && columnWidth > 0
        && (prev.x1 - prev.x0) < columnWidth * SHORT_LINE_RATIO;

      if (gap > typicalGap * PARAGRAPH_GAP_RATIO || indented || prevEndedSentence) flush();
    }
    buffer.push(line);
  }
  flush();

  return paragraphs;
}

/**
 * 段落的外框。
 *
 * line.y 是基線，不是文字頂端 —— 直接拿它當上緣會把整段往下偏一行。
 * 這裡用常見的比例往上補 ascent、往下補 descender。
 */
function boundsOf(lines) {
  return {
    x0: Math.min(...lines.map((l) => l.x0)),
    x1: Math.max(...lines.map((l) => l.x1)),
    yTop: Math.max(...lines.map((l) => l.y + l.h * 0.8)),
    yBottom: Math.min(...lines.map((l) => l.y - l.h * 0.25)),
  };
}

/** 接行時處理連字號斷字，以及中日韓不加空白。 */
function joinLines(lines) {
  let out = '';
  for (const line of lines) {
    const text = line.text.trim();
    if (!out) { out = text; continue; }

    if (HYPHEN_END.test(out) && /^[a-z]/.test(text)) {
      // 行尾連字號斷字：去掉連字號直接接起來
      out = out.replace(HYPHEN_END, '') + text;
    } else if (CJK.test(out.slice(-1)) && CJK.test(text[0])) {
      out += text;
    } else {
      out += ' ' + text;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

function median(values) {
  const v = values.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return 0;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
