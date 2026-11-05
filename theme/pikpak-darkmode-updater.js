/*!
 * PikPak Dark Mode - in-app updater
 * ---------------------------------------------------------------------------
 * Checks the release manifest on GitHub, diffs it against the installed
 * manifest (theme/pikpak-darkmode.version.js), downloads ONLY the changed
 * files, verifies every SHA-256, and hands the staged bytes to the local
 * update helper (agent/ppdm-update-agent.ps1) which performs the atomic swap
 * next to PikPak's renderer.
 *
 * The panel is deliberately small and non-blocking: it never covers the app,
 * it hides on player / file-manager / landing routes, and it follows the
 * active light or dark theme.
 *
 * Public API: window.PikPakUpdater
 * ---------------------------------------------------------------------------
 */
(function () {
  'use strict';

  if (window.PikPakUpdater) return;

  /* ------------------------------------------------------------------ */
  /* configuration                                                      */
  /* ------------------------------------------------------------------ */

  var REPO = 'rockz5555/PikPak-DarkMode';
  var BRANCH = 'master';

  // Mirror order: raw is freshest, the CDN is the fallback when raw is slow
  // or blocked. Both serve the same files from the same commit.
  var MIRRORS = [
    'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/',
    'https://cdn.jsdelivr.net/gh/' + REPO + '@' + BRANCH + '/'
  ];

  var SOURCE_KEY = 'ppdm-update-source';   // optional base URL override (forks/testing)
  var STATE_KEY = 'ppdm-update-state';     // lastCheck, skippedVersion
  var PENDING_KEY = 'ppdm-update-pending'; // written before install, read after reload
  var DISMISS_KEY = 'ppdm-update-dismissed';

  var CHECK_EVERY = 6 * 60 * 60 * 1000;    // automatic re-check window
  var BOOT_DELAY = 5000;                   // let the app finish starting first
  var REQUEST_TIMEOUT = 15000;
  var DOWNLOAD_TIMEOUT = 45000;
  var AGENT_TIMEOUT = 2500;
  var MAX_NOTES = 3;

  var hash = window.location.hash || '';
  var isExcluded =
    /^#(?:player|file-manager)\b/.test(hash) ||
    /^#\/landing(?:[\/?]|$)/.test(hash);

  var ICONS = {
    update:
      '<svg class="ppdm-i-update" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M21 3v5h-5" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M8 16H3v5" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>',
    check:
      '<svg class="ppdm-i-check" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
      '<path d="M4.6 12.4l4.6 4.6L19.4 6.8" fill="none" stroke="currentColor" stroke-width="2.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn:
      '<svg class="ppdm-i-warn" viewBox="0 0 24 24" width="19" height="19" aria-hidden="true">' +
      '<path d="M12 2.8l9.4 16.4H2.6z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M12 9v4.4M12 16.6h.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    arrow:
      '<svg class="ppdm-update-arrow" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
      '<path d="M4 12h14M12 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2.2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>',
    shield:
      '<svg class="ppdm-i-shield" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">' +
      '<path d="M12 3l7 2.7v5.5c0 4.1-2.8 7.2-7 8.8-4.2-1.6-7-4.7-7-8.8V5.7z" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>' +
      '<path d="M8.7 12.1l2.2 2.2 4.4-4.6" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  /* ------------------------------------------------------------------ */
  /* small utilities                                                    */
  /* ------------------------------------------------------------------ */

  function noop() {}

  function readJSON(storage, key, fallback) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  function formatBytes(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) {
      var kb = n / 1024;
      return (kb < 10 ? kb.toFixed(1) : Math.round(kb)) + ' KB';
    }
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatRate(bytesPerSecond) {
    if (!bytesPerSecond || bytesPerSecond < 1) return '';
    return formatBytes(bytesPerSecond) + '/s';
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 1) return 'almost done';
    if (seconds < 60) return Math.ceil(seconds) + 's left';
    return Math.ceil(seconds / 60) + 'm left';
  }

  /* ------------------------------------------------------------------ */
  /* version + delta engine (pure, also exposed for debugging)           */
  /* ------------------------------------------------------------------ */

  function compareVersions(a, b) {
    var left = String(a || '0').trim().split('-');
    var right = String(b || '0').trim().split('-');
    var leftParts = left[0].split('.');
    var rightParts = right[0].split('.');
    var len = Math.max(leftParts.length, rightParts.length);
    for (var i = 0; i < len; i++) {
      var x = parseInt(leftParts[i], 10);
      var y = parseInt(rightParts[i], 10);
      if (isNaN(x)) x = 0;
      if (isNaN(y)) y = 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    // A pre-release (1.2.0-beta.1) sorts before the matching stable release.
    if (left[1] && !right[1]) return -1;
    if (!left[1] && right[1]) return 1;
    return 0;
  }

  /**
   * Compare the installed file table with the released one and describe what
   * actually has to move over the wire.
   */
  function planUpdate(localFiles, remoteFiles) {
    var changed = [];
    var unchanged = 0;
    var totalBytes = 0;
    var downloadBytes = 0;
    var names = Object.keys(remoteFiles || {});

    names.sort();

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var remote = remoteFiles[name] || {};
      var size = Number(remote.size) || 0;
      var local = localFiles ? localFiles[name] : null;
      totalBytes += size;
      var same =
        local &&
        remote.sha256 &&
        String(local.sha256).toLowerCase() === String(remote.sha256).toLowerCase();
      if (same) {
        unchanged++;
      } else {
        changed.push({
          name: name,
          sha256: String(remote.sha256 || '').toLowerCase(),
          size: size
        });
        downloadBytes += size;
      }
    }

    return {
      changed: changed,
      unchanged: unchanged,
      totalFiles: names.length,
      totalBytes: totalBytes,
      downloadBytes: downloadBytes,
      savedBytes: Math.max(0, totalBytes - downloadBytes)
    };
  }

  function installedInfo() {
    var local = window.PIKPAK_DARKMODE_VERSION;
    if (!local || typeof local !== 'object') {
      return { version: '0.0.0', bootstrap: 0, released: '', files: {} };
    }
    return {
      version: String(local.version || '0.0.0'),
      bootstrap: Number(local.bootstrap) || 0,
      released: String(local.released || ''),
      files: local.files && typeof local.files === 'object' ? local.files : {}
    };
  }

  // Same source order as the theme panel: installer-injected value first, then
  // PikPak's own release tag, then an optional manifest field.
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

  /* ------------------------------------------------------------------ */
  /* crypto                                                             */
  /* ------------------------------------------------------------------ */

  function sha256Hex(bytes) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || !subtle.digest) return Promise.resolve('');
    return subtle.digest('SHA-256', bytes).then(function (buffer) {
      var view = new Uint8Array(buffer);
      var out = '';
      for (var i = 0; i < view.length; i++) {
        out += ('0' + view[i].toString(16)).slice(-2);
      }
      return out;
    }, function () {
      return '';
    });
  }

  function toBase64(bytes) {
    var chunk = 0x8000;
    var parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return window.btoa(parts.join(''));
  }

  /* ------------------------------------------------------------------ */
  /* network                                                            */
  /* ------------------------------------------------------------------ */

  var activeRequest = null;

  function request(url, options) {
    options = options || {};
    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () {
      timedOut = true;
      if (controller) controller.abort();
    }, options.timeout || REQUEST_TIMEOUT);

    var init = { cache: 'no-store', credentials: 'omit', mode: 'cors' };
    if (options.method) init.method = options.method;
    if (options.headers) init.headers = options.headers;
    if (options.body) init.body = options.body;
    if (controller) {
      init.signal = controller.signal;
      activeRequest = controller;
    }

    return fetch(url, init).then(function (response) {
      clearTimeout(timer);
      if (!response.ok) throw new Error('http-' + response.status);
      return response;
    }, function () {
      clearTimeout(timer);
      throw new Error(timedOut ? 'timeout' : 'network');
    });
  }

  function sourceRoots() {
    var override = '';
    try { override = window.localStorage.getItem(SOURCE_KEY) || ''; } catch (e) { override = ''; }
    if (override) {
      if (override.charAt(override.length - 1) !== '/') override += '/';
      return [override];
    }
    return MIRRORS;
  }

  function fromMirrors(path, parseJSON) {
    var roots = sourceRoots();
    var index = 0;

    function attempt() {
      if (index >= roots.length) return Promise.reject(new Error('network'));
      var url = roots[index++] + path + '?v=' + Date.now();
      return request(url, { timeout: REQUEST_TIMEOUT }).then(function (response) {
        return parseJSON ? response.json() : response;
      }).catch(function () {
        return attempt();
      });
    }

    return attempt();
  }

  function downloadFile(root, file, onBytes) {
    var url = root + 'theme/' + file.name + '?v=' + Date.now();
    return request(url, { timeout: DOWNLOAD_TIMEOUT }).then(function (response) {
      if (response.body && response.body.getReader) {
        var reader = response.body.getReader();
        var chunks = [];
        var received = 0;

        function pump() {
          return reader.read().then(function (step) {
            if (step.done) {
              var out = new Uint8Array(received);
              var at = 0;
              for (var i = 0; i < chunks.length; i++) {
                out.set(chunks[i], at);
                at += chunks[i].length;
              }
              return out;
            }
            chunks.push(step.value);
            received += step.value.length;
            onBytes(step.value.length);
            return pump();
          });
        }

        return pump();
      }
      // Older Chromium without streaming bodies: one shot, then report size.
      return response.arrayBuffer().then(function (buffer) {
        var bytes = new Uint8Array(buffer);
        onBytes(bytes.length);
        return bytes;
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* local update helper                                                */
  /* ------------------------------------------------------------------ */

  function agentConfig() {
    var agent = window.__PPDM_AGENT__;
    if (!agent || !agent.port) return null;
    return {
      base: 'http://127.0.0.1:' + agent.port,
      token: String(agent.token || '')
    };
  }

  function agentPost(path, payload) {
    var agent = agentConfig();
    if (!agent) return Promise.reject(new Error('agent-missing'));
    return request(agent.base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: 120000
    }).then(function (response) {
      return response.json();
    }).catch(function (error) {
      throw new Error(error && error.message === 'timeout' ? 'agent-timeout' : 'agent-offline');
    }).then(function (body) {
      if (!body || body.ok !== true) {
        throw new Error((body && body.error) || 'install-failed');
      }
      return body;
    });
  }

  function probeAgent() {
    var agent = agentConfig();
    if (!agent) return Promise.resolve(false);
    return request(agent.base + '/health', { timeout: AGENT_TIMEOUT })
      .then(function (response) { return response.json(); })
      .then(function (body) { return !!(body && body.ok); })
      .catch(function () { return false; });
  }

  /* ------------------------------------------------------------------ */
  /* view state                                                         */
  /* ------------------------------------------------------------------ */

  var refs = {};
  var currentRemote = null;
  var currentPlan = null;
  var lastRestart = false;
  var busy = false;
  var checking = null;
  var hideTimer = null;
  var agentOnline = null;
  var cancelRequested = false;

  function template() {
    return '' +
      '<div class="ppdm-update-card" role="status" aria-live="polite">' +
        '<span class="ppdm-update-glow" aria-hidden="true"></span>' +
        '<div class="ppdm-update-head">' +
          '<span class="ppdm-update-badge" aria-hidden="true">' +
            ICONS.update + ICONS.check + ICONS.warn +
          '</span>' +
          '<div class="ppdm-update-headtext">' +
            '<div class="ppdm-update-brand">PikPak Dark Mode</div>' +
            '<div class="ppdm-update-subline">' +
              '<span class="ppdm-update-status">Update available</span>' +
              '<span class="ppdm-update-versions">' +
                '<span class="ppdm-update-from"></span>' +
                ICONS.arrow +
                '<span class="ppdm-update-to"></span>' +
              '</span>' +
              '<span class="ppdm-update-compat" hidden>' +
                ICONS.shield +
                '<span class="ppdm-update-compat-text"></span>' +
              '</span>' +
            '</div>' +
          '</div>' +
          '<button type="button" class="ppdm-update-close" data-action="close" ' +
            'aria-label="Dismiss update">&times;</button>' +
        '</div>' +
        '<div class="ppdm-update-savings">' +
          '<div class="ppdm-update-savings-bar"><i class="ppdm-update-savings-delta"></i></div>' +
          '<div class="ppdm-update-savings-text"></div>' +
        '</div>' +
        '<ul class="ppdm-update-notes"></ul>' +
        '<div class="ppdm-update-progress">' +
          '<div class="ppdm-update-steps">' +
            '<span class="ppdm-step" data-step="download"><i></i>Download</span>' +
            '<span class="ppdm-step" data-step="verify"><i></i>Verify</span>' +
            '<span class="ppdm-step" data-step="install"><i></i>Install</span>' +
          '</div>' +
          '<div class="ppdm-update-track"><i class="ppdm-update-fill"></i></div>' +
          '<div class="ppdm-update-meta">' +
            '<span class="ppdm-update-stage"></span>' +
            '<span class="ppdm-update-eta"></span>' +
          '</div>' +
        '</div>' +
        '<div class="ppdm-update-actions">' +
          '<button type="button" class="ppdm-btn is-primary" data-action="restart">Apply and restart</button>' +
          '<button type="button" class="ppdm-btn" data-action="apply">Apply</button>' +
          '<button type="button" class="ppdm-btn is-quiet" data-action="skip">Skip this version</button>' +
          '<button type="button" class="ppdm-btn is-quiet" data-action="cancel">Cancel</button>' +
          '<button type="button" class="ppdm-btn is-primary" data-action="reload">Reload now</button>' +
          '<button type="button" class="ppdm-btn" data-action="retry">Try again</button>' +
          '<button type="button" class="ppdm-btn is-quiet" data-action="dismiss">Later</button>' +
        '</div>' +
        '<div class="ppdm-update-foot"></div>' +
      '</div>';
  }

  function mount() {
    if (isExcluded || refs.root || !document.body) return;
    refs.root = document.createElement('div');
    refs.root.id = 'ppdm-update';
    refs.root.setAttribute('data-state', 'idle');
    refs.root.innerHTML = template();
    document.body.appendChild(refs.root);

    refs.card = refs.root.querySelector('.ppdm-update-card');
    refs.status = refs.root.querySelector('.ppdm-update-status');
    refs.versions = refs.root.querySelector('.ppdm-update-versions');
    refs.arrow = refs.root.querySelector('.ppdm-update-arrow');
    refs.from = refs.root.querySelector('.ppdm-update-from');
    refs.to = refs.root.querySelector('.ppdm-update-to');
    refs.compat = refs.root.querySelector('.ppdm-update-compat');
    refs.compatText = refs.root.querySelector('.ppdm-update-compat-text');
    refs.savings = refs.root.querySelector('.ppdm-update-savings');
    refs.savingsDelta = refs.root.querySelector('.ppdm-update-savings-delta');
    refs.savingsText = refs.root.querySelector('.ppdm-update-savings-text');
    refs.notes = refs.root.querySelector('.ppdm-update-notes');
    refs.progress = refs.root.querySelector('.ppdm-update-progress');
    refs.fill = refs.root.querySelector('.ppdm-update-fill');
    refs.stage = refs.root.querySelector('.ppdm-update-stage');
    refs.eta = refs.root.querySelector('.ppdm-update-eta');
    refs.foot = refs.root.querySelector('.ppdm-update-foot');

    syncCompatChip();

    refs.root.addEventListener('click', onAction);
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isVisible()) dismiss();
    });
  }

  function setText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  function syncCompatChip() {
    if (!refs.compat || !refs.compatText) return;
    var info = patchInfo();
    if (!info.app) return;
    refs.compatText.textContent = 'PikPak ' + info.app;
    refs.compat.title = 'This theme was last applied to PikPak ' + info.app +
      (info.at ? ' on ' + info.at : '') + '.';
    refs.compat.hidden = false;
  }

  // The version chips hide as a group when there is nothing to compare, so the
  // arrow never sits on its own.
  function setVersions(from, to) {
    if (!refs.versions) return;
    setText(refs.from, from || '');
    setText(refs.to, to || '');
    if (refs.arrow) refs.arrow.style.display = to ? '' : 'none';
    refs.versions.style.display = (from || to) ? '' : 'none';
  }

  function isVisible() {
    return !!(refs.root && refs.root.classList.contains('is-visible'));
  }

  function show() {
    if (!refs.root) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    refs.root.classList.add('is-visible');
    refs.root.classList.remove('is-leaving');
  }

  function hide() {
    if (!refs.root) return;
    refs.root.classList.add('is-leaving');
    refs.root.classList.remove('is-visible');
    setTimeout(function () {
      if (refs.root) refs.root.classList.remove('is-leaving');
    }, 260);
  }

  function autoHide(ms) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, ms);
  }

  function setState(name, data) {
    data = data || {};
    mount();
    if (!refs.root) return;
    refs.root.setAttribute('data-state', name);
    show();

    refs.root.setAttribute('data-restart', '');

    if (name === 'prompt') {
      refs.root.setAttribute('data-helper', agentConfig() ? '1' : '0');
      setText(refs.status, 'Update available');
      setVersions('v' + installedInfo().version, 'v' + (data.version || ''));
      renderNotes(data.notes || []);
      renderSavings(data.plan);
      refs.savings.style.display = '';
      refs.progress.style.display = 'none';
      setText(refs.foot, data.foot || '');
    } else if (name === 'downloading' || name === 'verifying' || name === 'installing') {
      setText(refs.status, 'Updating theme');
      refs.savings.style.display = 'none';
      refs.notes.style.display = 'none';
      refs.progress.style.display = '';
      refs.fill.style.width = (data.percent || 0) + '%';
      setText(refs.stage, data.stage || '');
      setText(refs.eta, data.eta || '');
      refs.root.setAttribute('data-step', data.step || 'download');
    } else if (name === 'success') {
      setText(refs.status, data.restart ? 'Restarting PikPak' : 'Update installed');
      refs.root.setAttribute('data-restart', data.restart ? '1' : '');
      refs.savings.style.display = 'none';
      refs.progress.style.display = 'none';
      renderNotes(data.notes || []);
      setText(refs.foot, data.foot || '');
    } else if (name === 'error') {
      setText(refs.status, data.title || 'Update failed');
      refs.savings.style.display = 'none';
      refs.progress.style.display = 'none';
      renderNotes([]);
      setText(refs.foot, data.message || '');
    } else if (name === 'checking') {
      setText(refs.status, 'Checking for updates');
      setVersions('', '');
      refs.savings.style.display = 'none';
      refs.notes.style.display = 'none';
      refs.progress.style.display = 'none';
      setText(refs.foot, '');
    } else if (name === 'uptodate') {
      setText(refs.status, 'You are up to date');
      setVersions('v' + (data.version || installedInfo().version), '');
      refs.savings.style.display = 'none';
      refs.notes.style.display = 'none';
      refs.progress.style.display = 'none';
      setText(refs.foot, '');
    }
  }

  function renderNotes(notes) {
    if (!refs.notes) return;
    refs.notes.style.display = '';
    refs.notes.innerHTML = '';
    for (var i = 0; i < notes.length && i < MAX_NOTES; i++) {
      var li = document.createElement('li');
      li.textContent = String(notes[i]);
      refs.notes.appendChild(li);
    }
    if (notes.length > MAX_NOTES) {
      var more = document.createElement('li');
      more.className = 'ppdm-update-note-more';
      more.textContent = '+' + (notes.length - MAX_NOTES) + ' more change' +
        (notes.length - MAX_NOTES === 1 ? '' : 's');
      refs.notes.appendChild(more);
    }
    if (!notes.length) refs.notes.style.display = 'none';
  }

  function renderSavings(plan) {
    if (!plan || !refs.savingsText) return;
    var pct = plan.totalBytes ? Math.round((plan.downloadBytes / plan.totalBytes) * 100) : 0;
    refs.savingsDelta.style.width = Math.max(4, pct) + '%';
    var text = 'Only ' + plan.changed.length + ' of ' + plan.totalFiles + ' files · ' +
      formatBytes(plan.downloadBytes) + ' instead of ' + formatBytes(plan.totalBytes);
    if (plan.savedBytes > 0) {
      text += ' · saves ' + formatBytes(plan.savedBytes);
    }
    setText(refs.savingsText, text);
  }

  /* ------------------------------------------------------------------ */
  /* events out to the theme panel                                      */
  /* ------------------------------------------------------------------ */

  function dispatch(state, detail) {
    try {
      window.dispatchEvent(new CustomEvent('ppdm-update-state', {
        detail: {
          state: state,
          version: installedInfo().version,
          available: detail && detail.version ? detail.version : '',
          skipped: detail && detail.skipped ? detail.skipped : ''
        }
      }));
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ */
  /* persistence                                                        */
  /* ------------------------------------------------------------------ */

  function readState() {
    var state = readJSON(window.localStorage, STATE_KEY, {});
    return {
      lastCheck: Number(state.lastCheck) || 0,
      skippedVersion: String(state.skippedVersion || ''),
      installedVersion: String(state.installedVersion || '')
    };
  }

  function writeState(next) {
    writeJSON(window.localStorage, STATE_KEY, next);
  }

  /* ------------------------------------------------------------------ */
  /* the flow                                                           */
  /* ------------------------------------------------------------------ */

  function normalizeManifest(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (!raw.version || !raw.files || typeof raw.files !== 'object') return null;
    return {
      version: String(raw.version),
      bootstrap: Number(raw.bootstrap) || 0,
      released: String(raw.released || ''),
      notes: Array.isArray(raw.notes) ? raw.notes.map(String) : [],
      files: raw.files
    };
  }

  function check(options) {
    options = options || {};
    var force = !!options.force;
    var interactive = !!options.interactive;
    var state = readState();

    if (!force && Date.now() - state.lastCheck < CHECK_EVERY) {
      dispatch('idle');
      return Promise.resolve(null);
    }
    if (checking) return checking;

    if (interactive) {
      setState('checking');
      dispatch('checking');
    }

    checking = fromMirrors('update/manifest.json', true).then(function (raw) {
      var remote = normalizeManifest(raw);
      if (!remote) throw new Error('manifest');
      state.lastCheck = Date.now();
      writeState(state);
      checking = null;
      return evaluate(remote, interactive);
    }, function () {
      checking = null;
      if (interactive) {
        setState('error', {
          title: 'Could not check',
          message: 'GitHub could not be reached. Check your connection and try again.'
        });
      }
      dispatch('idle', { error: true });
      return null;
    });

    return checking;
  }

  function evaluate(remote, interactive) {
    var local = installedInfo();
    var order = compareVersions(remote.version, local.version);

    if (order <= 0) {
      if (interactive) {
        setState('uptodate', { version: local.version });
        autoHide(3200);
      }
      dispatch('uptodate', { version: local.version });
      return null;
    }

    var state = readState();

    if (!interactive) {
      if (state.skippedVersion === remote.version) {
        dispatch('skipped', { version: remote.version, skipped: remote.version });
        return null;
      }
      var dismissed = '';
      try { dismissed = window.sessionStorage.getItem(DISMISS_KEY) || ''; } catch (e) { dismissed = ''; }
      if (dismissed === remote.version) {
        dispatch('available', { version: remote.version });
        return null;
      }
    }

    currentRemote = remote;
    currentPlan = planUpdate(local.files, remote.files);

    var foot = '';
    if (!agentConfig()) {
      foot = 'One-click install needs the update helper — re-run apply-darkmode.ps1 once.';
    } else if (remote.bootstrap > local.bootstrap) {
      foot = 'Tip: re-run apply-darkmode.ps1 once to pick up the newest loader.';
    }

    setState('prompt', {
      version: remote.version,
      notes: remote.notes,
      plan: currentPlan,
      foot: foot
    });
    dispatch('available', { version: remote.version });

    // Tell the user early if the helper is unavailable, instead of failing
    // after a full download.
    agentOnline = null;
    probeAgent().then(function (ok) {
      agentOnline = ok;
      if (!ok && refs.root && refs.root.getAttribute('data-state') === 'prompt') {
        setText(refs.foot, 'Update helper is offline — re-run apply-darkmode.ps1 once to enable one-click updates.');
      }
    });

    return remote;
  }

  function runApply(restart) {
    if (busy || !currentPlan || !currentRemote) return Promise.resolve(false);
    if (!agentConfig()) {
      setState('error', {
        title: 'Helper not configured',
        message: 'Re-run apply-darkmode.ps1 once to install the update helper.'
      });
      return Promise.resolve(false);
    }

    var plan = currentPlan;
    var remote = currentRemote;
    var total = plan.downloadBytes || 1;
    var received = 0;
    var startedAt = Date.now();
    var staged = [];

    busy = true;
    cancelRequested = false;
    currentStage = 'download';
    lastRestart = !!restart;

    // A release can change only files that are already up to date, or only
    // its changelog. Skip the download stage entirely in that case.
    var nothingToFetch = plan.changed.length === 0;

    if (nothingToFetch) {
      setState('installing', { percent: 100, step: 'install', stage: 'Installing…', eta: '' });
      dispatch('installing', { version: remote.version });
    } else {
      setState('downloading', {
        percent: 0,
        step: 'download',
        stage: 'Preparing…',
        eta: ''
      });
      dispatch('downloading', { version: remote.version });
    }

    var chain = Promise.resolve();

    plan.changed.forEach(function (file, index) {
      chain = chain.then(function () {
        if (cancelRequested) throw new Error('cancelled');
        setText(refs.stage, 'Downloading ' + (index + 1) + ' of ' + plan.changed.length + ' · ' + file.name);
        var root = sourceRoots()[0];
        return downloadFile(root, file, function (bytes) {
          received += bytes;
          var percent = Math.min(100, (received / total) * 100);
          updateProgress(percent, received, total, startedAt);
        }).then(function (payload) {
          if (cancelRequested) throw new Error('cancelled');
          return sha256Hex(payload).then(function (digest) {
            if (digest && file.sha256 && digest !== file.sha256) {
              throw new Error('verify');
            }
            staged.push({ name: file.name, sha256: file.sha256, bytes: payload });
          });
        });
      });
    });

    return chain.then(function () {
      if (nothingToFetch) return null;

      updateProgress(100, total, total, startedAt);
      setState('verifying', { percent: 100, step: 'verify', stage: 'Verifying signatures…', eta: '' });
      dispatch('verifying', { version: remote.version });

      return new Promise(function (resolve) {
        setTimeout(resolve, 260);
      });
    }).then(function () {
      if (cancelRequested) throw new Error('cancelled');
      setState('installing', { percent: 100, step: 'install', stage: 'Installing…', eta: '' });
      dispatch('installing', { version: remote.version });

      var agent = agentConfig();
      return agentPost('/apply', {
        token: agent.token,
        version: remote.version,
        bootstrap: remote.bootstrap,
        released: remote.released,
        notes: remote.notes,
        restart: !!restart,
        manifest: remote,
        files: staged.map(function (file) {
          return { name: file.name, sha256: file.sha256, data: toBase64(file.bytes) };
        })
      });
    }).then(function (result) {
      busy = false;
      var state = readState();
      if (state.skippedVersion === remote.version) {
        state.skippedVersion = '';
        writeState(state);
      }
      writeJSON(window.localStorage, PENDING_KEY, {
        version: remote.version,
        files: staged.length,
        bytes: plan.downloadBytes,
        notes: remote.notes,
        at: Date.now()
      });

      if (restart) {
        setState('success', {
          restart: true,
          notes: [],
          foot: 'PikPak is relaunching with v' + remote.version + '.'
        });
        dispatch('restarting', { version: remote.version });
      } else {
        setState('success', {
          restart: false,
          notes: remote.notes,
          foot: 'v' + remote.version + ' is installed. Reload to see it.'
        });
        dispatch('success', { version: remote.version });
        autoHide(9000);
      }
      return !!(result && result.ok);
    }).catch(function (error) {
      busy = false;
      if (error && error.message === 'cancelled') {
        setState('prompt', {
          version: remote.version,
          notes: remote.notes,
          plan: plan,
          foot: 'Download cancelled — nothing was changed.'
        });
        dispatch('available', { version: remote.version });
        return false;
      }
      setState('error', {
        title: 'Update failed',
        message: messageFor(error)
      });
      dispatch('error', { version: remote.version });
      return false;
    });
  }

  function updateProgress(percent, received, total, startedAt) {
    var elapsed = Math.max(0.25, (Date.now() - startedAt) / 1000);
    var rate = received / elapsed;
    var remaining = Math.max(0, total - received);
    var eta = rate > 0 ? remaining / rate : 0;
    refs.fill.style.width = percent.toFixed(1) + '%';
    setText(refs.stage, 'Downloading ' + formatBytes(received) + ' of ' + formatBytes(total));
    var meta = [];
    if (formatRate(rate)) meta.push(formatRate(rate));
    if (formatEta(eta)) meta.push(formatEta(eta));
    setText(refs.eta, meta.join(' · '));
  }

  function messageFor(error) {
    var code = (error && error.message) || 'unknown';
    switch (code) {
      case 'verify':
        return 'A downloaded file did not match its checksum, so nothing was installed. Try again.';
      case 'agent-offline':
      case 'agent-timeout':
      case 'agent-missing':
        return 'The update helper is not responding. Re-run apply-darkmode.ps1 (or restart PikPak) and try again.';
      case 'elevation-cancelled':
        return 'Windows approval was cancelled. Your theme was left untouched.';
      case 'elevation-required':
        return 'Administrator rights are needed for this folder. Accept the Windows prompt to finish.';
      case 'network':
      case 'timeout':
        return 'GitHub could not be reached. Check your connection and try again.';
      default:
        return 'Something went wrong while installing. Your current theme is still active.';
    }
  }

  function skip() {
    var state = readState();
    state.skippedVersion = currentRemote ? currentRemote.version : '';
    writeState(state);
    try { window.sessionStorage.removeItem(DISMISS_KEY); } catch (e) { /* ignore */ }
    hide();
    dispatch('skipped', { version: state.skippedVersion, skipped: state.skippedVersion });
  }

  function dismiss() {
    if (currentRemote) {
      try { window.sessionStorage.setItem(DISMISS_KEY, currentRemote.version); } catch (e) { /* ignore */ }
    }
    hide();
    dispatch('dismissed');
  }

  function onAction(event) {
    var target = event.target && event.target.closest ? event.target.closest('[data-action]') : null;
    if (!target || !refs.root.contains(target)) return;
    event.preventDefault();
    event.stopPropagation();

    switch (target.getAttribute('data-action')) {
      case 'apply':
        runApply(false);
        break;
      case 'restart':
        runApply(true);
        break;
      case 'skip':
        skip();
        break;
      case 'close':
      case 'dismiss':
        dismiss();
        break;
      case 'cancel':
        cancelRequested = true;
        if (activeRequest) activeRequest.abort();
        break;
      case 'retry':
        if (currentRemote && currentPlan) runApply(lastRestart);
        else check({ force: true, interactive: true });
        break;
      case 'reload':
        window.location.reload();
        break;
      default:
        break;
    }
  }

  var currentStage = 'download';

  /* ------------------------------------------------------------------ */
  /* boot                                                               */
  /* ------------------------------------------------------------------ */

  function showPostUpdate() {
    var pending = readJSON(window.localStorage, PENDING_KEY, null);
    if (!pending || !pending.version) return false;
    if (pending.version !== installedInfo().version) return false;

    try { window.localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
    setState('success', {
      restart: false,
      notes: pending.notes || [],
      foot: 'Updated to v' + pending.version +
        (pending.files ? ' · ' + pending.files + ' file' + (pending.files === 1 ? '' : 's') : '') +
        (pending.bytes ? ' · ' + formatBytes(pending.bytes) + ' downloaded' : '')
    });
    autoHide(8000);
    dispatch('success', { version: pending.version });
    return true;
  }

  function boot() {
    if (isExcluded) return;
    mount();
    if (showPostUpdate()) return;
    dispatch('idle');
    setTimeout(function () {
      check({ force: false, interactive: false });
    }, BOOT_DELAY);
  }

  window.PikPakUpdater = {
    check: check,
    apply: function () { return runApply(false); },
    applyAndRestart: function () { return runApply(true); },
    skip: skip,
    dismiss: dismiss,
    installed: installedInfo,
    state: readState,
    reset: function () {
      try {
        window.localStorage.removeItem(STATE_KEY);
        window.localStorage.removeItem(PENDING_KEY);
        window.localStorage.removeItem(SOURCE_KEY);
        window.sessionStorage.removeItem(DISMISS_KEY);
      } catch (e) { /* ignore */ }
    },
    debug: {
      compareVersions: compareVersions,
      planUpdate: planUpdate,
      sources: sourceRoots,
      agent: agentConfig
    }
  };

  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }
})();
