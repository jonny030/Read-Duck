/** BCP-47 語言碼處理。內建 API 用 BCP-47，偵測器回傳的也是 BCP-47。 */

/** Translator API 目前支援的語言（Chrome 138 起，會隨版本增加）。 */
export const SUPPORTED_LANGUAGES = [
  ['zh-Hant', '繁體中文'],
  ['zh-Hans', '简体中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['es', 'Español'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['it', 'Italiano'],
  ['pt', 'Português'],
  ['ru', 'Русский'],
  ['ar', 'العربية'],
  ['hi', 'हिन्दी'],
  ['bn', 'বাংলা'],
  ['vi', 'Tiếng Việt'],
  ['th', 'ไทย'],
  ['id', 'Bahasa Indonesia'],
  ['tr', 'Türkçe'],
  ['nl', 'Nederlands'],
  ['pl', 'Polski'],
  ['uk', 'Українська'],
  ['he', 'עברית'],
  ['fa', 'فارسی'],
  ['sv', 'Svenska'],
  ['da', 'Dansk'],
  ['fi', 'Suomi'],
  ['no', 'Norsk'],
  ['cs', 'Čeština'],
  ['el', 'Ελληνικά'],
  ['ro', 'Română'],
  ['hu', 'Magyar'],
  ['ms', 'Bahasa Melayu'],
  ['ta', 'தமிழ்'],
  ['te', 'తెలుగు'],
  ['mr', 'मराठी'],
  ['ur', 'اردو'],
  ['kn', 'ಕನ್ನಡ'],
  ['ca', 'Català'],
  ['hr', 'Hrvatski'],
];

const NAME_BY_TAG = new Map(SUPPORTED_LANGUAGES);

export function languageName(tag) {
  if (!tag) return '未知';
  if (NAME_BY_TAG.has(tag)) return NAME_BY_TAG.get(tag);
  try {
    return new Intl.DisplayNames(['zh-Hant'], { type: 'language' }).of(tag) || tag;
  } catch {
    return tag;
  }
}

/** 語言的英文名稱。system prompt 是用英文寫的，需要用英文指名輸出語言。 */
export function languageNameEn(tag) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) || tag;
  } catch {
    return tag;
  }
}

/** 拆出 base / script / region，例如 'zh-Hant-TW' -> { base:'zh', script:'Hant', region:'TW' }。 */
export function parseTag(tag) {
  if (!tag) return { base: '', script: '', region: '' };
  const parts = String(tag).split('-');
  const base = parts[0].toLowerCase();
  const rest = parts.slice(1);
  const script = rest.find((p) => p.length === 4 && /^[A-Za-z]+$/.test(p)) || '';
  const region = rest.find((p) => p.length === 2 && /^[A-Za-z]+$/.test(p)) || '';
  return {
    base,
    script: script ? script[0].toUpperCase() + script.slice(1).toLowerCase() : '',
    region: region.toUpperCase(),
  };
}

/** 使用繁體中文的地區。zh-TW / zh-HK 沒有 script 子標籤，只能靠地區判斷。 */
const HANT_REGIONS = new Set(['TW', 'HK', 'MO']);

/**
 * 判斷「不需要翻譯」。
 * zh-Hans -> zh-Hant 仍需要翻譯（簡轉繁），所以中文要比到字體那一層。
 */
export function sameLanguage(a, b) {
  const x = parseTag(a), y = parseTag(b);
  if (x.base !== y.base) return false;
  if (x.base === 'zh') {
    // zh-TW / zh-Hant / zh-Hant-TW 都要能互相對上，所以統一收斂後再比
    const cx = chineseVariant(x), cy = chineseVariant(y);
    // 任一邊判不出字體時保守地視為不同，寧可多翻一次也不要漏翻
    return cx !== null && cx === cy;
  }
  return true;
}

/** @returns {'Hant'|'Hans'|null} */
function chineseVariant({ script, region }) {
  if (script === 'Hant' || script === 'Hans') return script;
  if (HANT_REGIONS.has(region)) return 'Hant';
  if (region === 'CN' || region === 'SG') return 'Hans';
  return null;
}

/** 把偵測器可能回傳的變體收斂成 Translator 認得的形式。 */
export function canonical(tag) {
  const parsed = parseTag(tag);
  const { base } = parsed;
  if (base === 'zh') return chineseVariant(parsed) === 'Hant' ? 'zh-Hant' : 'zh-Hans';
  if (base === 'nb' || base === 'nn') return 'no';
  if (base === 'iw') return 'he';   // 舊的希伯來文代碼
  if (base === 'in') return 'id';   // 舊的印尼文代碼
  return base;
}
