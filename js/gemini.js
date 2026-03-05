/**
 * gemini.js — Gemini Vision API 連携モジュール（オプション）
 * APIキーが設定されていない場合は全機能をスキップして手動モードで動作します。
 */

const GeminiClient = (() => {
    const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
    const MODEL_FLASH = 'gemini-1.5-flash';
    const MODEL_PRO = 'gemini-1.5-flash';

    let _apiKey = null;

    function setApiKey(key) { _apiKey = key ? key.trim() : null; }
    function getApiKey() { return _apiKey; }
    function isConfigured() { return !!_apiKey; }

    async function request(model, contents) {
        if (!_apiKey) throw new Error('API key not set');
        const url = `${BASE_URL}/${model}:generateContent?key=${_apiKey}`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents, generationConfig: { temperature: 0.3, maxOutputTokens: 2048 } })
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err?.error?.message || `HTTP ${res.status}`);
        }
        const data = await res.json();
        return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    }

    /**
     * 名刺画像からコンタクト情報を抽出
     * @param {string} base64Image - base64エンコードされた画像
     * @param {string} mimeType - 'image/jpeg' or 'image/png'
     * @returns {Promise<Object>} コンタクト情報
     */
    async function extractBusinessCard(base64Image, mimeType = 'image/jpeg') {
        const prompt = `あなたは名刺OCRの専門家です。この名刺画像を詳細に分析してください。

以下の情報を正確に抽出し、JSON形式で出力してください（余分なテキストなし、JSONのみ）：

{
  "name": "氏名（フルネーム）",
  "nameKana": "読み仮名（推測可）",
  "company": "会社名",
  "department": "部署名",
  "title": "役職",
  "email": "メールアドレス",
  "phone": "電話番号（携帯優先）",
  "address": "住所",
  "website": "ウェブサイト",
  "cardDesign": "名刺デザインの特徴（色、ロゴの印象、質感、紙の種類など）",
  "handwrittenNotes": "手書きメモがあれば記載",
  "industryGuess": "業種の推測",
  "firstImpressionAdvice": "この業種・役職の人物への最初のアプローチとして有効な話題（50字以内）"
}`;

        const contents = [{
            parts: [
                { text: prompt },
                { inlineData: { mimeType, data: base64Image } }
            ]
        }];

        const text = await request(MODEL_PRO, contents);
        // JSONを抽出（マークダウンコードブロックを除去）
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('JSONパースに失敗しました');
        return JSON.parse(jsonMatch[0]);
    }

    /**
     * 音声テキスト/メモを4分類に自動整理
     * @param {string} memo - 音声認識または手入力のテキスト
     * @param {Object} contactInfo - 既存のコンタクト情報
     * @returns {Promise<Object>} 4分類データ
     */
    async function classifyMemo(memo, contactInfo = {}) {
        const context = contactInfo.name
            ? `相手: ${contactInfo.name}（${contactInfo.company || ''}・${contactInfo.title || ''}）`
            : '';

        const prompt = `あなたは百戦錬磨のトップ営業マンの参謀AIです。
${context}

以下の商談後メモを分析し、4つのカテゴリに分類してください。

メモ:
"${memo}"

以下のJSON形式で出力（余分なテキストなし、JSONのみ）:
{
  "jirai": ["触れてはいけない話題や地雷（配列、重要なものから）"],
  "hook": ["趣味・家族・出身地など懐に入るためのネタ（配列）"],
  "map": ["組織図にない実権者・紹介の恩・犬猿の仲などの人間関係（配列）"],
  "next": ["次回、相手の心を動かすために必要な具体的アクション（配列、優先順）"],
  "summary": "このメモの30字要約"
}

注意: 各カテゴリに該当がなければ空配列[]にすること。`;

        const text = await request(MODEL_FLASH, [{ parts: [{ text: prompt }] }]);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('JSONパースに失敗しました');
        return JSON.parse(jsonMatch[0]);
    }

    /**
     * コンタクトの攻略サマリを生成（商談前の確認用）
     * @param {Object} contact - コンタクトオブジェクト
     * @returns {Promise<string>} 攻略サマリテキスト
     */
    async function generateBriefing(contact) {
        const jiraiList = (contact.jirai || []).join('、');
        const hookList = (contact.hook || []).join('、');
        const nextList = (contact.next || []).join('、');
        const mapList = (contact.map || []).join('、');

        const prompt = `あなたはトップ営業マン専用の参謀AIです。
商談15分前の「最終確認ブリーフィング」を作成してください。

---
相手:  ${contact.name}（${contact.company || ''}・${contact.title || ''}）
地雷:  ${jiraiList || 'なし'}
フック: ${hookList || 'なし'}
相関図: ${mapList || 'なし'}
次の一手: ${nextList || 'なし'}
---

以下の形式で200字以内の日本語ブリーフィングを作成:
「今日の商談でやること」「絶対に触れてはいけないこと」「最初の一言」の3点で構成。
箇条書きで簡潔に。`;

        return await request(MODEL_FLASH, [{ parts: [{ text: prompt }] }]);
    }

    return { setApiKey, getApiKey, isConfigured, extractBusinessCard, classifyMemo, generateBriefing };
})();
