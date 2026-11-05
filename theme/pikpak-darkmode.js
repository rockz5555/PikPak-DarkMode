/*!
 * PikPak Dark Mode - theme controller
 * Adds a small floating switcher (Light / Dark / System), persists the choice
 * in localStorage, and exposes window.PikPakTheme.
 *
 * The class that drives the stylesheet is `pikpak-dark` on <html>.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'pikpak-theme';
  var DARK_CLASS = 'pikpak-dark';
  var GITHUB_USER = 'rockz5555';
  var AVATAR_URL = 'https://github.com/' + GITHUB_USER + '.png?size=96';
  var root = document.documentElement;

  // PikPak opens playback and the file manager in separate windows
  // (#player-container, #player-controller, #file-manager). Leave those
  // windows completely untouched: no dark class, no floating switcher.
  var isExcludedWindow = /^#(?:player|file-manager)\b/.test(window.location.hash || '');

  // The magnet-link landing popup (#/landing) follows the saved theme so it
  // matches the main window, but it never gets the floating switcher. It has
  // its own dedicated skin and a close button instead.
  var isLandingWindow = /^#\/landing(?:[\/?]|$)/.test(window.location.hash || '');

  var media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function readStoredMode() {
    try {
      var v = window.localStorage.getItem(STORAGE_KEY);
      if (v === 'light' || v === 'dark' || v === 'system') return v;
    } catch (e) { /* storage may be unavailable */ }
    return 'system';
  }

  function prefersDark() {
    return !!(media && media.matches);
  }

  function resolve(mode) {
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return prefersDark();
  }

  var mode = readStoredMode();

  function applyMode(nextMode, persist) {
    mode = nextMode;
    if (isExcludedWindow) return;
    var dark = resolve(mode);
    root.classList.toggle(DARK_CLASS, dark);
    root.setAttribute('data-pikpak-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-pikpak-theme-mode', mode);
    if (persist !== false) {
      try { window.localStorage.setItem(STORAGE_KEY, mode); } catch (e) { /* ignore */ }
    }
    syncUI();
    try {
      window.dispatchEvent(new CustomEvent('pikpak-theme-change', {
        detail: { mode: mode, dark: dark }
      }));
    } catch (e) { /* ignore */ }
  }

  /* ---------- floating switcher ---------- */

  var ui = null;
  var panel = null;

  var ICONS = {
    sun: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 1.8v2.6M12 19.6v2.6M1.8 12h2.6M19.6 12h2.6M4.8 4.8l1.9 1.9M17.3 17.3l1.9 1.9M19.2 4.8l-1.9 1.9M6.7 17.3l-1.9 1.9"/></g></svg>',
    moon: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20.4 14.6A8.7 8.7 0 0 1 9.4 3.6a8.7 8.7 0 1 0 11 11z" fill="currentColor"/></svg>',
    auto: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="8.4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3.6a8.4 8.4 0 0 1 0 16.8z" fill="currentColor"/></svg>',
    shield: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 2.7v5.5c0 4.1-2.8 7.2-7 8.8-4.2-1.6-7-4.7-7-8.8V5.7z"/><path d="M8.7 12.1l2.2 2.2 4.4-4.6"/></svg>',
    github: '<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    paypal: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.254-.93 4.778-4.005 7.201-9.138 7.201h-2.19a.563.563 0 0 0-.556.479l-1.187 7.527h-.506l-.24 1.516a.56.56 0 0 0 .554.647h3.882c.46 0 .85-.334.922-.788.06-.26.76-4.852.816-5.09a.932.932 0 0 1 .923-.788h.58c3.76 0 6.705-1.528 7.565-5.946.36-1.847.174-3.388-.777-4.471z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7M9 7h8v8"/></svg>',
    heart: '<svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" fill="currentColor"><path d="M12 21s-6.7-4.35-9.33-8.09C.9 9.94 2.07 6.5 5.2 5.5c1.9-.6 3.9.06 5.1 1.6L12 8.6l1.7-1.5c1.2-1.54 3.2-2.2 5.1-1.6 3.13 1 4.3 4.44 2.53 7.41C18.7 16.65 12 21 12 21z"/></svg>'
  };

  function ensureUI() {
    if (isExcludedWindow || isLandingWindow || ui || !document.body) return;
    if (document.getElementById('ppdm-toggle')) { ui = document.getElementById('ppdm-toggle'); return; }

    ui = document.createElement('div');
    ui.id = 'ppdm-toggle';
    ui.setAttribute('role', 'button');
    ui.setAttribute('tabindex', '0');
    ui.setAttribute('aria-label', 'Change theme');
    ui.title = 'Theme (Ctrl+Shift+D)';
    ui.innerHTML = '<span class="ppdm-toggle-icon"></span><span class="ppdm-update-dot" aria-hidden="true"></span>';

    panel = document.createElement('div');
    panel.id = 'ppdm-panel';
    panel.setAttribute('role', 'menu');
    panel.setAttribute('aria-label', 'Theme');
    panel.innerHTML =
      '<div class="ppdm-panel-title">Theme</div>' +
      '<button type="button" class="ppdm-option" data-mode="light">' + ICONS.sun + '<span>Light</span></button>' +
      '<button type="button" class="ppdm-option" data-mode="dark">' + ICONS.moon + '<span>Dark</span></button>' +
      '<button type="button" class="ppdm-option" data-mode="system">' + ICONS.auto + '<span>System</span></button>' +
      '<div class="ppdm-panel-divider"></div>' +
      '<div class="ppdm-author">' +
        '<div class="ppdm-avatar" aria-hidden="true">' +
          '<span class="ppdm-avatar-ring"></span>' +
          '<span class="ppdm-avatar-face">N<img class="ppdm-avatar-img" alt="" decoding="async" referrerpolicy="no-referrer"></span>' +
          '<i class="ppdm-avatar-status"></i>' +
        '</div>' +
        '<div class="ppdm-author-info">' +
          '<div class="ppdm-author-name">' +
            '<span class="ppdm-author-name-text">Nijoo</span>' +
            '<span class="ppdm-author-tag">author</span>' +
          '</div>' +
          '<div class="ppdm-author-role">The dark side of PikPak</div>' +
        '</div>' +
      '</div>' +
      '<a class="ppdm-author-link" href="https://github.com/rockz5555/PikPak-DarkMode" target="_blank" rel="noopener noreferrer" title="View PikPak-DarkMode on GitHub">' +
        ICONS.github + '<span class="ppdm-author-repo">PikPak-DarkMode</span>' + ICONS.arrow +
      '</a>' +
      '<a class="ppdm-donate" href="https://www.paypal.me/nizwer" target="_blank" rel="noopener noreferrer" title="Support this project via PayPal">' +
        ICONS.paypal + '<span class="ppdm-donate-label">Donate via PayPal</span>' +
      '</a>' +
      '<div class="ppdm-compat" data-compat hidden>' +
        '<span class="ppdm-compat-shield" aria-hidden="true">' + ICONS.shield + '</span>' +
        '<span class="ppdm-compat-copy">' +
          '<span class="ppdm-compat-head">' +
            '<span class="ppdm-compat-label">PikPak</span>' +
            '<span class="ppdm-compat-app"></span>' +
          '</span>' +
          '<span class="ppdm-compat-foot">' +
            '<span class="ppdm-compat-sub"></span>' +
            '<span class="ppdm-compat-pill"><i></i>Tested</span>' +
          '</span>' +
        '</span>' +
      '</div>' +
      '<button type="button" class="ppdm-version-row" data-tone="" title="Check for theme updates">' +
        '<span class="ppdm-version-dot" aria-hidden="true"></span>' +
        '<span class="ppdm-version-text">Theme</span>' +
        '<span class="ppdm-version-status">Check for updates</span>' +
      '</button>' +
      '<div class="ppdm-signature">Made with <span class="ppdm-heart">' + ICONS.heart + '</span> for the PikPak community</div>';

    ui.appendChild(panel);
    document.body.appendChild(ui);

    // Live GitHub avatar: fetched on each launch (cache-busted) so changes on
    // github.com show up here. Falls back to the gradient "N" if it fails.
    var avatarImg = ui.querySelector('.ppdm-avatar-img');
    if (avatarImg) {
      avatarImg.addEventListener('load', function () {
        avatarImg.classList.add('is-loaded');
      });
      avatarImg.addEventListener('error', function () {
        if (avatarImg.parentNode) avatarImg.parentNode.removeChild(avatarImg);
      });
      avatarImg.src = AVATAR_URL + '&t=' + Date.now();
    }

    ui.addEventListener('click', function (ev) {
      var opt = ev.target.closest ? ev.target.closest('.ppdm-option') : null;
      if (opt) {
        applyMode(opt.getAttribute('data-mode'));
        closePanel();
        ev.stopPropagation();
        return;
      }
      var versionRow = ev.target.closest ? ev.target.closest('.ppdm-version-row') : null;
      if (versionRow) {
        if (window.PikPakUpdater) {
          window.PikPakUpdater.check({ force: true, interactive: true });
          closePanel();
        }
        ev.stopPropagation();
        return;
      }
      // Clicks on the panel title or padding should not toggle it closed.
      if (panel && panel.contains(ev.target)) {
        ev.stopPropagation();
        return;
      }
      togglePanel();
      ev.stopPropagation();
    });

    ui.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); togglePanel(); }
      if (ev.key === 'Escape') closePanel();
    });

    document.addEventListener('click', closePanel);

    syncCompat();
  }

  /* ---------- route / modal state ---------- */

  // Element Plus keeps its overlays in the DOM and hides them with
  // display:none, so `:has(.el-overlay)` cannot be used to detect them: it
  // would treat a hidden overlay as an open dialog. Poll for one that is
  // really visible instead and mark the root element while it is open.
  function isModalOpen() {
    var overlays = document.querySelectorAll('.el-overlay');
    for (var i = 0; i < overlays.length; i++) {
      var el = overlays[i];
      if (el.getAttribute('aria-hidden') === 'true') continue;
      var inline = el.getAttribute('style') || '';
      if (inline.indexOf('display: none') !== -1) continue;
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      var rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return true;
    }
    return false;
  }

  var lastModalOpen = null;
  function syncModal() {
    var open = isModalOpen();
    if (open === lastModalOpen) return;
    lastModalOpen = open;
    root.classList.toggle('ppdm-modal-open', open);
    if (open) closePanel();
  }

  var lastRoute = null;
  function syncRoute() {
    var route = location.hash || '#/';
    if (route !== lastRoute) {
      lastRoute = route;
      root.setAttribute('data-pikpak-route', route);
      closePanel();
    }
  }

  var watchersStarted = false;
  function startWatchers() {
    if (watchersStarted) return;
    watchersStarted = true;
    syncRoute();
    syncModal();
    window.addEventListener('hashchange', syncRoute);
    window.addEventListener('popstate', syncRoute);
    // Vue Router can navigate with pushState/replaceState, which fires no
    // hashchange event; a light poll keeps the route attribute accurate and
    // notices modal dialogs that open or close without a route change.
    setInterval(function () { syncRoute(); syncModal(); }, 1000);
  }

  /* ---------- landing chrome ---------- */

  function ensureLandingChrome() {
    if (!isLandingWindow || !document.body) return;
    if (document.getElementById('ppdm-landing-close')) return;
    var btn = document.createElement('button');
    btn.id = 'ppdm-landing-close';
    btn.type = 'button';
    btn.title = 'Close';
    btn.setAttribute('aria-label', 'Close');
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    btn.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      window.close();
    });
    document.body.appendChild(btn);
  }

  function syncUI() {
    if (!ui) return;
    var dark = resolve(mode);
    ui.setAttribute('data-theme', dark ? 'dark' : 'light');
    var icon = ui.querySelector('.ppdm-toggle-icon');
    if (icon) icon.innerHTML = dark ? ICONS.moon : ICONS.sun;
    ui.setAttribute('aria-label', 'Theme: ' + mode);
    if (panel) {
      var opts = panel.querySelectorAll('.ppdm-option');
      for (var i = 0; i < opts.length; i++) {
        opts[i].classList.toggle('is-active', opts[i].getAttribute('data-mode') === mode);
      }
    }
  }

  /* ---------- version + update status ---------- */

  function installedVersion() {
    var manifest = window.PIKPAK_DARKMODE_VERSION;
    if (manifest && manifest.version) return String(manifest.version);
    return '';
  }

  /* ---------- last patched PikPak build ---------- */

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var compatRetries = 0;

  // The installer records the exact build it patched in the injected block.
  // Fall back to the release tag PikPak itself exposes (SENTRY_RELEASE) and
  // finally to an optional manifest field, so the card still works for builds
  // installed before this feature existed.
  function patchInfo() {
    var patch = window.__PPDM_PATCH__ || {};
    var app = patch.app ? String(patch.app) : '';
    var at = patch.at ? String(patch.at) : '';

    if (!app) {
      var release = window.SENTRY_RELEASE && window.SENTRY_RELEASE.id;
      var match = release ? String(release).match(/@([0-9][0-9A-Za-z.\-]+)$/) : null;
      if (match) app = match[1];
    }
    if (!app) {
      var manifest = window.PIKPAK_DARKMODE_VERSION;
      if (manifest && manifest.pikpak) app = String(manifest.pikpak);
    }
    return { app: app, at: at };
  }

  function formatPatchDate(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value || '');
    if (!match) return '';
    var month = MONTHS[Number(match[2]) - 1];
    if (!month) return '';
    return Number(match[3]) + ' ' + month + ' ' + match[1];
  }

  function syncCompat() {
    var host = panel || document.getElementById('ppdm-panel');
    if (!host) return;
    var card = host.querySelector('.ppdm-compat');
    if (!card) return;

    var info = patchInfo();
    if (!info.app) {
      // PikPak sets SENTRY_RELEASE during its own bootstrap; retry briefly.
      if (compatRetries < 6) {
        compatRetries += 1;
        setTimeout(syncCompat, 800);
      }
      return;
    }

    var appNode = card.querySelector('.ppdm-compat-app');
    var subNode = card.querySelector('.ppdm-compat-sub');
    var date = formatPatchDate(info.at);
    if (appNode) appNode.textContent = info.app;
    if (subNode) {
      subNode.textContent = date
        ? 'Last patched ' + date
        : 'Verified against this PikPak build';
    }
    card.title = 'This theme was last applied to PikPak ' + info.app +
      (date ? ' on ' + date : '') + '.';
    card.hidden = false;
  }

  // The updater owns detection; this row only mirrors the state it reports so
  // the panel stays useful (and honest) even when the updater is unavailable.
  function syncUpdateRow(detail) {
    var host = panel || document.getElementById('ppdm-panel');
    if (!host) return;
    var row = host.querySelector('.ppdm-version-row');
    if (!row) return;

    var version = installedVersion();
    var text = row.querySelector('.ppdm-version-text');
    var status = row.querySelector('.ppdm-version-status');
    if (text) text.textContent = version ? 'v' + version : 'Theme';

    var state = detail && detail.state ? detail.state : 'idle';
    var available = detail && detail.available ? detail.available : '';
    var tone = '';
    var label = 'Check for updates';

    if (state === 'checking') { label = 'Checking...'; tone = 'busy'; }
    else if (state === 'available' || state === 'downloading' || state === 'verifying' || state === 'installing') {
      label = available ? 'v' + available + ' available' : 'Update available';
      tone = 'update';
    } else if (state === 'success' || state === 'restarting') { label = 'Updated'; tone = 'ok'; }
    else if (state === 'uptodate') { label = 'Up to date'; tone = 'ok'; }
    else if (state === 'skipped') { label = 'Skipped' + (detail.skipped ? ' v' + detail.skipped : ''); tone = 'muted'; }
    else if (state === 'error') { label = 'Check failed'; tone = 'warn'; }

    if (status) status.textContent = label;
    row.setAttribute('data-tone', tone);

    if (ui) {
      ui.classList.toggle('has-update', tone === 'update');
      ui.classList.toggle('is-checking', tone === 'busy');
    }
  }

  window.addEventListener('ppdm-update-state', function (ev) {
    syncUpdateRow(ev.detail);
  });

  function togglePanel() {
    if (!ui) return;
    ui.classList.toggle('is-open');
  }

  function closePanel() {
    if (ui) ui.classList.remove('is-open');
  }

  /* ---------- keyboard shortcut ---------- */

  document.addEventListener('keydown', function (ev) {
    if (ev.ctrlKey && ev.shiftKey && (ev.key === 'D' || ev.key === 'd')) {
      ev.preventDefault();
      applyMode(resolve(mode) ? 'light' : 'dark');
    }
    if (ev.key === 'Escape') {
      closePanel();
      // Escape closes the landing popup, unless a picker/dialog is open.
      if (isLandingWindow && !isModalOpen()) window.close();
    }
  });

  /* ---------- system preference changes ---------- */

  if (media) {
    var onSystemChange = function () { if (mode === 'system') applyMode('system', false); };
    if (media.addEventListener) media.addEventListener('change', onSystemChange);
    else if (media.addListener) media.addListener(onSystemChange);
  }

  /* ---------- public API ---------- */

  window.PikPakTheme = {
    set: function (m) { applyMode(m); },
    get: function () { return { mode: mode, dark: resolve(mode) }; },
    toggle: function () { applyMode(resolve(mode) ? 'light' : 'dark'); },
    light: function () { applyMode('light'); },
    dark: function () { applyMode('dark'); },
    system: function () { applyMode('system'); },
    key: STORAGE_KEY
  };

  /* ---------- boot ---------- */

  function boot() {
    applyMode(mode, false);
    ensureUI();
    ensureLandingChrome();
    startWatchers();
    syncUI();
    syncUpdateRow(null);
  }

  // The class is set by the inline boot snippet as early as possible; this
  // re-applies it (in case that snippet was skipped), builds the switcher and
  // starts the route/modal watchers.
  applyMode(mode, false);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      ensureUI();
      ensureLandingChrome();
      startWatchers();
      syncUI();
      syncUpdateRow(null);
    });
  } else {
    boot();
  }
})();
