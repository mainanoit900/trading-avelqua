const fs = require('fs');
const path = require('path');

const localesPath = path.join(__dirname, '..', 'locales');
const SUPPORTED_LOCALES = ['th', 'en', 'lo', 'vi', 'my'];
const DEFAULT_LOCALE = 'th';

function normalizeLocale(locale) {
  const value = String(locale || DEFAULT_LOCALE).toLowerCase().trim();
  return SUPPORTED_LOCALES.includes(value) ? value : DEFAULT_LOCALE;
}

function loadLocale(locale) {
  try {
    return JSON.parse(fs.readFileSync(path.join(localesPath, `${locale}.json`), 'utf8'));
  } catch {
    return {};
  }
}

function buildCache() {
  const cache = {};
  for (const locale of SUPPORTED_LOCALES) {
    cache[locale] = loadLocale(locale);
  }
  return cache;
}

function reloadLocaleCache() {
  const fresh = buildCache();
  for (const locale of SUPPORTED_LOCALES) {
    localeCache[locale] = fresh[locale];
  }
}

const localeCache = buildCache();

function getValue(dict, key) {
  if (!dict || !key) return undefined;
  if (Object.prototype.hasOwnProperty.call(dict, key)) return dict[key];
  return undefined;
}

function translate(lang, key, fallback = '') {
  const locale = normalizeLocale(lang);
  const current = getValue(localeCache[locale], key);
  if (current !== undefined && current !== null && current !== '') return current;
  const enFallback = getValue(localeCache.en, key);
  if (enFallback !== undefined && enFallback !== null && enFallback !== '') return enFallback;
  const thFallback = getValue(localeCache.th, key);
  if (thFallback !== undefined && thFallback !== null && thFallback !== '') return thFallback;
  return fallback || key;
}

function withLang(url, lang) {
  try {
    const [base, queryString = ''] = String(url || '/').split('?');
    const params = new URLSearchParams(queryString);
    params.set('lang', normalizeLocale(lang));
    const next = params.toString();
    return `${base}${next ? `?${next}` : ''}`;
  } catch {
    return `/?lang=${normalizeLocale(lang)}`;
  }
}

function languageMiddleware(req, res, next) {
  const lang = normalizeLocale(req.query.lang || req.session?.lang || DEFAULT_LOCALE);
  if (req.session) req.session.lang = lang;
  req.lang = lang;
  res.locals.lang = lang;
  res.locals.supportedLocales = SUPPORTED_LOCALES;
  res.locals.localeLabels = {
    th: 'ไทย',
    en: 'English',
    lo: 'ລາວ',
    vi: 'Tiếng Việt',
    my: 'မြန်မာ'
  };
  res.locals.clientLocales = localeCache;
  res.locals.t = (key, fallback = '') => translate(lang, key, fallback);
  res.locals.switchLangUrl = (targetLang) => withLang(req.originalUrl || req.url || '/', targetLang);
  next();
}

module.exports = {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  localeCache,
  normalizeLocale,
  translate,
  languageMiddleware,
  withLang,
  reloadLocaleCache
};
