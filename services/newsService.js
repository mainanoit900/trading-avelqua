const axios = require('axios');

function ensureSettings(db) {
  db.settings = db.settings || {};
  const s = db.settings;
  if (!s.openaiApiKey) s.openaiApiKey = process.env.OPENAI_API_KEY || '';
  if (!s.openaiModel) s.openaiModel = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  if (!s.newsApiKey) s.newsApiKey = process.env.NEWS_API_KEY || '';
  if (!Number.isFinite(Number(s.newsLimitPerPage))) s.newsLimitPerPage = 9;
  if (!Number.isFinite(Number(s.newsFetchPerDay))) s.newsFetchPerDay = 9;
  if (!Number.isFinite(Number(s.newsFetchDays))) s.newsFetchDays = 1;
  if (!Number.isFinite(Number(s.autoRefreshMinutes))) s.autoRefreshMinutes = 15;
  if (typeof s.openaiEnabled !== 'boolean') s.openaiEnabled = true;
  if (typeof s.autoTranslate !== 'boolean') s.autoTranslate = true;
  if (typeof s.autoNewsUpdate !== 'boolean') s.autoNewsUpdate = true;
  return s;
}

function buildNewsQuery(settings) {
  const days = Math.max(1, Number(settings.newsFetchDays || 1));
  const pageSize = Math.max(1, Math.min(100, Number(settings.newsFetchPerDay || 9)));
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fromStr = from.toISOString().split('T')[0];
  return {
    q: 'forex OR gold OR stocks OR crypto OR economy OR fed OR inflation',
    language: 'en',
    sortBy: 'publishedAt',
    pageSize,
    from: fromStr
  };
}

function inferCategory(text = '') {
  const value = String(text).toLowerCase();
  if (value.includes('gold') || value.includes('xau')) return 'gold';
  if (value.includes('crypto') || value.includes('bitcoin') || value.includes('ethereum')) return 'crypto';
  if (value.includes('forex') || value.includes('usd') || value.includes('eur') || value.includes('jpy')) return 'forex';
  if (value.includes('stock') || value.includes('nasdaq') || value.includes('dow') || value.includes('s&p')) return 'stocks';
  return 'market';
}

async function enrichWithOpenAI(item, settings) {
  const apiKey = settings.openaiApiKey || process.env.OPENAI_API_KEY;
  const model = settings.openaiModel || process.env.OPENAI_MODEL || 'gpt-4.1-mini';
  if (!apiKey || (!settings.openaiEnabled && !settings.autoTranslate)) {
    return item;
  }

  try {
    const prompt = [
      'Return only valid JSON.',
      'Fields: translatedTitle, translatedBody, analysis.',
      'translatedTitle and translatedBody must be Thai.',
      'analysis must be concise Thai analysis for investors, max 80 words.',
      'If content is missing, still return safe fallback strings.',
      `Title: ${item.title || ''}`,
      `Body: ${item.body || ''}`
    ].join('\n');

    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model,
        messages: [
          { role: 'system', content: 'You are a financial news translator and analyst.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.3,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const content = response?.data?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);
    if (settings.autoTranslate) {
      item.translatedTitle = String(parsed.translatedTitle || item.translatedTitle || item.title || '');
      item.translatedBody = String(parsed.translatedBody || item.translatedBody || item.body || '');
    }
    if (settings.openaiEnabled) {
      item.analysis = String(parsed.analysis || item.analysis || '');
    }
  } catch (error) {
    console.error('OpenAI enrich news error:', error.response?.data || error.message);
    if (settings.autoTranslate) {
      item.translatedTitle = item.translatedTitle || item.title || '';
      item.translatedBody = item.translatedBody || item.body || '';
    }
  }

  return item;
}

async function fetchLatestNews(db, options = {}) {
  const settings = ensureSettings(db);
  const apiKey = settings.newsApiKey || process.env.NEWS_API_KEY;
  if (!apiKey) {
    return { ok: false, message: 'NEWS_API_KEY not configured', items: db.news || [] };
  }

  const query = buildNewsQuery(settings);
  try {
    const response = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        ...query,
        apiKey
      },
      timeout: 30000
    });

    const articles = Array.isArray(response.data?.articles) ? response.data.articles : [];
    const items = [];

    for (let index = 0; index < articles.length; index += 1) {
      const article = articles[index];
      const title = String(article?.title || '').trim();
      const body = String(article?.description || article?.content || '').trim();
      if (!title && !body) continue;

      const item = {
        id: Date.now() + index,
        title,
        body,
        translatedTitle: '',
        translatedBody: '',
        analysis: '',
        source: String(article?.source?.name || 'NewsAPI').trim(),
        url: String(article?.url || '#').trim(),
        imageUrl: String(article?.urlToImage || '').trim(),
        category: inferCategory(`${title} ${body}`),
        createdAt: article?.publishedAt || new Date().toISOString(),
        fetchedAt: new Date().toISOString()
      };

      if (settings.autoTranslate || settings.openaiEnabled) {
        await enrichWithOpenAI(item, settings);
      }

      items.push(item);
    }

    db.news = items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    db.newsMeta = {
      lastUpdatedAt: new Date().toISOString(),
      source: 'newsapi',
      itemCount: db.news.length,
      forced: Boolean(options.force)
    };

    return { ok: true, items: db.news, meta: db.newsMeta };
  } catch (error) {
    console.error('Fetch latest news error:', error.response?.data || error.message);
    return { ok: false, message: error.message, items: db.news || [] };
  }
}

function isRefreshDue(db) {
  const settings = ensureSettings(db);
  if (!settings.autoNewsUpdate) return false;
  const minutes = Math.max(1, Number(settings.autoRefreshMinutes || 15));
  const lastUpdatedAt = db.newsMeta?.lastUpdatedAt;
  if (!lastUpdatedAt) return true;
  const diffMs = Date.now() - new Date(lastUpdatedAt).getTime();
  return diffMs >= minutes * 60 * 1000;
}

module.exports = {
  ensureSettings,
  fetchLatestNews,
  isRefreshDue
};
