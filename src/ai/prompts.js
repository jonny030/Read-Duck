/**
 * 集中管理所有 system prompt 與結構化輸出 schema。
 *
 * 每一則 prompt 都可以被使用者在設定頁覆寫（PROMPTS 這張表同時是設定頁的
 * 資料來源）。可編輯的只有「本體」—— respondIn() 那一行由程式自動接上，
 * 不開放修改：Prompt API 保證的輸出語言不含中文，整個「模型輸出英文 →
 * Translator 轉成目標語言」的管線都靠它，被刪掉會直接壞掉。
 *
 * 這些 prompt 一律用英文寫，參數也是「模型的輸出語言」而不是使用者的目標
 * 語言 —— Prompt API 保證的輸出語言只有 en/ja/es/de/fr，中文使用者拿到的是
 * 模型先用英文輸出、再由 Translator API 轉譯的結果（見 localize.js）。
 * 用英文寫 prompt 也讓模型比較不會被「用中文指示卻要求英文輸出」搞混。
 */

import { languageNameEn } from './languages.js';

/**
 * 每個 prompt 都以這一行結尾，確保輸出語言的指示不會被前面的內容淹沒。
 * 設定頁也用它告訴使用者「這行會自動接上，不用自己寫」。
 */
export function respondInLine(outputLanguage) {
  return `Write your entire response in ${languageNameEn(outputLanguage)}.`;
}

/** 使用者自訂 prompt 的長度上限。storage.sync 每個項目只有 8 KB。 */
export const MAX_PROMPT_LENGTH = 1200;

/**
 * 所有可覆寫的 system prompt。
 *
 * body 是可編輯的部分，裡面可以用 {language} 代入模型的輸出語言。
 * appendRespondIn 為 true 時，最後會自動補上輸出語言的指示。
 */
export const PROMPTS = Object.freeze([
  {
    key: 'explain',
    label: '劃選解釋',
    where: '選取文字後按「解釋」',
    appendRespondIn: true,
    body: [
      'You explain difficult text clearly and concisely.',
      'The user gives you a passage selected from a web page. Respond with:',
      '1. One sentence saying what the passage is about.',
      '2. Two to four bullet points covering key information or implications.',
      '3. A one-line explanation of each jargon term or acronym that appears.',
      'Do not restate the passage. No preamble, no pleasantries.',
    ].join('\n'),
  },
  {
    key: 'simplify',
    label: '劃選簡化',
    where: '選取文字後按「簡化」',
    appendRespondIn: true,
    body: [
      'Rewrite the text the user gives you so it is easier to understand.',
      'Break up long sentences, replace difficult vocabulary, and keep every fact and number.',
      'Do not add information that is not in the original.',
      'Output only the rewritten text — no preamble, no explanation.',
    ].join('\n'),
  },
  {
    key: 'summary',
    label: '整頁摘要',
    where: '側邊欄的「產生摘要」',
    appendRespondIn: true,
    body: [
      'You are a reading assistant. The user gives you the body text of a web article.',
      'Produce a structured summary:',
      '- oneLiner: one sentence capturing what the article is about (under 30 words)',
      '- bullets: 3 to 6 key points, one sentence each, covering the main arguments and conclusion',
      '- terms: up to 5 jargon terms worth explaining; use an empty array if there are none',
      'Base everything on the supplied text. Do not invent anything the article does not say.',
    ].join('\n'),
  },
  {
    key: 'chunkSummary',
    label: '長文分段摘要',
    where: '文章超過模型上下文時，先逐段濃縮再合併',
    appendRespondIn: true,
    body: [
      'Condense the article excerpt the user gives you into 3 to 5 key sentences.',
      'Keep concrete facts, numbers, names and conclusions.',
      'Add nothing beyond the excerpt. No preamble.',
    ].join('\n'),
  },
  {
    key: 'qa',
    label: '側邊欄問答',
    where: '摘要底下的提問框',
    appendRespondIn: true,
    body: [
      'You are a reading assistant helping the user understand an article.',
      'Rules:',
      '- Answer only from the article content provided.',
      '- If the article does not cover something, say so plainly instead of guessing.',
      '- Be brief. If one sentence is enough, use one sentence.',
    ].join('\n'),
  },
  {
    key: 'imageTranscribe',
    label: '圖片文字辨識',
    where: '在圖片上按右鍵 →「翻譯圖片中的文字」',
    // 模型只負責逐字轉錄，翻譯交給 Translator —— 和文字管線同樣的分工。
    // 所以這則不需要輸出語言的指示，轉錄本來就該用圖片裡原本的語言。
    appendRespondIn: false,
    body: [
      'Read all text in this image and transcribe it verbatim.',
      'The image may be one tile cropped out of a larger picture, so text may be'
      + ' cut off at the edges — transcribe what you can read and ignore fragments.',
      'Rules:',
      '- Output only the text you can actually read. Do not translate it.',
      '- Keep the original reading order, one line per visual line.',
      '- Do not describe the image, the layout, or anything you cannot read as text.',
      '- If there is no readable text at all, output exactly: NO_TEXT',
    ].join('\n'),
  },
  {
    key: 'inputRewrite',
    label: '輸入框翻譯',
    where: '在輸入框上按右鍵 →「翻譯這個輸入框的內容」',
    // 這一則的語言是寫在指示中間的，不另外補一行
    appendRespondIn: false,
    body: [
      "Translate the user's input into natural, idiomatic {language}.",
      'This message will be sent as-is, so:',
      '- Use what a native speaker would actually write, not a literal word-for-word rendering.',
      '- Preserve the original tone and level of formality.',
      '- Keep URLs, code, @mentions, #hashtags and emoji unchanged.',
      'Output only the translation — no quotes, no commentary.',
    ].join('\n'),
  },
]);

const BY_KEY = new Map(PROMPTS.map((p) => [p.key, p]));

/**
 * 只採用認得的 key、非空字串、且長度合理的覆寫。
 * 設定是使用者可以手動編輯 storage 的地方，不能假設形狀正確。
 */
export function sanitizeCustomPrompts(custom) {
  const out = {};
  if (!custom || typeof custom !== 'object') return out;
  for (const { key } of PROMPTS) {
    const v = custom[key];
    if (typeof v === 'string' && v.trim() && v.length <= MAX_PROMPT_LENGTH) out[key] = v.trim();
  }
  return out;
}

/** 組出最終送給模型的 system prompt。 */
export function buildPrompt(key, outputLanguage, custom) {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`未知的 prompt："${key}"`);
  const body = (sanitizeCustomPrompts(custom)[key] ?? def.body)
    .split('{language}').join(languageNameEn(outputLanguage));
  return def.appendRespondIn ? `${body}\n${respondInLine(outputLanguage)}` : body;
}

export const explainSystemPrompt = (lang, custom) => buildPrompt('explain', lang, custom);
export const simplifySystemPrompt = (lang, custom) => buildPrompt('simplify', lang, custom);
export const summarySystemPrompt = (lang, custom) => buildPrompt('summary', lang, custom);
export const chunkSummarySystemPrompt = (lang, custom) => buildPrompt('chunkSummary', lang, custom);
export const qaSystemPrompt = (lang, custom) => buildPrompt('qa', lang, custom);
export const inputRewriteSystemPrompt = (lang, custom) => buildPrompt('inputRewrite', lang, custom);
export const imageTranscribeSystemPrompt = (lang, custom) => buildPrompt('imageTranscribe', lang, custom);

/**
 * 摘要的結構化輸出 schema。搭配 omitResponseConstraintInput: true 使用。
 *
 * 刻意只用最保守的 JSON Schema 子集：type / properties / items / required /
 * additionalProperties。陣列長度限制（minItems / maxItems）已經拿掉 ——
 * 它要靠約束解碼在生成過程中計數，是各家實作差異最大的地方，Edge 的
 * Phi-4-mini 上會讓整個請求以 kErrorUnknown 失敗。條數的要求本來就寫在
 * summarySystemPrompt() 裡（3 to 6 key points），沒有它並不會少一道把關。
 */
export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    oneLiner: { type: 'string' },
    bullets: {
      type: 'array',
      items: { type: 'string' },
    },
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          explain: { type: 'string' },
        },
        required: ['term', 'explain'],
        additionalProperties: false,
      },
    },
  },
  required: ['oneLiner', 'bullets', 'terms'],
  additionalProperties: false,
};
