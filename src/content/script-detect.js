/**
 * 便宜的文字書寫系統判定（純字元範圍，不跑模型）。
 *
 * 用途：在呼叫 LanguageDetector 之前先過濾。整頁 500 段全部送去偵測太慢，
 * 但「拉丁字母的段落絕不可能已經是中文」這種判斷用字元範圍就夠了。
 * 只有書寫系統和目標語言相同的段落才需要真的跑偵測模型確認。
 */

const RANGES = [
  ['han',        /[㐀-䶿一-鿿豈-﫿]/],
  ['kana',       /[぀-ゟ゠-ヿ]/],
  ['hangul',     /[가-힯ᄀ-ᇿ]/],
  ['cyrillic',   /[Ѐ-ӿ]/],
  ['arabic',     /[؀-ۿݐ-ݿ]/],
  ['hebrew',     /[֐-׿]/],
  ['thai',       /[฀-๿]/],
  ['devanagari', /[ऀ-ॿ]/],
  ['latin',      /[A-Za-zÀ-ɏ]/],
];

/**
 * 表意文字的資訊密度遠高於字母，一個漢字大約抵得上一個英文單字。
 * 不加權的話「深度學習模型 transformer 架構說明」會被算成拉丁文為主。
 */
const WEIGHT = { han: 2.5, kana: 2.5, hangul: 2.5, thai: 2 };

/** 各書寫系統的加權佔比。只看有字母意義的字元，忽略空白與標點。 */
export function scriptProfile(text) {
  const counts = Object.create(null);
  let total = 0;
  for (const ch of text) {
    for (const [name, re] of RANGES) {
      if (re.test(ch)) {
        const w = WEIGHT[name] ?? 1;
        counts[name] = (counts[name] ?? 0) + w;
        total += w;
        break;
      }
    }
  }
  if (!total) return { dominant: 'none', ratio: 0, counts, total };
  let dominant = 'none', best = 0;
  for (const [name, n] of Object.entries(counts)) {
    if (n > best) { best = n; dominant = name; }
  }
  return { dominant, ratio: best / total, counts, total };
}

/** 語言碼 -> 主要書寫系統。 */
export function scriptOfLanguage(tag) {
  const base = String(tag || '').split('-')[0].toLowerCase();
  switch (base) {
    case 'zh': return 'han';
    case 'ja': return 'kana';   // 日文一定混有假名，用假名當指紋比漢字準
    case 'ko': return 'hangul';
    case 'ru': case 'uk': case 'bg': case 'sr': return 'cyrillic';
    case 'ar': case 'fa': case 'ur': return 'arabic';
    case 'he': return 'hebrew';
    case 'th': return 'thai';
    case 'hi': case 'mr': return 'devanagari';
    default: return 'latin';
  }
}

/**
 * 這段文字有沒有可能已經是目標語言？
 * false 代表「書寫系統就不一樣，一定需要翻譯」，可以直接跳過偵測模型。
 */
export function mightAlreadyBe(text, targetLanguage) {
  const want = scriptOfLanguage(targetLanguage);
  const { counts, total } = scriptProfile(text);
  if (!total) return false;
  if (want === 'han') {
    // 有假名代表是日文，不是中文
    if ((counts.kana ?? 0) / total > 0.05) return false;
    return (counts.han ?? 0) / total > 0.5;
  }
  if (want === 'kana') {
    // 日文：假名 + 漢字合計
    return ((counts.kana ?? 0) + (counts.han ?? 0)) / total > 0.5;
  }
  return (counts[want] ?? 0) / total > 0.5;
}
