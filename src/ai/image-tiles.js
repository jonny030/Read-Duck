/**
 * 圖片切塊。
 *
 * 為什麼需要：Prompt API 會先把圖片縮到 768×768 才送進模型。Chrome 自己會在
 * console 警告：
 *
 *   Image input (1536x1822) will be downscaled to 768x768.
 *   Dense spatial details like small text may be lost.
 *
 * 整張丟進去的話，截圖、漫畫頁、圖表這類「字小又密」的圖會被縮到糊掉 ——
 * 而那正是最需要這個功能的場景。改成切成不超過模型邊長的區塊、各自辨識，
 * 小字就維持原始解析度。代價是一張大圖變成好幾次模型呼叫，所以這個功能
 * 只能由使用者主動觸發，不能自動掃整頁。
 *
 * 切塊與合併都寫成不碰 DOM 的純函式，才能在 node 直接測。檔案最後的
 * detectTextRegions() 是唯一的例外 —— 它包裝瀏覽器的 TextDetector。
 */

/** 模型實際會用到的邊長。超過這個尺寸的圖都會被縮小。 */
export const MODEL_IMAGE_EDGE = 768;

/**
 * 相鄰區塊的重疊比例。
 * 沒有重疊的話，剛好落在切線上的那一行字會被切成兩半，兩邊都讀不出來。
 */
const OVERLAP = 0.12;

/**
 * 單一軸向的切法。回傳每一段的起點與長度。
 *
 * 重疊量平均分配到每一刀，而不是「固定步長走到底、最後補一塊」——
 * 後者在長度剛好是邊長整數倍時，最後兩塊會幾乎完全重疊，白白多跑一次模型。
 */
function axis(total, edge, overlap) {
  if (total <= edge) return [{ start: 0, size: total }];

  const minOverlap = Math.round(edge * overlap);
  const count = Math.max(2, Math.ceil((total - minOverlap) / (edge - minOverlap)));
  const stride = (total - edge) / (count - 1);

  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ start: Math.round(i * stride), size: edge });
  }
  return out;
}

/**
 * 規劃要把圖片切成哪些區塊。
 *
 * @param {number} width 圖片原始寬
 * @param {number} height 圖片原始高
 * @returns {Array<{x:number, y:number, width:number, height:number}>}
 *   由上到下、由左到右排列，接文字時就照這個順序
 */
export function planTiles(width, height, { edge = MODEL_IMAGE_EDGE, overlap = OVERLAP } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return [];
  // 本來就在模型的尺寸內：整張送，不必切也不會被縮
  if (width <= edge && height <= edge) {
    return [{ x: 0, y: 0, width: Math.round(width), height: Math.round(height) }];
  }

  const cols = axis(Math.round(width), edge, overlap);
  const rows = axis(Math.round(height), edge, overlap);
  const tiles = [];
  for (const r of rows) {
    for (const c of cols) {
      tiles.push({ x: c.start, y: r.start, width: c.size, height: r.size });
    }
  }
  return tiles;
}

/**
 * 把 TextDetector 找到的文字區塊合併成群組。
 *
 * TextDetector 常常一行字就是一個框，一個框跑一次模型太貴。這裡把讀序上
 * 相鄰、而且合併後仍然裝得進模型尺寸的框併成一群，一群裁一次、辨識一次。
 *
 * 好處不只是省呼叫：緊貼文字的裁切通常遠小於 768px，整塊送進去完全不會被
 * 縮小 —— 比盲切格線的效果好得多。
 *
 * @param {Array<{x:number,y:number,width:number,height:number}>} boxes
 * @param {{edge?:number, padding?:number}} opts
 *   padding 是裁切時往外留的邊 —— 貼著字元切，辨識品質會變差
 * @returns {Array<{x:number,y:number,width:number,height:number,count:number}>}
 */
export function groupBoxes(boxes, { edge = MODEL_IMAGE_EDGE, padding = 8 } = {}) {
  const valid = (boxes ?? []).filter(
    (b) => b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width > 0 && b.height > 0,
  );
  if (!valid.length) return [];

  // 1. 先把重疊與包含關係的框併掉。
  //    TextDetector 常常對同一段文字同時給「詞」和「行」兩層框，不併的話
  //    同一段會被辨識兩次，譯文也會在畫面上疊成兩層。
  let groups = mergeOverlapping(valid.map((b) => ({ ...bounds(b), count: 1 })));

  // 2. 讀序上相鄰、而且併起來仍裝得進模型尺寸的，併成一群省呼叫
  groups = pack(groups, edge);

  // 3. 最後再併一次到收斂為止。**這一步是「不重疊」這個保證的真正來源** ——
  //    第 2 步的貪婪打包是照讀序做的，兩個讀序上不相鄰的群組完全可能在空間上
  //    重疊；留邊也會讓方塊變大。拿掉這一行，隨機測試立刻找得到反例。
  //
  //    這個保證比「每群都不超過 edge」重要：超過 edge 只是那一塊會被縮小，
  //    重疊卻會讓兩份譯文疊在同一個位置，完全看不懂。
  return mergeOverlapping(groups.map((g) => pad(g, padding, edge)));
}

/** 讀序上相鄰的群組，併到裝不下為止。 */
function pack(groups, edge) {
  const sorted = [...groups].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const out = [];
  let cur = null;
  for (const g of sorted) {
    if (!cur) { cur = g; continue; }
    const merged = union(cur, g);
    if (merged.width <= edge && merged.height <= edge) {
      cur = { ...merged, count: cur.count + g.count };
    } else {
      out.push(cur);
      cur = g;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * 把互相重疊的矩形併成一個，直到沒有任何一對重疊為止。
 * 數量是數十個等級，O(n²) 迴圈完全夠用。
 */
function mergeOverlapping(rects) {
  const out = rects.map((r) => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    outer:
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        if (!intersects(out[i], out[j])) continue;
        const merged = union(out[i], out[j]);
        merged.count = (out[i].count ?? 1) + (out[j].count ?? 1);
        out.splice(j, 1);
        out[i] = merged;
        changed = true;
        break outer;
      }
    }
  }
  return out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function intersects(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width
    && a.y < b.y + b.height && b.y < a.y + a.height;
}

function bounds(b) {
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/** 往外留邊，但不要撐破模型的尺寸（撐破就會被縮小，反而失去意義）。 */
function pad(g, padding, edge) {
  const room = (size) => Math.min(padding, Math.max(0, (edge - size) / 2));
  const px = room(g.width);
  const py = room(g.height);
  return {
    x: Math.max(0, Math.round(g.x - px)),
    y: Math.max(0, Math.round(g.y - py)),
    width: Math.round(g.width + px * 2),
    height: Math.round(g.height + py * 2),
    count: g.count,
  };
}


/**
 * 用系統 OCR 找出文字在圖片的哪些位置。
 *
 * 實測（macOS）：TextDetector 的座標很準，但 rawValue 是空的 —— 官方文件
 * 也說「回傳 bounding box，**在某些平台上**還會回傳辨識出的字元」。所以
 * 這裡只拿它的座標，文字交給語言模型讀。
 *
 * 好處不只是省事：緊貼文字的裁切通常遠小於模型的 768px，整塊送進去完全
 * 不會被縮小 —— 比盲切格線清楚得多，呼叫次數也更少。
 *
 * 需要使用者在 chrome://flags 開啟「Experimental Web Platform features」，
 * 而且底層由作業系統提供，不是每個平台都支援。
 *
 * @returns {Promise<{available: boolean, reason?: string, boxes?: Array, texts?: string[]}>}
 */
export async function detectTextRegions(source) {
  if (typeof self === 'undefined' || !('TextDetector' in self)) {
    return { available: false, reason: 'no-api' };
  }
  try {
    const results = await new self.TextDetector().detect(source);
    return {
      available: true,
      boxes: results.map((r) => ({
        x: r.boundingBox.x,
        y: r.boundingBox.y,
        width: r.boundingBox.width,
        height: r.boundingBox.height,
      })),
      // 有些平台會連文字一起給，有的只給框
      texts: results.map((r) => r.rawValue).filter(Boolean),
    };
  } catch (err) {
    // 建構子存在不代表平台支援 —— 不支援時 detect() 直接 reject
    return { available: false, reason: 'platform', error: err };
  }
}
