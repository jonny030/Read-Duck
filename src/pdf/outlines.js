/**
 * 畫成圖形的文字。
 *
 * 有些出版商把字轉成向量外框再畫出來（IEEE Access 的表格就是）：畫面上是字，
 * PDF 裡卻沒有任何文字 —— PDF.js 抽不出來，Translator 也就拿不到東西翻。
 *
 * 這支檔案從 PDF.js 的 operator list 找出這些外框，整理成一行一行的線段；
 * 檢視器再把線段畫成圖、交給裝置端模型辨識（見 pdf-viewer.js 的 readOutlines）。
 * 刻意寫成純函式，輸入是 operator list 與普通物件，才能在 node 直接測。
 */

const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** 比這個還扁（pt）的填色是格線，不是字 */
const MIN_GLYPH_HEIGHT = 1;
/** 比一般字高小這麼多倍的是標點、雜點；大這麼多倍的是圖形 */
const MIN_GLYPH_RATIO = 0.3;
const MAX_GLYPH_RATIO = 2.5;
/**
 * 字的外框很「密」：每 pt 寬少說有好幾個路徑指令（曲線、折線），箭頭、圖上的
 * 線條只有寥寥幾個。每 pt 不到這麼多指令的就不是字
 */
const MIN_OPS_PER_PT = 1;
/** 同一行裡，片段之間的空隙在字高的這個倍數以內就是同一段；表格的欄距遠大於它 */
const SEGMENT_GAP_RATIO = 1;
/**
 * 至少要有字高這麼多倍寬才值得辨識。只有兩三個字元的多半是表格裡的數字或圖上
 * 的標籤 —— 翻不出東西，卻一樣要花模型的時間
 */
export const WORDY_RATIO = 2.5;

/**
 * 找出所有填色的路徑，換算成頁面座標（PDF 使用者座標，原點左下、y 向上）。
 *
 * operator list 裡的座標是「畫的當下」的區域座標，外框字通常每個字（或每個詞）
 * 各包在一組 save / transform / restore 裡，所以要一路追蹤變換矩陣。
 *
 * @param {{ fnArray: number[], argsArray: any[] }} opList page.getOperatorList() 的結果
 * @param {object} OPS pdfjsLib.OPS
 * @returns {Array<{ x0, y0, x1, y1, ops: number, rectOnly: boolean }>}
 */
export function filledPathBoxes({ fnArray, argsArray }, OPS) {
  const fills = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const ends = new Set([OPS.stroke, OPS.closeStroke, OPS.endPath]);
  let ctm = IDENTITY;
  const stack = [];
  let path = null;
  const boxes = [];

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args?.[0]) ctm = multiply(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? IDENTITY;
    else if (fn === OPS.constructPath) {
      const [ops, , minMax] = args;
      path = minMax && minMax.every(Number.isFinite)
        // 只由矩形組成的路徑是表格的格線與底色塊，字的外框一定有曲線或折線
        ? { ...transformBox(ctm, minMax), ops: ops.length, rectOnly: [...ops].every((op) => op === OPS.rectangle) }
        : null;
    } else if (fills.has(fn)) {
      if (path) boxes.push(path);
      path = null;
    } else if (ends.has(fn)) {
      path = null;
    }
  }
  return boxes;
}

/** 兩個變換相接：先 inner、再 outer（PDF 的 cm 就是這樣疊上去的）。 */
function multiply(outer, inner) {
  const [a, b, c, d, e, f] = outer;
  const [p, q, r, s, t, u] = inner;
  return [a * p + c * q, b * p + d * q, a * r + c * s, b * r + d * s, a * t + c * u + e, b * t + d * u + f];
}

function transformBox(m, [x0, y0, x1, y1]) {
  const pts = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
    .map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/**
 * 從填色路徑挑出「字」，併成一行一行的線段。
 *
 * - 只有矩形的路徑是格線與底色塊；太扁的是格線；比一般字高大很多的是圖形；
 *   路徑指令稀疏的是箭頭與線條（字的外框全是曲線，指令很密）
 * - 和真正的文字重疊的略過（有些 PDF 在文字底下畫底線、反白）
 * - 同一行、空隙在字距以內的併成一段。有的 PDF 一個字一個路徑，有的一個詞、
 *   甚至一整行一個路徑，併完都一樣；表格的欄與欄之間空隙大，會切開
 *
 * @param {Array} boxes filledPathBoxes() 的結果
 * @param {Array<{ x0, y0, x1, y1 }>} textBoxes 這一頁真正文字的範圍
 * @returns {Array<{ x0, y0, x1, y1, h }>} 由上而下、由左而右
 */
export function outlineSegments(boxes, textBoxes = []) {
  const shapes = boxes.filter((b) => !b.rectOnly && b.y1 - b.y0 >= MIN_GLYPH_HEIGHT
    && (b.ops == null || b.ops / Math.max(b.x1 - b.x0, 1) >= MIN_OPS_PER_PT));
  if (!shapes.length) return [];
  const typical = median(shapes.map((b) => b.y1 - b.y0));
  const glyphs = shapes.filter((b) => {
    const h = b.y1 - b.y0;
    return h >= typical * MIN_GLYPH_RATIO && h <= typical * MAX_GLYPH_RATIO
      && !textBoxes.some((t) => overlaps(t, b));
  });

  // 以垂直中心分行：有下伸部的字（p、g）底部比較低，但中心差不多
  const rows = [];
  for (const g of [...glyphs].sort((a, b) => (b.y1 + b.y0) - (a.y1 + a.y0))) {
    const center = (g.y0 + g.y1) / 2;
    const h = g.y1 - g.y0;
    const row = rows.find((r) => Math.abs(r.center - center) <= Math.max(r.h, h) * 0.35);
    if (row) row.glyphs.push(g);
    else rows.push({ center, h, glyphs: [g] });
  }

  const segments = [];
  for (const row of rows) {
    let seg = null;
    for (const g of row.glyphs.sort((a, b) => a.x0 - b.x0)) {
      const h = Math.max(row.h, g.y1 - g.y0);
      if (seg && g.x0 - seg.x1 <= h * SEGMENT_GAP_RATIO) {
        seg.x1 = Math.max(seg.x1, g.x1);
        seg.y0 = Math.min(seg.y0, g.y0);
        seg.y1 = Math.max(seg.y1, g.y1);
        seg.heights.push(g.y1 - g.y0);
      } else {
        seg = { x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1, heights: [g.y1 - g.y0] };
        segments.push(seg);
      }
    }
  }
  return segments
    .map(({ heights, ...s }) => ({ ...s, h: Math.max(...heights) }))
    .sort((a, b) => (b.y1 - a.y1) || (a.x0 - b.x0));
}

/** 值不值得送去辨識。 */
export const worthReading = (seg) => seg.x1 - seg.x0 >= seg.h * WORDY_RATIO;

function overlaps(a, b) {
  return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

/**
 * 把要辨識的每一行排進幾張拼貼圖。
 *
 * 一行一次模型呼叫太慢（一張表格就有上百行），整張表格一次送進去，模型又只看得到
 * 768×768 —— 小字會被縮糊，而且它給不出每一行的位置。所以把每一行裁下來、由上而下
 * 疊在一張圖裡，左邊由我們自己印上編號 [1]、[2]…，請模型照編號逐行轉錄：一次呼叫
 * 讀很多行，回來的每一行也知道對應哪一段。
 *
 * @param {Array<{ w, h }>} sizes 每一行裁下來的大小（像素）
 * @returns {Array<{ width, height, rows: Array<{ index, x, y, w, h }> }>}
 */
export function planComposites(sizes, { edge = 768, label = 56, gap = 12, maxRows = 20 } = {}) {
  const sheets = [];
  let sheet = null;
  sizes.forEach((size, index) => {
    const fit = Math.min(1, (edge - label) / size.w, (edge - gap) / size.h);
    const w = size.w * fit;
    const h = size.h * fit;
    if (!sheet || sheet.height + h + gap > edge || sheet.rows.length >= maxRows) {
      sheet = { width: label, height: gap / 2, rows: [] };
      sheets.push(sheet);
    }
    sheet.rows.push({ index, x: label, y: sheet.height, w, h });
    sheet.height += h + gap;
    sheet.width = Math.max(sheet.width, label + w);
  });
  for (const s of sheets) {
    s.width = Math.ceil(s.width);
    s.height = Math.min(edge, Math.ceil(s.height));
  }
  return sheets;
}

/**
 * 解析模型的逐行轉錄：「[3] text」。模型偶爾把一行折成兩行，沒有編號的行接回前一行。
 * @returns {Map<number, string>} 編號 → 文字（沒讀出字的不列入）
 */
export function parseTranscript(text) {
  const out = new Map();
  let current = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\[(\d+)\]\s*:?\s*(.*)$/);
    if (m) {
      current = Number(m[1]);
      out.set(current, m[2].trim());
    } else if (current != null && line && line !== 'NO_TEXT') {
      out.set(current, `${out.get(current)} ${line}`.trim());
    }
  }
  for (const [k, v] of out) if (!v) out.delete(k);
  return out;
}

const SENTENCE_END = /[.!?。！？]["'’”)\]]?$/;
const CJK = /[　-鿿豈-﫿＀-￯]/;

/**
 * 把辨識出來的每一行併回段落（表格的一格、一段說明）。
 *
 * 表格的格子常常折成兩三行，一行一行翻會把句子切斷。但表格的列距和格子內的行距
 * 一樣，光看位置分不出「下一列」和「同一格的下一行」。所以另外看兩件事：
 *   - 同一條基線上、別的欄有沒有短短的東西（符號表的符號、參數表的數值）——
 *     新的一列從那裡開始，續行旁邊是空的
 *   - 文字：上一行沒有結束句子、下一行不是大寫開頭（小寫、括號、數字…）才是續行。
 *     表格裡新的一列幾乎都從大寫開始（The critical…、Charging…）
 * 位置上還要在同一欄、緊接在下面。
 *
 * @param {Array<{ seg, text }>} lines
 * @param {Array} anchors 這一頁所有的外框線段（包括沒有辨識的短線段）
 * @returns {Array<{ text, bbox, fontSize, lineGap, align, indent }>}
 */
export function groupOutlineBlocks(lines, anchors = []) {
  // 只有短的算數：雙欄正文旁邊是另一欄一整行的字，那不代表這裡換了一列
  const short = anchors.filter((a) => !worthReading(a));
  const rowStart = (seg) => short.some((a) => (a.x1 <= seg.x0 || a.x0 >= seg.x1)
    && Math.abs((a.y0 + a.y1) / 2 - (seg.y0 + seg.y1) / 2) <= Math.max(a.h, seg.h) * 0.35);

  const blocks = [];
  const sorted = [...lines].sort((a, b) => (b.seg.y1 - a.seg.y1) || (a.seg.x0 - b.seg.x0));
  for (const line of sorted) {
    const block = !rowStart(line.seg) && blocks.find((b) => continues(b.lines[b.lines.length - 1], line));
    if (block) block.lines.push(line);
    else blocks.push({ lines: [line] });
  }
  return blocks.map(({ lines: ls }) => describe(ls));
}

function continues(prev, next) {
  const a = prev.seg;
  const b = next.seg;
  const h = Math.max(a.h, b.h);
  const gap = a.y0 - b.y1;                          // 上一行底部到這一行頂部
  if (gap < -h * 0.3 || gap > h * 0.9) return false;
  const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  if (overlap < Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.3) return false;
  const tail = prev.text.trim();
  const head = next.text.trim();
  if (SENTENCE_END.test(tail)) return false;
  if (/^\p{Lu}/u.test(head)) return false;
  return /\p{L}/u.test(tail) && /\p{L}/u.test(head);
}

function describe(lines) {
  const segs = lines.map((l) => l.seg);
  let text = '';
  for (const { text: t } of lines) {
    const piece = t.trim();
    if (!text) text = piece;
    else if (/[‐-—-]$/.test(text) && /^\p{Ll}/u.test(piece)) text = text.replace(/[‐-—-]$/, '') + piece;
    else if (CJK.test(text.slice(-1)) || CJK.test(piece[0])) text += piece;
    else text += ` ${piece}`;
  }
  const h = median(segs.map((s) => s.h));
  const tops = segs.map((s) => s.y1);
  const gaps = tops.slice(1).map((t, i) => tops[i] - t).filter((g) => g > 0);
  const tol = Math.max(1.5, h * 0.3);
  const spread = (xs) => Math.max(...xs) - Math.min(...xs);
  const centered = segs.length > 1 && spread(segs.map((s) => (s.x0 + s.x1) / 2)) <= tol
    && spread(segs.map((s) => s.x0)) > tol;
  // 外框的高度是墨跡的高度（含上伸與下伸部），大約是字級的 0.85 倍
  const fontSize = h / 0.85;
  return {
    text,
    bbox: {
      x0: Math.min(...segs.map((s) => s.x0)),
      x1: Math.max(...segs.map((s) => s.x1)),
      yTop: Math.max(...segs.map((s) => s.y1)),
      yBottom: Math.min(...segs.map((s) => s.y0)),
    },
    fontSize,
    lineGap: gaps.length ? median(gaps) : null,
    align: centered ? 'center' : 'left',
    indent: 0,
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
}
