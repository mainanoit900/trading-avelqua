(function () {
  const store = window.__AVELQUA_I18N__ || {};
  const labels = store.labels || {};
  const locales = store.locales || {};
  const mode = store.mode || 'live';
  let current = store.current || 'th';

  function translate(lang, key, fallback) {
    const currentDict = locales[lang] || {};
    const enDict = locales.en || {};
    const thDict = locales.th || {};
    return currentDict[key] || enDict[key] || thDict[key] || fallback || key;
  }

  function applyI18n(lang) {
    current = lang;
    document.documentElement.lang = lang;

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = (el.getAttribute('data-i18n') || '').trim();
      if (!key) return;
      const fallback = el.getAttribute('data-i18n-fallback') || el.textContent.trim();
      el.textContent = translate(lang, key, fallback);
    });

    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      const fallback = el.getAttribute('placeholder') || '';
      el.setAttribute('placeholder', translate(lang, key, fallback));
    });

    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      const fallback = el.getAttribute('title') || '';
      el.setAttribute('title', translate(lang, key, fallback));
    });

    document.querySelectorAll('[data-lang-option]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.langCode === lang);
    });

    const currentLabel = document.getElementById('langCurrentLabel');
    if (currentLabel) currentLabel.textContent = labels[lang] || lang.toUpperCase();
  }

  async function switchLanguage(lang) {
    const response = await fetch('/api/i18n/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ lang })
    });

    if (!response.ok) throw new Error('switch failed');
    const payload = await response.json();
    const nextLang = payload.lang || lang;
    applyI18n(nextLang);
    if (mode === 'reload') {
      window.location.reload();
      return;
    }
  }

  function setupDropdown() {
    const root = document.getElementById('langDropdown');
    const trigger = document.getElementById('langDropdownBtn');
    const menu = document.getElementById('langDropdownMenu');
    if (!root || !trigger || !menu) return;

    trigger.addEventListener('click', function (event) {
      event.preventDefault();
      root.classList.toggle('open');
    });

    document.addEventListener('click', function (event) {
      if (!root.contains(event.target)) {
        root.classList.remove('open');
      }
    });

    menu.querySelectorAll('[data-lang-option]').forEach((button) => {
      button.addEventListener('click', async function () {
        const lang = button.dataset.langCode;
        root.classList.remove('open');
        button.disabled = true;
        try {
          await switchLanguage(lang);
        } catch (error) {
          console.error('Language switch error:', error);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  window.AvelquaI18n = { applyI18n, switchLanguage };

  document.addEventListener('DOMContentLoaded', function () {
    applyI18n(current);
    setupDropdown();
  });
})();
