/**
 * FNV-1a 32-bit，回傳 8 碼 hex。
 * 用途是快取 key，不需要密碼學強度，只需要快 + 碰撞率夠低。
 */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619，用位移避免 32 位元溢位失真
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** 把文字正規化成快取用的形式：壓縮空白、去頭尾。 */
export function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** 譯文快取 key：內容 + 語言對。長度也放進去，進一步降低碰撞。 */
export function cacheKey(text, sourceLang, targetLang) {
  const t = normalizeText(text);
  return `${sourceLang}>${targetLang}:${t.length}:${fnv1a(t)}`;
}
