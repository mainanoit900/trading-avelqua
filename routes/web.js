const express = require('express');
const { listPackages } = require('../repositories/packagesRepo');
const { query } = require('../config/database');

const router = express.Router();

function groupPackages(packages) {
  const grouped = { basic: [], pro: [], advanced: [] };
  for (const pkg of packages || []) {
    const key = String(pkg.group || 'basic').toLowerCase();
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(pkg);
  }
  return grouped;
}

function getCommonViewData(req, extra = {}) {
  return {
    title: extra.title || 'TRADING AVELQUA',
    pageTitle: extra.pageTitle || extra.title || 'TRADING AVELQUA',
    currentPath: extra.currentPath || req.path,
    user: req.user || req.session?.user || null,
    lang: req.session?.lang || 'th',
    db: extra.db || {},
    ...extra
  };
}

async function getNewsItems(limit = 8) {
  try {
    const result = await query(
      `SELECT id, title, body, translated_title, translated_body, analysis, source_name, source_url, image_url, category_name, published_at, created_at
       FROM news_articles
       ORDER BY COALESCE(published_at, created_at) DESC
       LIMIT $1`,
      [Number(limit)]
    );
    return result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      body: row.body,
      translatedTitle: row.translated_title,
      translatedBody: row.translated_body,
      analysis: row.analysis,
      source: row.source_name,
      url: row.source_url,
      imageUrl: row.image_url,
      category: row.category_name,
      createdAt: row.published_at || row.created_at
    }));
  } catch {
    return [];
  }
}

router.get('/', async (req, res) => {
  const packages = await listPackages();
  const latestNews = await getNewsItems(8);
  return res.render('home', getCommonViewData(req, {
    title: 'TRADING AVELQUA | Premium',
    currentPath: '/',
    packages,
    grouped: groupPackages(packages),
    news: latestNews
  }));
});

router.get('/pricing', async (req, res) => {
  const packages = await listPackages();
  return res.render('pricing', getCommonViewData(req, {
    title: 'Pricing | TRADING AVELQUA',
    currentPath: '/pricing',
    grouped: groupPackages(packages)
  }));
});

router.get('/bots', (req, res) => {
  return res.render('bots', getCommonViewData(req, { title: 'Bots | TRADING AVELQUA', currentPath: '/bots' }));
});

router.get('/market', (req, res) => {
  return res.render('market', getCommonViewData(req, { title: 'Market | TRADING AVELQUA', currentPath: '/market' }));
});

router.get('/contact', (req, res) => {
  return res.render('contact', getCommonViewData(req, { title: 'Contact | TRADING AVELQUA', currentPath: '/contact' }));
});

router.get('/news', async (req, res) => {
  const currentLang = req.session?.lang || 'th';

  const settingsResult = await query(`SELECT * FROM news_settings WHERE id = 1 LIMIT 1`).catch(() => ({ rows: [] }));
  const rawSettings = settingsResult.rows[0] || { news_per_page: 9, auto_translate_enabled: true, ai_analysis_enabled: true };

  const settings = {
    ...rawSettings,
    openaiEnabled: !!rawSettings.ai_analysis_enabled,
    autoTranslate: !!rawSettings.auto_translate_enabled,
    newsLimitPerPage: Number(rawSettings.news_per_page || 9),
    autoRefreshMinutes: 15
  };

  const perPage = Math.max(1, Number(settings.newsLimitPerPage || 9));
  const page = Math.max(1, Number(req.query.page || 1));

  const countRes = await query(`SELECT COUNT(*)::int AS total FROM news_articles`).catch(() => ({ rows: [{ total: 0 }] }));
  const totalItems = Number(countRes.rows[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
  const safePage = Math.min(page, totalPages);
  const offset = (safePage - 1) * perPage;

  const result = await query(
    `SELECT id, title, body, translated_title, translated_body, analysis, source_name, source_url, image_url, category_name, published_at, created_at, lang_texts
     FROM news_articles
     ORDER BY COALESCE(published_at, created_at) DESC
     LIMIT $1 OFFSET $2`,
    [perPage, offset]
  ).catch(() => ({ rows: [] }));

  const news = result.rows.map((row) => {
    const langTexts = row.lang_texts || {};
    const picked = langTexts[currentLang] || {};

    return {
      id: row.id,
      title: currentLang === 'en' ? (picked.title || row.title) : row.title,
      body: currentLang === 'en' ? (picked.body || row.body) : row.body,
      translatedTitle:
        picked.title ||
        (currentLang === 'th' ? (row.translated_title || row.title) : row.translated_title),
      translatedBody:
        picked.body ||
        (currentLang === 'th' ? (row.translated_body || row.body) : row.translated_body),
      analysis: row.analysis,
      source: row.source_name,
      url: row.source_url,
      imageUrl: row.image_url,
      category: row.category_name,
      createdAt: row.published_at || row.created_at
    };
  });

  return res.render('news', getCommonViewData(req, {
    title: 'News | TRADING AVELQUA',
    currentPath: '/news',
    news,
    newsSettings: settings,
    pagination: { page: safePage, perPage, totalItems, totalPages }
  }));
});

module.exports = router;
