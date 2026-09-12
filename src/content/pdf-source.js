import { toBase64, isPdfBytes, sniffNonPdf } from '../lib/binary.js';

/**
 * 替 ReadDuck 的 PDF 檢視器，從「正在顯示這份 PDF 的分頁」取得檔案內容。
 *
 * 為什麼不讓檢視器自己抓：檢視器是擴充功能頁面，它發的請求**不是**使用者
 * 看 PDF 時的那一個 ——
 *   - 學術出版商的 PDF 大多要登入（機構訂閱），檢視器的請求不一定帶得到那些 cookie；
 *   - ScienceDirect 那類有簽章的下載網址（X-Amz-Expires=300）只有幾分鐘效期，
 *     使用者讀了一會兒才按鴨子，網址早就失效了。
 * 兩種情況伺服器都會回一個網頁而不是 PDF，PDF.js 只會說「Invalid PDF structure」。
 *
 * 從原本的分頁抓就沒有這些問題：同源所以不受 CORS 限制、帶得到登入狀態，
 * 而且 cache: 'force-cache' 會先試瀏覽器快取裡剛才載入過的那一份 —— 有命中的話，
 * 簽章過期也沒關係。
 */

/**
 * 轉交的上限。訊息會 JSON 序列化，base64 又膨脹成 1.33 倍，
 * 而 Chrome 的擴充功能訊息上限是 64 MiB。
 */
export const MAX_PDF_BYTES = 40 * 1024 * 1024;

/**
 * @returns {Promise<{base64:string} | {kind:string, status?:number, error?:string}>}
 *   只有確認是 PDF 才回傳內容。這支會帶著網頁的登入狀態去抓，所以刻意不交出
 *   任何「不是 PDF」的東西 —— 就算有誰要它抓一個登入後的網頁，也拿不走內容。
 */
export async function fetchPdfBytes(url) {
  if (!url) return { kind: 'no-url' };

  let res;
  try {
    res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  } catch (e) {
    // 跨來源的網址會被網頁的 CORS 擋在這裡，檢視器會改成自己抓
    return { kind: 'network', error: String(e?.message || e) };
  }
  if (!res.ok) return { kind: 'http', status: res.status };

  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_PDF_BYTES) return { kind: 'too-large' };
  if (!isPdfBytes(buf)) return { kind: sniffNonPdf(buf) };
  return { base64: toBase64(buf) };
}

/** 至少要佔掉可視範圍的這個比例，才算「這個網頁的正文就是那份 PDF」。 */
const MIN_COVERAGE = 0.4;

/**
 * 這個網頁是不是「包著一份 PDF 的外殼」。
 *
 * IEEE Xplore 的 stamp.jsp 就是這種：6 KB 的 HTML，真正的內容是一個佔滿畫面的
 * `<iframe src=".../10309129.pdf">`。content script 只跑在最上層框架，把它當一般
 * 網頁翻，只會找到幾行導覽列，然後說「無法判斷這個頁面的語言」。
 *
 * 判斷刻意保守：必須佔掉畫面的一大塊，而且網址或 type 看得出是 PDF。
 * 側欄裡嵌一份小小的 PDF 預覽不算 —— 那種網頁的正文還是網頁本身。
 *
 * @returns {string|null} PDF 的絕對網址
 */
export function findEmbeddedPdf(doc = document) {
  const win = doc.defaultView;
  const viewport = (win?.innerWidth ?? 0) * (win?.innerHeight ?? 0);
  if (!viewport) return null;

  for (const el of doc.querySelectorAll('iframe, embed, object')) {
    const raw = el.getAttribute('src') ?? el.getAttribute('data');
    if (!raw) continue;

    let url;
    try { url = new URL(raw, doc.baseURI); } catch { continue; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;

    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (type !== 'application/pdf' && !/\.pdf$/i.test(url.pathname)) continue;

    const r = el.getBoundingClientRect();
    if (r.width * r.height < viewport * MIN_COVERAGE) continue;
    return url.href;
  }
  return null;
}
