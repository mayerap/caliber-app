// Caliber shell: sign-in gate, Supabase session, account sheet.
// Loaded before calibre.html's own scripts (see scripts/build-web.mjs). Runs inside the Capacitor
// app, and in the web companion (window.CALIBER_WEB, set by scripts/build-companion.mjs); a plain
// calibre.html never includes it. Spec: CALIBER_HANDOFF.md section 3, docs/web-companion.md.
(function () {
  const Cap = window.Capacitor;
  const NATIVE = !!(Cap && Cap.isNativePlatform && Cap.isNativePlatform());
  const WEB = !NATIVE && window.CALIBER_WEB;            // {apple: bool}
  if (!NATIVE && !WEB) return;

  const CFG = window.CALIBER_SUPABASE;                    // {url, publishableKey}, inlined at build time
  // On the web, sign-in links and Google/Apple come back to this page (listed in Supabase → Auth → URL Configuration)
  const REDIRECT = NATIVE ? 'caliber://auth-callback' : location.origin + location.pathname;
  const DEVICE = NATIVE ? 'iPhone' : 'browser';
  // Google Cloud project caliber-512922, "Caliber iOS" client (public; also listed under Supabase → Google → Client IDs)
  const GOOGLE_IOS_CLIENT = '1043025569072-f9i4o06g66rr2dkf0e0jfeof3ct47d7m.apps.googleusercontent.com';
  const Native = NATIVE ? window.capacitorExports.registerPlugin('CaliberAuth') : null;   // from vendor/capacitor.js
  const AppPlugin = NATIVE ? window.capacitorExports.registerPlugin('App') : null;

  // In the app Supabase keeps its session (and the PKCE verifier) in the Keychain; on the web, in localStorage.
  const keychain = NATIVE && {
    getItem: k => Native.keychainGet({ key: k }).then(r => r.value ?? null),
    setItem: (k, v) => Native.keychainSet({ key: k, value: v }),
    removeItem: k => Native.keychainRemove({ key: k }),
  };
  const sb = window.supabase.createClient(CFG.url, CFG.publishableKey, {
    auth: { ...(keychain && { storage: keychain }), flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  let session = null;
  const providerName = { email: 'Email', apple: 'Apple', google: 'Google' };

  // ---------- small DOM helpers ----------
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach(c => c != null && el.append(c.nodeType ? c : document.createTextNode(c)));
    return el;
  };
  const mark = () => {
    const s = h('span', { class: 'cs-mark', 'aria-hidden': 'true' });
    s.innerHTML = '<svg viewBox="0 0 100 100"><path d="M80.95 77.87A41.65 41.65 0 1 1 80.95 22.13" fill="none" stroke="currentColor" stroke-width="16.7"/><circle cx="50" cy="50" r="19.3" fill="var(--cs-sleeve)"/></svg>';
    return s;
  };
  // Provider logos for the sign-in buttons: Apple's in the button's text color, Google's four-color G
  const logo = svg => { const s = h('span', { class: 'cs-logo', 'aria-hidden': 'true' }); s.innerHTML = svg; return s; };
  const APPLE_LOGO = '<svg viewBox="0 0 842 1000"><path fill="currentColor" d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/></svg>';
  const GOOGLE_LOGO = '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  const busy = (btn, on, label) => { btn.disabled = on; if (label) btn.querySelector('.cs-label').textContent = label; };

  // ---------- sign-in gate ----------
  let gate = null;
  function showGate(message) {
    if (window.__caliberPreview) return;   // simulator demo builds only (MainViewController, DEBUG)
    if (gate) { setGateMessage(message); return; }
    const status = h('p', { class: 'cs-status', role: 'status', 'aria-live': 'polite' });
    const email = h('input', { class: 'cs-input', type: 'email', inputmode: 'email', autocomplete: 'email',
      autocapitalize: 'none', spellcheck: 'false', placeholder: 'you@example.com', 'aria-label': 'Email address' });
    const appleBtn = h('button', { class: 'cs-btn cs-apple', onclick: () => withApple(appleBtn) }, logo(APPLE_LOGO), h('span', { class: 'cs-label' }, 'Continue with Apple'));
    const googleBtn = h('button', { class: 'cs-btn cs-ghost', onclick: () => withGoogle(googleBtn) }, logo(GOOGLE_LOGO), h('span', { class: 'cs-label' }, 'Continue with Google'));
    const emailBtn = h('button', { class: 'cs-btn cs-accent', type: 'submit' }, h('span', { class: 'cs-label' }, 'Email me a sign-in link'));
    const form = h('form', { class: 'cs-form', onsubmit: e => { e.preventDefault(); withEmail(email.value.trim(), emailBtn); } }, email, emailBtn);
    gate = h('div', { class: 'cs-gate', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Sign in to Caliber' },
      h('div', { class: 'cs-inner' },
        h('div', { class: 'cs-brand' }, mark(), h('span', { class: 'cs-word' }, 'ALIBER')),
        h('h1', { class: 'cs-h1' }, 'Train with', h('br'), 'your data'),
        h('p', { class: 'cs-sub' }, 'Sign in to keep your training, food and progress safe across devices.'),
        // Apple on the web needs a Services ID in the Apple developer account (docs/web-companion.md)
        h('div', { class: 'cs-stack' }, NATIVE || WEB.apple ? appleBtn : null, googleBtn, h('div', { class: 'cs-or' }, h('span', {}, 'or')), form),
        status,
        h('p', { class: 'cs-fine' }, 'We only use your email to sign you in. ',
          h('a', { href: '#', onclick: e => { e.preventDefault(); openPrivacy(); } }, 'Privacy policy'))));
    document.body.append(gate);
    document.documentElement.classList.add('cs-locked');
    setGateMessage(message);
  }
  function setGateMessage(msg, tone) {
    const el = gate && gate.querySelector('.cs-status');
    if (!el) return;
    el.textContent = msg || '';
    el.dataset.tone = tone || '';
  }
  function hideGate() {
    if (!gate) return;
    gate.classList.add('cs-out');
    const g = gate; gate = null;
    setTimeout(() => g.remove(), 260);
    if (!hold) document.documentElement.classList.remove('cs-locked');
  }

  // ---------- web approval: a new web account waits until the owner approves it ----------
  // docs/web-companion.md "Who can get in"; table, rules and caliber_access() in
  // supabase/migrations/20261103000000_web_access.sql; the owner's email from supabase/functions/web-access.
  // The iPhone app reports itself so its people are never held, and can use the web straight away.
  const ACCESS = 'calibre-access:';                       // + user id; not a calibre: key, so it never syncs
  let hold = null;
  async function admit(s) {
    const uid = s.user.id;
    if (NATIVE) {
      hideGate();
      if (localStorage.getItem(ACCESS + uid) !== 'approved')
        sb.rpc('caliber_access', { platform: 'ios' }).then(r => { if (r.data === 'approved') localStorage.setItem(ACCESS + uid, 'approved'); }, () => {});
      return;
    }
    const known = localStorage.getItem(ACCESS + uid);
    if (known === 'approved') { hideGate(); hideHold(); } else showHold('checking', s);
    const { data, error } = await sb.rpc('caliber_access', { platform: 'web' }).catch(e => ({ error: e }));
    if (session?.user?.id !== uid) return;                // signed out meanwhile
    if (error) {
      // the server doesn't have the approval step yet: let people in rather than lock everyone out
      if (/PGRST202|42883|caliber_access/.test(`${error.code} ${error.message}`)) { hideGate(); return hideHold(); }
      if (known === 'approved') return;                   // offline: trust the last answer
      return showHold('offline', s);
    }
    localStorage.setItem(ACCESS + uid, data);
    if (data === 'approved') { hideGate(); return hideHold(); }
    showHold(data, s);
    if (data === 'pending') fetch(`${CFG.url}/functions/v1/web-access`, {   // emails the owner, once per person
      method: 'POST',
      headers: { Authorization: `Bearer ${s.access_token}`, apikey: CFG.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'notify' }),
    }).catch(() => {});
  }
  function showHold(kind, s) {
    if (window.__caliberPreview) return;
    if (!document.body) return document.addEventListener('DOMContentLoaded', () => showHold(kind, s), { once: true });
    hideGate();
    const email = s.user.email || 'your email';
    const [title, text] = {
      checking: ['One moment', 'Checking your access…'],
      pending: ['You’re on the list', `Caliber on the web is invite-only for now. We’ll email ${email} as soon as you’re approved. Using the iPhone beta? Sign in there once with this account and you’re in here too.`],
      denied: ['Not approved', `${email} isn’t approved for Caliber on the web. Questions? Email amayer@caliberperpetual.com.`],
      offline: ['Can’t reach Caliber', 'Check your connection, then try again.'],
    }[kind] || ['One moment', ''];
    if (!hold) {
      const again = h('button', { class: 'cs-btn cs-accent', onclick: () => session && admit(session) }, h('span', { class: 'cs-label' }, 'Check again'));
      const out = h('button', { class: 'cs-btn cs-ghost', onclick: async () => { await sb.auth.signOut().catch(() => {}); clearLocal(); } }, h('span', { class: 'cs-label' }, 'Sign out'));
      hold = h('div', { class: 'cs-gate', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Caliber access' },
        h('div', { class: 'cs-inner' },
          h('div', { class: 'cs-brand' }, mark(), h('span', { class: 'cs-word' }, 'ALIBER')),
          h('h1', { class: 'cs-h1' }), h('p', { class: 'cs-sub' }), h('div', { class: 'cs-stack' }, again, out)));
      document.body.append(hold);
      document.documentElement.classList.add('cs-locked');
    }
    hold.querySelector('.cs-h1').textContent = title;
    hold.querySelector('.cs-sub').textContent = text;
    hold.querySelector('.cs-stack').hidden = kind === 'checking';
  }
  function hideHold() {
    if (!hold) return;
    hold.classList.add('cs-out');
    const g = hold; hold = null;
    setTimeout(() => g.remove(), 260);
    if (!gate) document.documentElement.classList.remove('cs-locked');
  }
  // coming back after the approval email: look again
  document.addEventListener('visibilitychange', () => { if (!document.hidden && hold && session) admit(session); });

  async function withEmail(address, btn) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return setGateMessage('Enter a full email address.', 'warn');
    busy(btn, true, 'Sending…');
    const { error } = await sb.auth.signInWithOtp({ email: address, options: { emailRedirectTo: REDIRECT, shouldCreateUser: true } });
    busy(btn, false, 'Email me a sign-in link');
    if (error) return setGateMessage(friendly(error), 'warn');
    setGateMessage(NATIVE ? `Check ${address} and tap the link on this iPhone. It opens Caliber and signs you in.`
      : `Check ${address} and open the link in this browser. It brings you back here, signed in.`, 'ok');
  }

  // Web: Google and Apple sign in on their own page, then return to REDIRECT with a code (see finishRedirect)
  async function withOAuth(provider, btn) {
    busy(btn, true);
    const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo: REDIRECT } });
    if (error) { busy(btn, false); setGateMessage(friendly(error), 'warn'); }
  }

  async function withApple(btn) {
    if (!NATIVE) return withOAuth('apple', btn);
    busy(btn, true);
    try {
      const r = await Native.signInWithApple();
      const { data, error } = await sb.auth.signInWithIdToken({ provider: 'apple', token: r.idToken, nonce: r.nonce });
      if (error) throw error;
      // Apple shares the name only on the very first sign-in
      const name = [r.givenName, r.familyName].filter(Boolean).join(' ');
      if (name && !data.user?.user_metadata?.full_name) await sb.auth.updateUser({ data: { full_name: name } });
    } catch (e) {
      if (e?.code !== 'canceled') setGateMessage(appleMessage(e), 'warn');
    } finally { busy(btn, false); }
  }

  async function withGoogle(btn) {
    if (!NATIVE) return withOAuth('google', btn);
    busy(btn, true);
    try {
      // Signs in as the Caliber iOS app, so Google's sheet names Caliber (not the Supabase project address)
      const r = await Native.signInWithGoogle({ clientId: GOOGLE_IOS_CLIENT });
      const { error } = await sb.auth.signInWithIdToken({ provider: 'google', token: r.idToken, nonce: r.nonce });
      if (error) throw error;
    } catch (e) {
      if (e?.code !== 'canceled') setGateMessage(friendly(e), 'warn');
    } finally { busy(btn, false); }
  }

  // Magic links and OAuth both come back as caliber://auth-callback?code=… (PKCE), or to this page on the web
  async function finishRedirect(url) {
    if (!url || !url.startsWith(REDIRECT)) return;
    const u = new URL(url.replace('caliber://', 'https://caliber.invalid/'));
    const p = new URLSearchParams(u.search + '&' + u.hash.slice(1));
    if (!NATIVE && (p.get('code') || p.get('error'))) history.replaceState(null, '', location.pathname);   // a reload doesn't reuse it
    if (p.get('error')) return showGate(p.get('error_description')?.replace(/\+/g, ' ') || 'That sign-in link didn’t work. Request a new one.');
    const code = p.get('code');
    if (!code) return;
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) showGate(error.message.includes('code verifier')
      ? `Open the sign-in link on the same ${DEVICE} where you asked for it.` : friendly(error));
  }

  function friendly(e) {
    const m = String(e?.message || e || '');
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Wait a minute and try again.';
    if (/provider is not enabled|Unsupported provider/i.test(m)) return 'That sign-in option isn’t switched on yet.';
    if (/network|fetch/i.test(m)) return 'Can’t reach Caliber. Check your connection.';
    return m || 'Something went wrong. Try again.';
  }
  function appleMessage(e) {
    const m = String(e?.message || '');
    if (/1000|not.*(entitled|available)|AKAuthentication/i.test(m)) return 'Sign in with Apple isn’t available in this build yet.';
    return friendly(e);
  }

  // ---------- shell sheets: drag the handle (or title) down to dismiss, like the app's own sheets ----------
  // Follows the finger, rubber-bands when pulled up, and closes on a long pull or a quick flick; otherwise springs back.
  function draggable(sheet, scrim, remove) {
    let d = null;
    const zone = t => !t.closest('button, input, a, iframe, table, select, textarea') &&
      (t === sheet || t.closest('.cs-grab, .cs-h3, .cs-sub'));
    sheet.addEventListener('pointerdown', e => {
      if (e.button > 0 || !zone(e.target)) return;
      d = { y: e.clientY, dy: 0, ly: e.clientY, lt: performance.now(), v: 0 };
      sheet.style.animation = 'none'; sheet.style.transition = 'none'; scrim.style.animation = 'none'; scrim.style.transition = 'none';
      sheet.setPointerCapture(e.pointerId);
    });
    sheet.addEventListener('pointermove', e => {
      if (!d) return;
      const now = performance.now();
      let dy = e.clientY - d.y;
      if (dy < 0) dy = -36 * (1 - 1 / (1 - dy / 90));
      d.v = (e.clientY - d.ly) / Math.max(1, now - d.lt); d.ly = e.clientY; d.lt = now; d.dy = dy;
      sheet.style.transform = `translateY(${dy}px)`;
      scrim.style.opacity = String(Math.max(0, 1 - Math.max(dy, 0) / (sheet.offsetHeight || 400)));
    });
    const up = () => {
      if (!d) return;
      const done = d.dy > 110 || (d.v > 0.5 && d.dy > 24), v = Math.max(0, d.v);
      d = null;
      if (done) {
        const ms = Math.round(Math.max(140, Math.min(260, 260 - v * 90)));
        sheet.style.transition = `transform ${ms}ms cubic-bezier(.4,0,.9,.6)`; sheet.style.transform = 'translateY(100%)';
        scrim.style.transition = `opacity ${ms}ms ease-in`; scrim.style.opacity = '0';
        setTimeout(remove, ms);
        return;
      }
      sheet.style.transition = 'transform 460ms cubic-bezier(.3,1.35,.5,1)'; sheet.style.transform = 'translateY(0)';
      scrim.style.transition = 'opacity .3s'; scrim.style.opacity = '1';
    };
    sheet.addEventListener('pointerup', up);
    sheet.addEventListener('pointercancel', up);
  }

  // ---------- account sheet ----------
  function accountLabel() {
    if (!session) return 'Not signed in';
    const u = session.user;
    return `${u.email || 'Signed in'} · ${providerName[u.app_metadata?.provider] || 'Email'}`;
  }

  function openAccount() {
    if (!session) return showGate();
    const close = () => { scrim.classList.add('cs-out'); setTimeout(() => scrim.remove(), 220); };
    const confirmBox = h('input', { class: 'cs-input', autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'Type DELETE', 'aria-label': 'Type DELETE to confirm' });
    const del = h('button', { class: 'cs-btn cs-danger', disabled: true, onclick: () => deleteAccount(del, msg) }, h('span', { class: 'cs-label' }, 'Delete my account'));
    confirmBox.addEventListener('input', () => { del.disabled = confirmBox.value.trim().toUpperCase() !== 'DELETE'; });
    const msg = h('p', { class: 'cs-status', role: 'status', 'aria-live': 'polite' });
    const sheet = h('div', { class: 'cs-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Account' },
      h('div', { class: 'cs-grab' }),
      h('h3', { class: 'cs-h3' }, 'Account'),
      h('p', { class: 'cs-sub' }, accountLabel()),
      h('button', { class: 'cs-btn cs-ghost', onclick: () => signOut(close) }, h('span', { class: 'cs-label' }, 'Sign out')),
      h('button', { class: 'cs-link', onclick: openPrivacy }, 'Privacy policy'),
      h('div', { class: 'cs-danger-zone' },
        h('h4', {}, 'Delete account'),
        h('p', {}, 'Permanently deletes your account and everything stored with it: workouts, weigh-ins, food, photos and settings. This can’t be undone. Make a backup first if you might want your data.'),
        confirmBox, del, msg),
      h('button', { class: 'cs-link', onclick: close }, 'Done'));
    const scrim = h('div', { class: 'cs-scrim', onclick: e => { if (e.target === scrim) close(); } }, sheet);
    draggable(sheet, scrim, () => scrim.remove());
    document.body.append(scrim);
  }

  async function signOut(close) {
    if (NATIVE) { close(); clearDevices(); await sb.auth.signOut(); return; }
    // A browser may be a shared computer: signing out also clears this browser's copy (the account keeps everything)
    await window.caliberSync?.flush().catch(() => {});
    const left = window.caliberSync?.status().pending || 0;
    if (left && !confirm(`${left} change${left === 1 ? ' hasn’t' : 's haven’t'} synced to your account yet and will be lost. Sign out anyway?`)) return;
    close();
    await sb.auth.signOut().catch(() => {});
    clearLocal();
  }
  function clearLocal() {
    window.caliberSync?.reset();
    Object.keys(localStorage).filter(k => k.startsWith('calibre:')).forEach(k => localStorage.removeItem(k));
    location.reload();
  }

  async function deleteAccount(btn, msg) {
    busy(btn, true, 'Deleting…');
    try {
      const res = await fetch(`${CFG.url}/functions/v1/delete-account`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: CFG.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await sb.auth.signOut({ scope: 'local' }).catch(() => {});
      // The account is gone; clear this phone's copy too (and the Watch, widgets and Lock Screen) so nothing of it is left behind
      clearDevices();
      clearLocal();
    } catch (e) {
      busy(btn, false, 'Delete my account');
      msg.textContent = `Couldn’t delete the account (${e.message}). Nothing was removed. Try again.`;
      msg.dataset.tone = 'warn';
    }
  }

  // Signed out or deleted: the Watch, the widgets and any rest timer on the Lock Screen stop showing this account
  function clearDevices() {
    const n = window.caliberNative || {};
    try { n.system?.rest({}); n.system?.widgets(''); n.watch?.update({ ws: '', reset: true }); } catch (e) { /* nothing to clear */ }
  }

  function appIsDark() {
    const c = getComputedStyle(document.body).backgroundColor.match(/\d+/g) || [0, 0, 0];
    return +c[0] + +c[1] + +c[2] < 384;
  }
  // The privacy policy (bundled as privacy.html) in a sheet over the app, so nothing is lost by reading it
  function openPrivacy() {
    const close = () => { scrim.classList.add('cs-out'); setTimeout(() => scrim.remove(), 220); };
    const sheet = h('div', { class: 'cs-sheet cs-doc', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Privacy policy' },
      h('div', { class: 'cs-grab' }),
      h('iframe', { src: `privacy.html?theme=${appIsDark() ? 'dark' : 'light'}`, title: 'Privacy policy', class: 'cs-frame' }),
      h('button', { class: 'cs-link', onclick: close }, 'Done'));
    const scrim = h('div', { class: 'cs-scrim cs-top', onclick: e => { if (e.target === scrim) close(); } }, sheet);
    draggable(sheet, scrim, () => scrim.remove());
    document.body.append(scrim);
  }

  // ---------- wiring ----------
  window.caliberShell = { supabase: sb, session: () => session, openAccount, accountLabel, openPrivacy, draggable };

  sb.auth.onAuthStateChange((event, s) => {
    session = s;
    if (!s) { hideHold(); showGate(); }
    else if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN') admit(s);
    else if (!hold) hideGate();
    document.dispatchEvent(new CustomEvent('caliber:auth', { detail: { event, signedIn: !!s } }));
  });
  AppPlugin?.addListener('appUrlOpen', e => finishRedirect(e.url));

  document.addEventListener('DOMContentLoaded', async () => {
    if (!NATIVE) await finishRedirect(location.href);    // back from a sign-in link, Google or Apple
    const { data } = await sb.auth.getSession();
    session = data.session;
    if (!session && !gate) showGate();                   // keeps a sign-in error from finishRedirect on screen
    const launch = NATIVE && await AppPlugin.getLaunchUrl().catch(() => null);
    if (launch?.url) finishRedirect(launch.url);
  });
})();
