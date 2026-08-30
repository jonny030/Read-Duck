import { normalizeAvailability, describeError } from './capability.js';
import { canonical } from './languages.js';

/**
 * 語言偵測。整個分頁共用一個 detector 實例。
 * 官方提醒：太短的字串（單字、片語）判斷會不準，所以呼叫端要自己過濾長度。
 */

let detectorPromise = null;
/** 段落文字 -> 語言碼。同一段不重複偵測。 */
const memo = new Map();
const MEMO_LIMIT = 2000;

export function isDetectorPresent() {
  return typeof self !== 'undefined' && 'LanguageDetector' in self;
}

export async function getDetector(opts = {}) {
  if (detectorPromise) return detectorPromise;
  if (!isDetectorPresent()) throw new Error('LanguageDetector 不存在於此執行情境');

  const availability = normalizeAvailability(await self.LanguageDetector.availability());
  if (availability === 'unavailable') throw new Error('LanguageDetector 不可用');

  detectorPromise = self.LanguageDetector.create({
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => opts.onDownloadProgress?.(e.loaded));
    },
  }).catch((err) => {
    detectorPromise = null;
    throw err;
  });
  return detectorPromise;
}

/** 最短可信長度。低於此值直接放棄偵測，交給頁面層級的判定結果。 */
export const MIN_DETECT_LENGTH = 12;

/**
 * 偵測單段文字的語言。
 * @returns {Promise<{ language: string, confidence: number } | null>}
 */
export async function detectLanguage(text, { minConfidence = 0.5 } = {}) {
  const t = text.trim();
  if (t.length < MIN_DETECT_LENGTH) return null;

  const memoKey = t.length > 200 ? t.slice(0, 200) : t;
  if (memo.has(memoKey)) return memo.get(memoKey);

  try {
    const detector = await getDetector();
    const results = await detector.detect(t);
    const top = results?.[0];
    const out = top && top.confidence >= minConfidence && top.detectedLanguage !== 'und'
      ? { language: canonical(top.detectedLanguage), confidence: top.confidence }
      : null;
    if (memo.size >= MEMO_LIMIT) memo.clear();
    memo.set(memoKey, out);
    return out;
  } catch (e) {
    console.warn('[ReadDuck] detect failed:', describeError(e));
    return null;
  }
}

/**
 * 頁面主要語言：抽樣數段，用文字長度加權投票。
 *
 * 只抽樣不全掃，是因為偵測本身也要跑模型；一整頁跑下來成本不划算，
 * 而且頁面主語言用幾段有代表性的長文就夠準了。
 */
export async function detectPageLanguage(texts, { sampleSize = 8 } = {}) {
  const candidates = texts
    .map((t) => t.trim())
    .filter((t) => t.length >= 40)
    .sort((a, b) => b.length - a.length)
    .slice(0, sampleSize);

  if (!candidates.length) return null;

  const votes = new Map();
  for (const text of candidates) {
    const r = await detectLanguage(text.slice(0, 500), { minConfidence: 0.4 });
    if (!r) continue;
    const weight = Math.min(text.length, 500) * r.confidence;
    votes.set(r.language, (votes.get(r.language) ?? 0) + weight);
  }
  if (!votes.size) return null;

  let bestLang = null, bestScore = -1, total = 0;
  for (const [lang, score] of votes) {
    total += score;
    if (score > bestScore) { bestScore = score; bestLang = lang; }
  }
  return { language: bestLang, confidence: total ? bestScore / total : 0 };
}

export function reset() {
  memo.clear();
  detectorPromise?.then((d) => d.destroy?.()).catch(() => {});
  detectorPromise = null;
}
