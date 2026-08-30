import { promptStream } from './language-model.js';
import { translateText } from './translator-pool.js';
import { detectLanguage } from './detector.js';
import { sameLanguage } from './languages.js';

/**
 * 把語言模型的輸出轉成使用者的目標語言。
 *
 * 為什麼需要這一層：Prompt API 保證的輸出語言只有 en/ja/es/de/fr，中文不在
 * 其中。所以中文使用者拿到的是「模型用英文思考與輸出 → Translator API 轉成
 * 中文」的雙段管線。這比讓模型硬擠出未經保證的中文品質更穩定。
 *
 * 串流的部分以句子為單位邊產生邊翻譯，使用者不必等整段跑完才看到中文。
 */

/** 短於這個長度的片段先不翻，等湊成完整的句子再說 —— 太碎的句子翻不好。 */
const MIN_SEGMENT = 30;
const SENTENCE_END = /[.!?。！？；;\n]/;

/**
 * 模型偶爾會不照指示、直接用輸入的語言回答。真的已經是目標語言時再翻一次
 * 只會產生亂碼，所以動手前先確認來源語言。
 * @returns {Promise<string|null>} 實際的來源語言；null 代表不需要翻譯
 */
async function resolveSource(sample, plan) {
  const detected = await detectLanguage(sample.slice(0, 200));
  if (detected && sameLanguage(detected.language, plan.finalLanguage)) return null;
  return detected?.language ?? plan.modelLanguage;
}

/** 一次性轉譯。 */
export async function localizeText(text, plan, { signal } = {}) {
  if (!plan.needsTranslation || !text?.trim()) return text;
  const source = await resolveSource(text, plan);
  if (!source) return text;
  return translateText(text, source, plan.finalLanguage, { signal });
}

/** 陣列版本，保持順序。 */
export function localizeAll(texts, plan, opts) {
  return Promise.all((texts ?? []).map((t) => localizeText(t, plan, opts)));
}

/**
 * 串流提問並即時轉譯。
 *
 * onChunk 收到的一律是「目前為止的完整目標語言文字」，呼叫端不必知道
 * 底下有沒有經過翻譯。
 */
export async function promptLocalized(session, input, { plan, signal, onChunk } = {}) {
  if (!plan?.needsTranslation) {
    return promptStream(session, input, { signal, onChunk });
  }

  let consumed = 0;           // 已經送去翻譯的原文長度
  let out = '';               // 已完成的譯文
  let source = undefined;     // undefined = 還沒判定；null = 不需要翻譯
  let chain = Promise.resolve();

  const flush = (segment) => {
    if (!segment.trim()) return;
    // 串成一條鏈，確保譯文的順序和原文一致
    chain = chain.then(async () => {
      if (source === undefined) source = await resolveSource(segment, plan);
      out += source === null
        ? segment
        : await translateText(segment, source, plan.finalLanguage, { signal });
      onChunk?.(out);
    });
  };

  const raw = await promptStream(session, input, {
    signal,
    onChunk: (acc) => {
      // 往回找最後一個句子結尾，只把完整的句子送去翻
      let boundary = -1;
      for (let i = acc.length - 1; i >= consumed; i--) {
        if (SENTENCE_END.test(acc[i])) { boundary = i + 1; break; }
      }
      if (boundary - consumed < MIN_SEGMENT) return;
      const segment = acc.slice(consumed, boundary);
      consumed = boundary;
      flush(segment);
    },
  });

  if (consumed < raw.length) flush(raw.slice(consumed));
  await chain;
  return out;
}
