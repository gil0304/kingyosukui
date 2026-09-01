/**
 * The boot sentinel: a tiny inline script that ships INSIDE the HTML document.
 *
 * Why it exists — venue phones kept showing a page whose button did nothing and
 * whose diagnostic line never left its server-rendered placeholder. That is the
 * signature of ONE failure: the JavaScript bundle never executed. The usual
 * cause is a phone that cached the HTML of an older build and now requests
 * chunk files that no longer exist (every rebuild renames them), but a flaky
 * tunnel or a parse error on an old browser looks identical. React cannot
 * report a failure to start React — only something inside the document can.
 *
 * So this script rides in the <head>, needs nothing else to arrive, and:
 *
 *   1. records every script/resource/runtime error, so the failure is READABLE
 *      on the phone instead of silent;
 *   2. gives the join button a pre-hydration voice ("still loading…") so a tap
 *      is never met with nothing;
 *   3. if the app has not announced itself within the timeout, reloads ONCE
 *      with a cache-busting query — which repairs the stale-HTML case without
 *      anyone touching settings — and if that also fails, shows what went
 *      wrong with a manual reload button.
 *
 * It is written in strict ES5: this code must parse on exactly the browsers
 * where the modern bundle might not.
 */

export const HYDRATED_FLAG = '__kgsHydrated';
export const RELOAD_GUARD_KEY = 'kgs-reload';
export const BANNER_ID = 'kgs-boot-banner';
export const TOAST_ID = 'kgs-boot-toast';
/** Seconds the app gets to hydrate before the sentinel intervenes. */
export const BOOT_TIMEOUT_SECONDS = 8;

export const BOOT_SCRIPT = `(function () {
  if (window.__kgsBoot) { return; }
  var boot = { errors: [] };
  window.__kgsBoot = boot;
  window.${HYDRATED_FLAG} = false;

  function record(msg) {
    if (!msg) { return; }
    if (boot.errors.length < 8) { boot.errors.push(String(msg).slice(0, 180)); }
  }

  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      record('読み込み失敗: ' + (t.src || t.href || t.tagName));
    } else if (e && e.message) {
      record(e.message);
    }
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    record(r && r.message ? r.message : r);
  });

  function box(id, bg) {
    var d = document.getElementById(id);
    if (d) { return d; }
    d = document.createElement('div');
    d.id = id;
    d.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;' +
      'padding:14px 16px;border-radius:12px;background:' + bg + ';color:#fff;' +
      'font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;text-align:center;' +
      'box-shadow:0 8px 30px rgba(0,0,0,0.5)';
    document.body.appendChild(d);
    return d;
  }

  document.addEventListener('click', function (ev) {
    if (window.${HYDRATED_FLAG}) { return; }
    var t = ev.target;
    while (t && t !== document) {
      if (t.id === 'join-button') {
        box('${TOAST_ID}', 'rgba(20,26,44,0.96)').textContent =
          'アプリを読み込んでいます… そのまま少しお待ちください';
        break;
      }
      t = t.parentNode;
    }
  }, true);

  function bustedUrl() {
    var u = location.href.replace(/([?&])kgsr=[^&]*&?/, '$1').replace(/[?&]$/, '');
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'kgsr=' + new Date().getTime();
  }

  setTimeout(function () {
    if (window.${HYDRATED_FLAG}) { return; }

    var retried = false;
    try { retried = sessionStorage.getItem('${RELOAD_GUARD_KEY}') === '1'; } catch (e) {}

    if (!retried) {
      // First failure: almost always stale HTML naming chunks a newer build
      // deleted. A cache-busted reload fetches the current build and fixes it
      // without anyone touching browser settings.
      try { sessionStorage.setItem('${RELOAD_GUARD_KEY}', '1'); } catch (e) {}
      location.replace(bustedUrl());
      return;
    }

    var banner = box('${BANNER_ID}', 'rgba(140,32,24,0.97)');
    var detail = boot.errors.length
      ? boot.errors.slice(0, 3).join(' / ')
      : '原因を特定できませんでした（電波状況をご確認ください）';
    banner.innerHTML = '';
    var title = document.createElement('div');
    title.style.cssText = 'font-weight:800;font-size:16px;margin-bottom:6px';
    title.textContent = 'アプリを読み込めませんでした';
    var body = document.createElement('div');
    body.style.cssText = 'font-size:12px;opacity:0.9;margin-bottom:10px;word-break:break-all';
    body.textContent = detail;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '再読み込み';
    btn.style.cssText = 'min-height:48px;padding:10px 26px;border:none;border-radius:10px;' +
      'background:#ffb64d;color:#20120a;font-size:16px;font-weight:800;cursor:pointer';
    btn.onclick = function () { location.replace(bustedUrl()); };
    banner.appendChild(title);
    banner.appendChild(body);
    banner.appendChild(btn);
  }, ${BOOT_TIMEOUT_SECONDS * 1000});
})();`;
