/**
 * 集中管理所有 system prompt 與結構化輸出 schema。
 *
 * 這些 prompt 一律用英文寫，參數也是「模型的輸出語言」而不是使用者的目標
 * 語言 —— Prompt API 保證的輸出語言只有 en/ja/es/de/fr，中文使用者拿到的是
 * 模型先用英文輸出、再由 Translator API 轉譯的結果（見 localize.js）。
 * 用英文寫 prompt 也讓模型比較不會被「用中文指示卻要求英文輸出」搞混。
 */

import { languageNameEn } from './languages.js';

/** 每個 prompt 都以這一行結尾，確保輸出語言的指示不會被前面的內容淹沒。 */
function respondIn(outputLanguage) {
  return `Write your entire response in ${languageNameEn(outputLanguage)}.`;
}

export function explainSystemPrompt(outputLanguage) {
  return [
    'You explain difficult text clearly and concisely.',
    'The user gives you a passage selected from a web page. Respond with:',
    '1. One sentence saying what the passage is about.',
    '2. Two to four bullet points covering key information or implications.',
    '3. A one-line explanation of each jargon term or acronym that appears.',
    'Do not restate the passage. No preamble, no pleasantries.',
    respondIn(outputLanguage),
  ].join('\n');
}

export function simplifySystemPrompt(outputLanguage) {
  return [
    'Rewrite the text the user gives you so it is easier to understand.',
    'Break up long sentences, replace difficult vocabulary, and keep every fact and number.',
    'Do not add information that is not in the original.',
    'Output only the rewritten text — no preamble, no explanation.',
    respondIn(outputLanguage),
  ].join('\n');
}

export function summarySystemPrompt(outputLanguage) {
  return [
    'You are a reading assistant. The user gives you the body text of a web article.',
    'Produce a structured summary:',
    '- oneLiner: one sentence capturing what the article is about (under 30 words)',
    '- bullets: 3 to 6 key points, one sentence each, covering the main arguments and conclusion',
    '- terms: up to 5 jargon terms worth explaining; use an empty array if there are none',
    'Base everything on the supplied text. Do not invent anything the article does not say.',
    respondIn(outputLanguage),
  ].join('\n');
}

export function chunkSummarySystemPrompt(outputLanguage) {
  return [
    'Condense the article excerpt the user gives you into 3 to 5 key sentences.',
    'Keep concrete facts, numbers, names and conclusions.',
    'Add nothing beyond the excerpt. No preamble.',
    respondIn(outputLanguage),
  ].join('\n');
}

export function qaSystemPrompt(outputLanguage) {
  return [
    'You are a reading assistant helping the user understand an article.',
    'Rules:',
    '- Answer only from the article content provided.',
    '- If the article does not cover something, say so plainly instead of guessing.',
    '- Be brief. If one sentence is enough, use one sentence.',
    respondIn(outputLanguage),
  ].join('\n');
}

export function inputRewriteSystemPrompt(outputLanguage) {
  return [
    `Translate the user's input into natural, idiomatic ${languageNameEn(outputLanguage)}.`,
    'This message will be sent as-is, so:',
    '- Use what a native speaker would actually write, not a literal word-for-word rendering.',
    '- Preserve the original tone and level of formality.',
    '- Keep URLs, code, @mentions, #hashtags and emoji unchanged.',
    'Output only the translation — no quotes, no commentary.',
  ].join('\n');
}

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
