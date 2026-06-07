(function () {
  const cfg = window.__AVELQUA_SESSION_IDLE__;
  if (!cfg || !cfg.enabled) return;

  const IDLE_MS = Number(cfg.idleMs) > 0 ? Number(cfg.idleMs) : 2 * 60 * 60 * 1000;
  const LOGOUT_URL = cfg.logoutUrl || '/logout?reason=idle';
  const PING_URL = '/api/session/activity';
  const CHECK_MS = 60000;
  const THROTTLE_MS = 60000;
  const ACTIVITY_KEY = 'avelqua_last_user_activity';
  const STAMP_KEY = 'avelqua_idle_session_stamp';

  let lastPingAt = 0;
  let loggingOut = false;

  function getSessionStamp() {
    return String(cfg.sessionStamp || '');
  }

  function ensureSessionStamp() {
    const stamp = getSessionStamp();
    if (!stamp) return;
    if (localStorage.getItem(STAMP_KEY) !== stamp) {
      localStorage.setItem(STAMP_KEY, stamp);
      localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
    }
  }

  function getLastActivity() {
    ensureSessionStamp();
    const value = Number(localStorage.getItem(ACTIVITY_KEY));
    return Number.isFinite(value) && value > 0 ? value : Date.now();
  }

  function setLastActivity(ts) {
    localStorage.setItem(ACTIVITY_KEY, String(ts));
  }

  function pingServer() {
    fetch(PING_URL, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
    }).catch(function () {});
  }

  function bumpActivity() {
    const now = Date.now();
    setLastActivity(now);
    if (now - lastPingAt < THROTTLE_MS) return;
    lastPingAt = now;
    pingServer();
  }

  function performLogout() {
    if (loggingOut) return;
    loggingOut = true;
    localStorage.removeItem(ACTIVITY_KEY);
    localStorage.removeItem(STAMP_KEY);
    window.location.href = LOGOUT_URL;
  }

  function checkIdle() {
    ensureSessionStamp();
    if (Date.now() - getLastActivity() >= IDLE_MS) {
      performLogout();
    }
  }

  ensureSessionStamp();
  setLastActivity(Date.now());
  pingServer();

  ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'].forEach(function (eventName) {
    document.addEventListener(eventName, bumpActivity, { passive: true });
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      checkIdle();
      bumpActivity();
    }
  });

  window.addEventListener('storage', function (event) {
    if (event.key === ACTIVITY_KEY || event.key === STAMP_KEY) {
      checkIdle();
    }
  });

  window.setInterval(checkIdle, CHECK_MS);
  checkIdle();
})();
