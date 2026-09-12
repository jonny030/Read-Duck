/**
 * 二進位資料的小工具。純函式，node 裡直接測得到。
 *
 * 會需要這些，是因為 chrome.runtime 的訊息會做 JSON 序列化 —— Blob、
 * ArrayBuffer、Uint8Array 都活不過去，只能轉成 base64 字串再傳。
 */

/** 分段轉 base64：一次 apply 整個陣列會爆呼叫堆疊。 */
export function toBase64(buf) {
  const bytes = asBytes(buf);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * 是不是 PDF。
 *
 * 規格允許 `%PDF-` 前面有最多 1024 bytes 的雜訊（有些產生器會塞空白或 BOM），
 * 所以不能只比對開頭五個字元。
 */
export function isPdfBytes(buf) {
  const b = asBytes(buf).subarray(0, 1024 + 5);
  for (let i = 0; i + 4 < b.length; i++) {
    // %PDF-
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44
        && b[i + 3] === 0x46 && b[i + 4] === 0x2d) return true;
  }
  return false;
}

/**
 * 不是 PDF 的話，它大概是什麼。
 *
 * 用來給使用者講人話：PDF.js 對一個網頁只會說「Invalid PDF structure」，
 * 「伺服器回傳的是網頁」才看得懂，也才知道要去登入或重新整理。
 *
 * @returns {'empty'|'html'|'xml'|'json'|'unknown'}
 */
export function sniffNonPdf(buf) {
  const b = asBytes(buf).subarray(0, 512);
  if (!b.length) return 'empty';
  const head = new TextDecoder('utf-8').decode(b).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')
      || /<(head|body|meta|title)[\s>]/.test(head)) return 'html';
  // S3 的錯誤回應（AccessDenied、簽章過期）是 XML
  if (head.startsWith('<')) return 'xml';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return 'unknown';
}

function asBytes(buf) {
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}
