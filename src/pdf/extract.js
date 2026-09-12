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
/** 相鄰兩行隔超過字高的這個倍數，一定不是同一段（雙倍行距的稿子也才 2 倍） */
const MAX_LINE_GAP_RATIO = 2.5;
/** 縮排超過這個比例（相對欄寬）視為新段落 */
const INDENT_RATIO = 0.02;
/** 上一行明顯沒寫滿、又以句號結尾，視為段落結束 */
const SHORT_LINE_RATIO = 0.85;

/** 同一條基線上，片段之間的空隙超過這個倍數（相對字高）就切成兩段 —— 欄間空白遠大於字距 */
const SEGMENT_GAP_RATIO = 0.9;
/** 欄位偵測用的橫帶高度（相對行高）。兩欄的基線常常對不齊，帶子要夠高才抓得到兩邊 */
const BUCKET_RATIO = 2;
/** 判斷「對面那欄同一高度有沒有字」時的垂直容許範圍（相對行高） */
const NEIGHBOUR_RATIO = 1;
/** 兩欄都結束後，隔超過這個距離（相對行高）才出現的單邊文字，是雙欄下方的新區塊 */
const BLOCK_GAP_RATIO = 2.5;
/** 緊貼欄間空白的正文行至少要有頁寬的這個比例，才算「這裡有兩欄」的證據 */
const COLUMN_LINE_MIN_RATIO = 0.2;

/**
 * 表格的格子比正文的一行短：寬到足以當分欄證據的線段就不是格子。
 * 參考文獻列表（編號＋一行文獻）和一欄寬的正文行都靠這條擋在表格外面
 */
const CELL_MAX_RATIO = COLUMN_LINE_MIN_RATIO;
/** 左右對齊的行，字距是平均撐開的：相鄰空隙相差不超過這個值（pt）就是同一行的字距 */
const JUSTIFY_GAP_TOLERANCE = 0.3;
/** 撐開的字距再大也不會超過字高的這個倍數；表格欄與欄之間通常更寬 */
const JUSTIFY_MAX_GAP_RATIO = 2.5;
/** 相鄰兩行的字級相差超過這個倍數，就不是同一段 */
const FONT_BREAK_RATIO = 1.2;

/** 基線偏離水平超過這個角度（弧度，約 15°）就是旋轉的文字 */
const ROTATION_LIMIT = 0.26;
/** 橫排文字至少佔這個比例，旋轉的文字才確定只是點綴，可以略過 */
const HORIZONTAL_MAJORITY = 0.8;

/**
 * 側欄和正文之間的空白，要有這麼多條橫帶作證才算數。一條橫帶約兩行高，
 * 四條大約八行 —— 條列編號、表格的窄欄湊不到這麼多
 */
const SIDE_MIN_BANDS = 4;
/** 側欄只貼著頁緣：左側欄和正文之間的空白落在頁寬的這個範圍，右側欄對稱 */
const SIDE_ZONE = [0.06, 0.35];
/** 一條橫帶裡，側欄那一側的字至少要有頁寬的這個比例 */
const SIDE_TEXT_MIN_RATIO = 0.05;

const SENTENCE_END = /[.!?\u3002\uff01\uff1f\uff1a:\uff1b;]["'\u2019\u201d)\]]?$/;
const CJK = /[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const HYPHEN_END = /[\u2010-\u2014-]$/;

/**
 * @param {Array<{str:string, transform:number[], width:number, height:number}>} rawItems
 * @param {number} pageWidth viewport 寬度（PDF 使用者座標）
 * @returns {Array<{ text, column, bbox, fontSize }>} 依閱讀順序排列的段落
 *   column：0 左欄或單欄、1 右欄、2 頁邊的窄側欄
 *   bbox 是 PDF 使用者座標（原點左下、y 軸向上）：{ x0, x1, yTop, yBottom }
 *   譯文要疊回原文位置就需要它。
 */
export function groupParagraphs(rawItems, pageWidth) {
  const items = normalizeItems(rawItems);
  if (!items.length) return [];

  // 側欄先挑出來，剩下的才做分欄（見 peelSideColumns）
  const { main, sides } = peelSideColumns(items, pageWidth);

  const paragraphs = [];
  for (const region of layoutRegions(main, pageWidth)) {
    const found = region.cell
      ? mergeLines(buildLines(region.items))
      : textAndTables(region.items, pageWidth);
    for (const paragraph of found) paragraphs.push({ ...paragraph, column: region.column });
  }
  // 側欄是頁邊的附註（出處、作者單位），排在正文之後
  for (const side of sides) {
    for (const paragraph of mergeLines(buildLines(side))) paragraphs.push({ ...paragraph, column: 2 });
  }
  return paragraphs;
}

/**
 * 找出貼著頁緣的窄側欄，把它的文字從正文挑出來。
 *
 * The Lancet 的版面是「窄側欄＋兩欄正文」：出處、作者單位放在頁邊一條窄欄裡，
 * 單數頁在右、雙數頁在左。它和正文之間往往只隔幾 pt —— 比切線段用的字距門檻還小，
 * 同一條基線上的側欄文字和正文會被接成同一行，譯文就是兩邊混在一起的亂碼。
 *
 * 所以這裡直接看文字片段（不是線段）找空白。對一條候選的直線 x，每條橫帶投一票：
 *   擋住   有片段跨過 x
 *   支持   沒有片段跨過；側欄那一側有夠多的字；正文那一側緊鄰 x 的是一行像樣寬度的
 *          正文，而且就在空白旁邊（兩行高以內）—— 表格裡的窄欄、條列的編號不是；
 *          隔著一張照片或一整欄才碰到的正文也不算（雙欄的左欄不是右欄的側欄）
 *   不表態 其他情況
 * 沒有被擋住的連續橫帶裡支持票夠多，才是側欄；它的上下範圍就是那段連續的橫帶 ——
 * 側欄常常只佔頁面的一段，上下有橫跨過來的標題或方框；而側欄比正文長的那一截
 * 旁邊沒有正文，只會不表態，不能因此漏掉。
 *
 * @returns {{ main: Array, sides: Array<Array> }}
 */
function peelSideColumns(items, pageWidth) {
  const bandH = (median(items.map((i) => i.h)) || 10) * BUCKET_RATIO;
  const bandOf = (it) => Math.floor(it.y / bandH);
  const sides = [];
  let rest = items;
  for (const side of ['left', 'right']) {
    const found = findSideColumn(rest, pageWidth, bandH, side);
    if (!found) continue;
    const outer = side === 'left' ? (it) => it.x + it.w <= found.x : (it) => it.x >= found.x;
    const picked = new Set(rest.filter((it) => outer(it) && bandOf(it) <= found.top && bandOf(it) >= found.bottom));
    if (!picked.size) continue;
    sides.push([...picked]);
    rest = rest.filter((it) => !picked.has(it));
  }
  return { main: rest, sides };
}

function findSideColumn(items, pageWidth, bandH, side) {
  if (!pageWidth || items.length < 12) return null;
  const bands = new Map();
  for (const it of items) {
    const k = Math.floor(it.y / bandH);
    if (!bands.has(k)) bands.set(k, []);
    bands.get(k).push(it);
  }
  const keys = [...bands.keys()].sort((a, b) => b - a);   // 由上而下
  const minLine = pageWidth * COLUMN_LINE_MIN_RATIO;
  const minOuter = pageWidth * SIDE_TEXT_MIN_RATIO;
  const isOuter = side === 'left' ? (it, x) => it.x + it.w <= x : (it, x) => it.x >= x;

  const vote = (band, x) => {
    let outerWidth = 0;
    const inner = [];
    for (const it of band) {
      if (it.x < x && it.x + it.w > x) return 'block';
      if (isOuter(it, x)) outerWidth += it.w; else inner.push(it);
    }
    if (outerWidth < minOuter || !inner.length) return 'neutral';
    const byRow = new Map();
    for (const seg of buildSegments(inner)) {
      if (!byRow.has(seg.row)) byRow.set(seg.row, []);
      byRow.get(seg.row).push(seg);
    }
    for (const segs of byRow.values()) {
      const cells = justifiedCells(segs.sort((a, b) => a.x0 - b.x0));
      const nearest = side === 'left' ? cells[0] : cells[cells.length - 1];
      const gap = side === 'left' ? nearest.x0 - x : x - nearest.x1;
      if (gap <= bandH && nearest.x1 - nearest.x0 >= minLine) return 'support';
    }
    return 'neutral';
  };

  const [lo, hi] = side === 'left' ? SIDE_ZONE : [1 - SIDE_ZONE[1], 1 - SIDE_ZONE[0]];
  const candidates = [];
  for (let x = Math.ceil(pageWidth * lo); x <= pageWidth * hi; x++) {
    let run = null;
    let best = null;
    for (const k of keys) {
      const v = vote(bands.get(k), x);
      if (v === 'block') { run = null; continue; }
      if (!run) run = { x, support: 0, top: k, bottom: k };
      run.bottom = k;
      if (v === 'support') run.support++;
      if (!best || run.support > best.support) best = run;
    }
    if (best) candidates.push(best);
  }

  const most = Math.max(0, ...candidates.map((c) => c.support));
  if (most < SIDE_MIN_BANDS) return null;
  // 票數最多的 x 通常連成一段（整條空白），取最寬那段的正中間
  const groups = [];
  for (const c of candidates.filter((c) => c.support === most)) {
    const last = groups[groups.length - 1];
    if (last && c.x - last[last.length - 1].x <= 1) last.push(c);
    else groups.push([c]);
  }
  const widest = groups.sort((a, b) => b.length - a.length)[0];
  return widest[widest.length >> 1];
}

function normalizeItems(rawItems) {
  const all = [];
  for (const it of rawItems ?? []) {
    const str = it.str ?? '';
    if (!str.trim()) continue;
    const t = it.transform ?? [1, 0, 0, 1, 0, 0];
    const height = it.height || Math.abs(t[3]) || 10;
    all.push({
      text: str,
      x: t[4],
      y: t[5],          // PDF 座標原點在左下，y 越大越靠上
      w: it.width ?? 0,
      h: height,
      font: it.fontName ?? null,
      // 基線方向是 (t[0], t[1])。斜體只動到 t[2]，不會被誤判成旋轉
      rotated: Math.abs(Math.atan2(t[1], t[0])) > ROTATION_LIMIT,
    });
  }

  // 旋轉的文字只是少數時就略過：arXiv 論文左側的直立浮水印、圖表的縱軸標籤。
  // 它們不值得翻，而且被當成橫的一行時會橫跨頁面中線，把整頁的雙欄從中間切斷。
  // 整頁大多是旋轉的（橫放的表格）就不略過，免得整頁變成「沒有文字」
  const horizontal = all.filter((i) => !i.rotated);
  return horizontal.length >= all.length * HORIZONTAL_MAJORITY ? horizontal : all;
}

/**
 * 版面分析：把一頁拆成依閱讀順序排列的區塊。
 *
 * 同一頁常常一欄、兩欄混著出現 —— 論文第一頁幾乎都是跨欄標題、全寬摘要，
 * 下面才是雙欄正文；頁中也常有全寬的圖說或表格把兩欄切成上下兩段。
 *
 * 先前是「整頁判定一次」：要求中線在大部分列上都是空的才算雙欄。全寬的行
 * 一多就會否決掉，整頁退回單欄，左右兩欄同一條基線的文字被併成一行。而且
 * 是逐個 PDF.js 片段判斷左右，一行被切成好幾段時，全寬行會被拆到兩欄去；
 * 夾在全寬行垂直範圍裡的短片段更會直接被丟掉，永遠不會被翻譯。
 *
 * 現在的做法：
 *   1. 先把片段接成「線段」—— 同一條基線、字距以內的片段屬於同一段
 *   2. 找欄間線：只看「左右兩邊都有字、中間是空的」那些橫帶。全寬的行在這裡
 *      既不加分也不扣分，所以不會再因為摘要很長就否決整頁
 *   3. 由上而下把頁面分成單欄區與雙欄區（buildZones），每個線段只會屬於一個區
 *   4. 依序輸出：單欄區整塊；雙欄區先左欄、再右欄
 *
 * @returns {Array<{ items: Array, column: number }>} 依閱讀順序排列
 */
function layoutRegions(items, pageWidth) {
  const lineHeight = median(items.map((i) => i.h)) || 10;
  const segments = buildSegments(items);

  // 表格先挑出來：它們既不能當成分欄的證據，也要以整塊的位置插進閱讀順序
  const found = findTables(segments, pageWidth);
  const gutter = findGutter(
    segments.filter((s) => !found.some((cells) => cells.some((c) => c.parts.includes(s)))),
    pageWidth, lineHeight);

  // 只有真正橫跨兩欄的表格留在整頁層級：有格子跨過欄間線，或至少有一列在兩側
  // 各有兩格以上。其餘的（欄內的公式、只在一欄裡的表格）交給那一欄自己處理
  // （textAndTables）—— 另一側只是剛好同高的正文短行（段落最後一行、小標題），
  // 當成整塊插進去的話，那些行會變成格子，雙欄也會被攔腰切斷
  const tables = gutter == null ? found : found.filter((cells) => spansGutter(cells, gutter));
  const inTable = new Set(tables.flat().flatMap((c) => c.parts));
  const text = segments.filter((s) => !inTable.has(s));
  if (gutter == null && !tables.length) return [{ items, column: 0 }];

  for (const seg of text) {
    if (gutter == null || (seg.x0 < gutter && seg.x1 > gutter)) seg.side = 'span';
    else seg.side = seg.x1 <= gutter ? 'left' : 'right';
  }
  const units = [...text, ...tables.map((segs) => ({
    side: 'table',
    segments: segs,
    top: Math.max(...segs.map((s) => s.top)),
    bottom: Math.min(...segs.map((s) => s.bottom)),
    x0: Math.min(...segs.map((s) => s.x0)),
  }))];

  const regions = [];
  for (const zone of buildZones(units, lineHeight)) {
    const itemsOf = (segs) => segs.flatMap((s) => s.items);
    if (zone.kind === 'table') {
      for (const cell of cellOrder(zone.segments)) regions.push({ items: cell.items, column: 0, cell: true });
    } else if (zone.kind === 'single') {
      regions.push({ items: itemsOf(zone.segments), column: 0 });
    } else {
      regions.push({ items: itemsOf(zone.segments.filter((s) => s.side === 'left')), column: 0 });
      regions.push({ items: itemsOf(zone.segments.filter((s) => s.side === 'right')), column: 1 });
    }
  }
  return regions.filter((r) => r.items.length);
}

/**
 * 把片段接成線段：同一條基線、而且水平空隙在字距以內。
 *
 * PDF.js 常在字型或字距變化的地方把一行切成好幾個片段。逐片段判斷左右欄的話，
 * 一條剛好切在中線附近的全寬行會被拆到兩欄 —— 以線段為單位就不會。
 * 左右兩欄剛好在同一條基線時，中間的欄間空白遠大於字距，會被切成兩個線段。
 */
function buildSegments(items) {
  const sorted = [...items].sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const rows = [];
  let row = null;
  for (const it of sorted) {
    if (row && Math.abs(row.y - it.y) <= it.h * LINE_TOLERANCE) row.items.push(it);
    else { row = { y: it.y, items: [it] }; rows.push(row); }
  }

  const segments = [];
  rows.forEach((r, rowIndex) => {
    let seg = null;
    for (const p of [...r.items].sort((a, b) => a.x - b.x)) {
      const gap = seg ? p.x - seg.x1 : Infinity;
      if (seg && gap <= Math.max(seg.h, p.h) * SEGMENT_GAP_RATIO) {
        seg.items.push(p);
        seg.x1 = Math.max(seg.x1, p.x + p.w);
        seg.top = Math.max(seg.top, p.y + p.h);
        seg.bottom = Math.min(seg.bottom, p.y);
      } else {
        seg = { items: [p], x0: p.x, x1: p.x + p.w, top: p.y + p.h, bottom: p.y, h: p.h, row: rowIndex };
        segments.push(seg);
      }
    }
  });
  return segments;
}

/**
 * 找出表格。
 *
 * 表格的一列是「三個以上彼此分開的短片段」—— 雙欄正文的一列只會切成兩段，
 * 而且每段都是一欄寬。連續兩列以上都是這樣才算數；夾在中間、只有兩格的列
 * （例如有空格子）可以接受，但表格的頭尾一定要是三格以上的列 —— 否則旁邊只有
 * 兩段的雙欄正文會被吸進來。
 *
 * 公式與編號（「E = mc²    (3)」）在雙欄頁面上同一列還有另一欄的正文，那段是
 * 一欄寬、不算短，所以整列不會被當成表格。
 *
 * @returns {Array<Array>} 每個表格是它的格子陣列（格子見 justifiedCells）
 */
function findTables(segments, pageWidth) {
  const byRow = new Map();
  for (const seg of segments) {
    if (!byRow.has(seg.row)) byRow.set(seg.row, []);
    byRow.get(seg.row).push(seg);
  }
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0])
    .map(([, segs]) => ({ cells: justifiedCells([...segs].sort((a, b) => a.x0 - b.x0)) }));

  const maxCell = pageWidth * CELL_MAX_RATIO;
  const kindOf = (r) => {
    if (!r.cells.every((c) => c.x1 - c.x0 < maxCell)) return 'text';
    if (r.cells.length >= 3) return 'row';
    return r.cells.length === 2 ? 'maybe' : 'text';
  };

  const tables = [];
  let run = [];
  const flush = () => {
    while (run.length && run[0].kind !== 'row') run.shift();
    while (run.length && run[run.length - 1].kind !== 'row') run.pop();
    if (run.filter((r) => r.kind === 'row').length >= 2) tables.push(run.flatMap((r) => r.cells));
    run = [];
  };
  for (const r of rows) {
    r.kind = kindOf(r);
    if (r.kind === 'text') flush();
    else run.push(r);
  }
  flush();
  return tables;
}

/**
 * 把一列的線段併成格子。
 *
 * 左右對齊的行會把字距平均撐開，撐大的字距可能超過線段的切分門檻，一行字就被
 * 切成一個字一段 ——「(1) oligo-anovulation, (2) clinical or biochemical」這種行
 * 看起來就像一列五格。但那些空隙彼此相等（排版軟體就是平均分配的），表格欄與
 * 欄之間的空隙則幾乎不會連續兩個都一樣。欄距平均、內容又一樣寬的表格（一整列
 * 的「NA」）空隙也會相等，但表格的欄距遠大於字距，所以只認字高幾倍以內的空隙。
 *
 * @returns {Array<{ parts, items, x0, x1, top, bottom, row }>}
 */
function justifiedCells(segs) {
  const gaps = segs.slice(1).map((seg, i) => seg.x0 - segs[i].x1);   // gaps[i]：第 i 與 i+1 段之間
  const same = (a, b) => a != null && b != null && Math.abs(a - b) <= JUSTIFY_GAP_TOLERANCE;
  const cells = [];
  segs.forEach((seg, i) => {
    const before = gaps[i - 1];
    const cell = cells[cells.length - 1];
    const wordGap = i > 0 && before <= Math.max(seg.h, segs[i - 1].h) * JUSTIFY_MAX_GAP_RATIO;
    if (wordGap && (same(before, gaps[i - 2]) || same(before, gaps[i]))) {
      cell.parts.push(seg);
      cell.items.push(...seg.items);
      cell.x1 = Math.max(cell.x1, seg.x1);
      cell.top = Math.max(cell.top, seg.top);
      cell.bottom = Math.min(cell.bottom, seg.bottom);
    } else {
      cells.push({ parts: [seg], items: [...seg.items], x0: seg.x0, x1: seg.x1,
        top: seg.top, bottom: seg.bottom, row: seg.row });
    }
  });
  return cells;
}

function spansGutter(cells, gutter) {
  if (cells.some((c) => c.x0 < gutter && c.x1 > gutter)) return true;
  const rows = new Map();
  for (const c of cells) {
    if (!rows.has(c.row)) rows.set(c.row, { left: 0, right: 0 });
    rows.get(c.row)[c.x1 <= gutter ? 'left' : 'right']++;
  }
  return [...rows.values()].some((r) => r.left >= 2 && r.right >= 2);
}

/** 表格的閱讀順序：一列一列，列內由左到右。 */
function cellOrder(segments) {
  return [...segments].sort((a, b) => (a.row - b.row) || (a.x0 - b.x0));
}

/**
 * 一個區塊裡的段落。順便把區塊內的表格挑出來，一格一段。
 *
 * 這是給「只放在單一欄裡的表格」用的：在整頁層級看不出它是表格 —— 同一列
 * 還有另一欄一欄寬的正文 —— 要等分完欄、只看這一欄時才看得出來。
 */
function textAndTables(items, pageWidth) {
  const segments = buildSegments(items);
  const tables = findTables(segments, pageWidth);
  if (!tables.length) return mergeLines(buildLines(items));

  const inTable = new Set(tables.flat().flatMap((c) => c.parts));
  const units = [
    ...segments.filter((s) => !inTable.has(s)).map((s) => ({ top: s.top, seg: s })),
    ...tables.map((segs) => ({ top: Math.max(...segs.map((s) => s.top)), table: segs })),
  ].sort((a, b) => b.top - a.top);

  const out = [];
  let pending = [];
  const flushText = () => {
    if (pending.length) out.push(...mergeLines(buildLines(pending.flatMap((s) => s.items))));
    pending = [];
  };
  for (const u of units) {
    if (u.seg) { pending.push(u.seg); continue; }
    flushText();
    for (const cell of cellOrder(u.table)) out.push(...mergeLines(buildLines(cell.items)));
  }
  flushText();
  return out;
}

/**
 * 找出欄間線。
 *
 * 證據是「左右兩邊都有字、中間沒有東西跨過」的橫帶有幾條。全寬的行跨過中線，
 * 那條橫帶就不算證據 —— 但也不會否決，這是和先前做法的關鍵差別：先前要求
 * 「大部分列都沒有東西跨過」，全寬摘要一長就整頁退回單欄。
 *
 * @returns {number|null} 欄間線的 x，找不到就回 null（整頁視為單欄）
 */
function findGutter(segments, pageWidth, lineHeight) {
  if (segments.length < 6 || !pageWidth) return null;

  const bucketH = lineHeight * BUCKET_RATIO;
  const buckets = new Map();
  for (const seg of segments) {
    const key = Math.floor(seg.bottom / bucketH);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(seg);
  }
  const bucketList = [...buckets.values()];

  // 緊貼空白兩側的都要是像樣的正文行。表格的格子、公式編號、並排的作者單位
  // 都很短 —— 它們在中線附近也會留下空白，但那不是兩欄
  const minLine = pageWidth * COLUMN_LINE_MIN_RATIO;
  const wide = (seg) => seg && seg.x1 - seg.x0 >= minLine;

  const SAMPLES = 80;
  const lo = pageWidth * 0.3;
  const hi = pageWidth * 0.7;
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const x = lo + ((hi - lo) * i) / (SAMPLES - 1);
    let split = 0;
    for (const bucket of bucketList) {
      let left = null;
      let right = null;
      let crosses = false;
      for (const seg of bucket) {
        if (seg.x0 < x && seg.x1 > x) { crosses = true; break; }
        if (seg.x1 <= x) { if (!left || seg.x1 > left.x1) left = seg; }
        else if (!right || seg.x0 < right.x0) right = seg;
      }
      if (!crosses && wide(left) && wide(right)) split++;
    }
    samples.push({ x, split });
  }

  // 要有幾條橫帶真的是兩欄才分欄。證據已經要求兩側都是像樣寬度的正文行，
  // 巧合很少，所以兩條就夠 —— IEEE 那種右欄幾乎都是圖表的頁面，並排的正文只剩
  // 最下面兩三行，門檻再高就會整頁退回單欄，把左右兩欄同一條基線的字併成一行
  const best = Math.max(...samples.map((s) => s.split));
  if (best < Math.max(2, Math.ceil(bucketList.length * 0.1))) return null;

  // 取「分欄證據接近最多」的最寬連續區間，用它的中心當欄間線
  const bar = best * 0.8;
  let run = null;
  let start = null;
  for (let i = 0; i <= samples.length; i++) {
    const ok = i < samples.length && samples[i].split >= bar;
    if (ok && start === null) start = i;
    if (!ok && start !== null) {
      const from = samples[start].x;
      const to = samples[i - 1].x;
      if (!run || to - from > run.width) run = { width: to - from, center: (from + to) / 2 };
      start = null;
    }
  }
  if (!run || run.width < pageWidth * 0.015) return null;
  return run.center;
}

/**
 * 由上而下把線段分成單欄區與雙欄區。
 *
 * 跨過欄間線的線段一定屬於單欄區。沒跨過的（只在一邊）要看上下文：
 *   - 已經在雙欄區裡：它是某一欄的延續 —— 包括右欄先結束後，左欄剩下的那幾行。
 *     例外是兩欄都結束、隔了一大段才出現、而且對面沒有字：那是雙欄下方的新區塊。
 *   - 在單欄區裡：對面同一高度有字，就是雙欄開始了；沒有的話，它是全寬內容的
 *     一部分 —— 全寬段落沒寫滿的最後一行、短短的小標題。
 *
 * 每個線段恰好屬於一個區，所以不會有文字被丟掉。
 */
function buildZones(segments, lineHeight) {
  const order = [...segments].sort((a, b) => (b.top - a.top) || (a.x0 - b.x0));
  const near = lineHeight * NEIGHBOUR_RATIO;
  const hasOpposite = (seg) => {
    const other = seg.side === 'left' ? 'right' : 'left';
    return segments.some((t) => t.side === other
      && t.top >= seg.bottom - near && t.bottom <= seg.top + near);
  };
  const open = (kind) => ({ kind, segments: [], bottom: Infinity });

  const zones = [];
  let zone = null;
  for (const seg of order) {
    // 表格是一整塊，整塊插在它的位置上；它也會結束前面的雙欄區
    if (seg.side === 'table') {
      zones.push(zone = { kind: 'table', segments: seg.segments, bottom: seg.bottom });
      continue;
    }
    if (seg.side === 'span') {
      if (zone?.kind !== 'single') zones.push(zone = open('single'));
    } else if (zone?.kind === 'double') {
      const belowBoth = zone.bottom - seg.top > lineHeight * BLOCK_GAP_RATIO;
      if (belowBoth && !hasOpposite(seg)) zones.push(zone = open('single'));
    } else if (hasOpposite(seg)) {
      zones.push(zone = open('double'));
    } else if (zone?.kind !== 'single') {
      zones.push(zone = open('single'));
    }
    zone.segments.push(seg);
    zone.bottom = Math.min(zone.bottom, seg.bottom);
  }

  // 太薄的雙欄區不是真的分欄：全寬段落裡一個剛好落在中線的寬字距，就會讓
  // 那一行看起來「左右都有字」。退回單欄，接回前後的單欄區，段落才不會被切碎
  for (const z of zones) {
    const left = z.segments.filter((s) => s.side === 'left').length;
    const right = z.segments.filter((s) => s.side === 'right').length;
    if (z.kind === 'double' && (left < 2 || right < 2)) z.kind = 'single';
  }
  const merged = [];
  for (const z of zones) {
    const last = merged[merged.length - 1];
    if (last && last.kind === 'single' && z.kind === 'single') {
      last.segments.push(...z.segments);
    } else if (last && last.kind === 'single' && z.kind === 'double' && oneSided(last)) {
      // 雙欄區前面、只有單邊文字的單欄區，其實是那一欄的上半截 —— 另一欄在那個高度
      // 是圖或畫成圖形的表格（沒有文字）。分成兩區的話，同一段會在中間被切開
      z.segments.unshift(...last.segments);
      merged[merged.length - 1] = z;
    } else {
      merged.push(z);
    }
  }
  return merged;
}

/** 只有單一側的文字（沒有跨欄的行、沒有表格）。 */
function oneSided(zone) {
  const sides = new Set(zone.segments.map((s) => s.side));
  return sides.size === 1 && (sides.has('left') || sides.has('right'));
}

/**
 * 一行的字級：依寬度加權的中位數。
 *
 * 不能直接取片段字級的中位數 —— 滿是下標的公式行（x_i + y_j …）小字片段比
 * 正文片段還多，中位數會落在下標的字級，那一行就被當成換了字型而把段落切斷。
 * 上下標都很窄，用寬度加權後，一行的字級由真正佔版面的正文決定。
 */
function lineSize(parts) {
  const total = parts.reduce((sum, p) => sum + p.w, 0);
  if (!(total > 0)) return median(parts.map((p) => p.h));
  const sorted = [...parts].sort((a, b) => a.h - b.h);
  let acc = 0;
  for (const p of sorted) {
    acc += p.w;
    if (acc >= total / 2) return p.h;
  }
  return sorted[sorted.length - 1].h;
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
      h: lineSize(parts),
      font: dominantFont(parts),
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
    const paragraph = buffer.length ? paragraphOf(buffer) : null;
    if (paragraph) paragraphs.push(paragraph);
    buffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines[i - 1];

    if (prev && buffer.length) {
      const gap = prev.y - line.y;
      // 左緣以首行以外的行為準：首行可能縮排，也可能是懸掛縮排（條列符號、文獻編號）
      const bodyLeft = buffer.length > 1 ? Math.min(...buffer.slice(1).map((l) => l.x0)) : buffer[0].x0;
      const shift = line.x0 - bodyLeft;
      const indentTol = columnWidth * INDENT_RATIO;
      // 置中的行（標題、圖說）每一行的左緣都不同，那不是縮排
      const centered = Math.abs((line.x0 + line.x1) - (prev.x0 + prev.x1)) / 2 <= Math.max(1.5, line.h * 0.3);
      // 懸掛縮排：第一行寫滿、句子還沒結束，下一行縮進去 —— 是同一段的續行
      const hanging = buffer.length === 1 && shift > 0 && shift <= line.h * 4
        && !SENTENCE_END.test(prev.text) && (prev.x1 - prev.x0) >= columnWidth * SHORT_LINE_RATIO;
      const indented = columnWidth > 0 && shift > indentTol && !centered && !hanging;
      // 懸掛縮排的段落之後，下一段（下一個條列項目、下一條文獻）從更左邊開始
      const outdented = buffer.length > 1 && -shift > indentTol && !centered;
      const prevEndedSentence = SENTENCE_END.test(prev.text)
        && columnWidth > 0
        && (prev.x1 - prev.x0) < columnWidth * SHORT_LINE_RATIO;

      // 字級突然變了（標題 → 正文、正文 → 圖表標籤或註腳）就換段。
      // 上下標不會觸發：它們併在同一行裡，而一行的字級是依寬度加權的（見 lineSize）
      const sizeJump = Math.max(line.h, prev.h) / Math.max(Math.min(line.h, prev.h), 1e-6);
      const fontBreak = sizeJump > FONT_BREAK_RATIO;
      // 換了字型、上一行又沒寫滿：和正文同字級的粗體小標題接正文。只看上一行很短的
      // 情況 —— 同一份字型在 PDF 裡可能有好幾個代號，段落中間寫滿的行不能因此被切斷
      const fontChange = prev.font != null && line.font != null && prev.font !== line.font
        && (prev.x1 - prev.x0) < columnWidth * SHORT_LINE_RATIO;

      // 行距的中位數在只有零星幾行的區塊裡會被撐大：IEEE 的頁首和圖說中間隔著整排子圖，
      // 這一區就只有那一個行距，它本身就是中位數，永遠不會「比平常大」。兩行被併成一段，
      // 譯文方塊從頁首一路蓋到圖說，把整張圖蓋住。所以另外用字高設一個絕對上限
      const farApart = gap > Math.max(line.h, prev.h) * MAX_LINE_GAP_RATIO;

      if (gap > typicalGap * PARAGRAPH_GAP_RATIO || farApart || indented || outdented
          || prevEndedSentence || fontBreak || fontChange) flush();
    }
    buffer.push(line);
  }
  flush();

  return paragraphs;
}

/**
 * 一段的文字與排版資訊。譯文要疊回原位、看起來和原文一致，就靠這些：
 *   lineGap  行距（基線到基線），單行時為 null
 *   align    'justify' | 'left' | 'center' | 'right'
 *   indent   首行相對其他行的縮排（負值是懸掛縮排，例如條列的項目符號）
 *   fontName PDF.js 的字型代號（佔寬最多的那個），檢視器用它查粗細與襯線
 */
function paragraphOf(lines) {
  const text = joinLines(lines);
  if (!text) return null;
  const fontSize = median(lines.map((l) => l.h));
  const gaps = lines.slice(1).map((l, i) => lines[i].y - l.y).filter((g) => g > 0);
  const tol = Math.max(1.5, fontSize * 0.3);
  const indent = lines.length > 1 ? lines[0].x0 - Math.min(...lines.slice(1).map((l) => l.x0)) : 0;

  const width = new Map();
  for (const l of lines) width.set(l.font, (width.get(l.font) ?? 0) + (l.x1 - l.x0));

  return {
    text,
    bbox: boundsOf(lines),
    fontSize,
    lineGap: gaps.length ? median(gaps) : null,
    align: alignmentOf(lines, tol),
    indent: Math.abs(indent) > tol ? indent : 0,
    fontName: [...width.entries()].sort((a, b) => b[1] - a[1])[0][0],
  };
}

/**
 * 段落的對齊方式。首行可能縮排、末行通常沒寫滿，判斷時各自排除。
 * 兩行的段落資訊太少，只分得出置中與靠右，其餘當作左右對齊。
 */
function alignmentOf(lines, tol) {
  if (lines.length < 2) return 'left';
  const near = (xs) => Math.max(...xs) - Math.min(...xs) <= tol;
  const lefts = lines.map((l) => l.x0);
  const rights = lines.map((l) => l.x1);
  const bodyLefts = lines.length > 2 ? lefts.slice(1) : lefts;

  if (near(lines.map((l) => (l.x0 + l.x1) / 2)) && !near(lefts)) return 'center';
  if (near(rights) && !near(bodyLefts)) return 'right';
  if ((lines.length === 2 || near(bodyLefts)) && near(rights.slice(0, -1))) return 'justify';
  return 'left';
}

/** 佔寬最多的字型。 */
function dominantFont(parts) {
  const width = new Map();
  for (const p of parts) width.set(p.font, (width.get(p.font) ?? 0) + p.w);
  return [...width.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/**
 * 值不值得送去翻譯。
 *
 * 表格裡的數字、公式編號、座標軸刻度沒有字母，翻了只是原樣吐回來；欄內公式被拆成
 * 一格一格之後，「p,m」「i∈I」「k=1」這種碎片翻出來只會是一塊蓋在公式上的亂碼。
 * 所以要有真正的詞（連續三個以上的字母，不算 max、log 這些函數名），而且詞要佔
 * 掉這段文字的一定比例 ——「emax=λQ−e1,∀」只有一個詞，其餘都是符號。
 */
export function isTranslatable(text) {
  const words = (text.match(/\p{L}{3,}/gu) ?? []).filter((w) => !MATH_WORDS.test(w));
  if (!words.length) return false;
  const visible = text.replace(/\s/g, '').length;
  return words.join('').length >= visible * TRANSLATABLE_WORD_SHARE;
}

/** 公式裡常見、單獨出現時不必翻的函數名 */
const MATH_WORDS = /^(max|min|sup|inf|lim|log|exp|sin|cos|tan|arg|det|mod)$/i;
/** 真正的詞至少要佔一段文字（不含空白）的這個比例 */
const TRANSLATABLE_WORD_SHARE = 0.4;

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
