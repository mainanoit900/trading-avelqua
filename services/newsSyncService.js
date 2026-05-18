require('dotenv').config();

const { query } = require('../config/database');

function mapEnabledCategories(settings) {
  const categories = [];
  if (settings.category_economy) categories.push('business');
  if (settings.category_finance) categories.push('business');
  if (settings.category_investment) categories.push('business');
  if (settings.category_currency) categories.push('business');
  return [...new Set(categories.length ? categories : ['business'])];
}

function getTargetLanguages() {
  return ['th', 'en', 'lo', 'vi', 'my'];
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || data.error || `Request failed: ${res.status}`);
  }
  return data;
}

async function fetchNewsFromNewsApi(settings) {
  if (!settings.news_api_key) return [];

  const categories = mapEnabledCategories(settings);
  const pageSize = Math.min(100, Math.max(1, Number(settings.news_per_day || 10)));
  const articles = [];

  for (const category of categories) {
    const url = new URL('https://newsapi.org/v2/top-headlines');
    url.searchParams.set('country', 'us');
    url.searchParams.set('category', category);
    url.searchParams.set('pageSize', String(pageSize));
    url.searchParams.set('apiKey', settings.news_api_key);

    const data = await fetchJson(url.toString());
    for (const item of data.articles || []) {
      articles.push({
        externalId: item.url || `${category}:${item.title || ''}`,
        sourceName: item.source?.name || 'NewsAPI',
        sourceUrl: item.url || '',
        imageUrl: item.urlToImage || '',
        categoryName: category,
        title: item.title || '',
        body: item.description || item.content || '',
        publishedAt: item.publishedAt || null
      });
    }
  }

  const dedup = new Map();
  for (const item of articles) {
    if (!item.externalId || !item.title) continue;
    if (!dedup.has(item.externalId)) dedup.set(item.externalId, item);
  }

  return Array.from(dedup.values()).slice(0, Number(settings.news_per_day || 10));
}

async function callOpenAIChat(apiKey, model, prompt) {
  const data = await fetchJson('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'gpt-5.4-mini',
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'You are a financial news editor. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  return data?.choices?.[0]?.message?.content || '';
}

async function enrichWithAI(article, settings) {
  const result = {
    translated_title: '',
    translated_body: '',
    analysis: '',
    lang_texts: {}
  };

  if (!settings.openai_api_key) return result;

  const langs = getTargetLanguages();
  const wantsTranslate = !!settings.auto_translate_enabled;
  const wantsAnalysis = !!settings.ai_analysis_enabled;

  const prompt = `
Translate and summarize this financial news into JSON.

Languages required: ${wantsTranslate ? langs.join(', ') : 'none'}
Need analysis: ${wantsAnalysis ? 'yes' : 'no'}

Return JSON exactly in this shape:
{
  "translations": {
    "th": {"title":"","body":""},
    "en": {"title":"","body":""},
    "lo": {"title":"","body":""},
    "vi": {"title":"","body":""},
    "my": {"title":"","body":""}
  },
  "analysis": ""
}

Article:
Title: ${article.title}
Body: ${article.body}
Category: ${article.categoryName}
Source: ${article.sourceName}
`;

  const raw = await callOpenAIChat(
    settings.openai_api_key,
    settings.openai_model,
    prompt
  );

  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const translations = parsed.translations || {};
  result.lang_texts = translations;
  result.translated_title = translations.th?.title || '';
  result.translated_body = translations.th?.body || '';
  result.analysis = wantsAnalysis ? String(parsed.analysis || '') : '';

  return result;
}

async function upsertArticle(article, aiData) {
  await query(
    `INSERT INTO news_articles (
      external_id,
      source_name,
      source_url,
      image_url,
      category_name,
      title,
      body,
      translated_title,
      translated_body,
      analysis,
      lang_texts,
      published_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
    ON CONFLICT (external_id)
    DO UPDATE SET
      source_name = EXCLUDED.source_name,
      source_url = EXCLUDED.source_url,
      image_url = EXCLUDED.image_url,
      category_name = EXCLUDED.category_name,
      title = EXCLUDED.title,
      body = EXCLUDED.body,
      translated_title = EXCLUDED.translated_title,
      translated_body = EXCLUDED.translated_body,
      analysis = EXCLUDED.analysis,
      lang_texts = EXCLUDED.lang_texts,
      published_at = EXCLUDED.published_at`,
    [
      article.externalId,
      article.sourceName,
      article.sourceUrl,
      article.imageUrl,
      article.categoryName,
      article.title,
      article.body,
      aiData.translated_title || '',
      aiData.translated_body || '',
      aiData.analysis || '',
      JSON.stringify(aiData.lang_texts || {}),
      article.publishedAt
    ]
  );
}

async function getNewsSettings() {
  const result = await query(`SELECT * FROM news_settings WHERE id = 1 LIMIT 1`);
  return result.rows[0] || null;
}

async function syncNewsNow() {
  const settings = await getNewsSettings();
  if (!settings) throw new Error('news_settings not found');
  if (!settings.news_api_key) throw new Error('NEWS_API_KEY is empty');

  const articles = await fetchNewsFromNewsApi(settings);

  for (const article of articles) {
    const aiData = (settings.auto_translate_enabled || settings.ai_analysis_enabled)
      ? await enrichWithAI(article, settings)
      : { translated_title: '', translated_body: '', analysis: '', lang_texts: {} };

    await upsertArticle(article, aiData);
  }

  return { ok: true, total: articles.length };
}

module.exports = {
  getNewsSettings,
  syncNewsNow
};