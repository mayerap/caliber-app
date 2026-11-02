// Caliber native shell: sync between this phone's localStorage and Supabase (milestone 4).
// Replaces the web runtime's chunked `db` cloud save (cloudBoot/cloudFlush in calibre.html,
// which delegate here when window.caliberSync exists). Spec: CALIBER_HANDOFF.md sections 2 and 5.2.
//
// Mapping (keys are the localStorage names without "calibre:"):
//   settings -> settings.data        logs   -> workouts (one row per entry)
//   bw       -> body_weight (date)   food   -> food_entries (one row per entry)
//   photos   -> Storage photos/<uid>/<id>.jpg
//   anything else -> app_state(key, value), except `workout` (in-progress session) and internals.
//
// Rules: every local write marks its key dirty in a persisted outbox; the outbox is pushed when
// online and signed in. Before the app renders, boot() pushes pending changes and pulls rows that
// changed on the server, so the app always starts from merged data. A record with unpushed local
// changes is never overwritten by a pull (the local edit is newer and is pushed next).
(function () {
  // the app, or the web companion (scripts/build-companion.mjs), which signs in the same way
  const Cap = window.Capacitor;
  if (!(Cap && Cap.isNativePlatform && Cap.isNativePlatform()) && !window.CALIBER_WEB) return;

  const P = 'calibre:';
  const STATE_KEY = 'calibre-sync:state', DIRTY_KEY = 'calibre-sync:dirty';
  const IMPORT_KEY = 'calibre-sync:importResult', OFFER_KEY = 'calibre-sync:offerImport';
  const EXCLUDE = new Set(['workout', '__cloudAt']);
  const TABLE_KEYS = new Set(['settings', 'logs', 'bw', 'food', 'photos']);
  const sb = () => window.caliberShell.supabase;

  // ---------- persisted state ----------
  const load = (k, d) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const fresh = () => ({ owner: null, hydrated: false, lastAt: 0, seq: 0, k: {}, w: {}, f: {}, b: {}, ph: {} });
  let state = load(STATE_KEY, fresh());
  let dirty = new Set(load(DIRTY_KEY, []));
  const saveState = () => origSet.call(localStorage, STATE_KEY, JSON.stringify(state));
  const saveDirty = () => origSet.call(localStorage, DIRTY_KEY, JSON.stringify([...dirty]));

  // ---------- capture every write to calibre:* keys ----------
  const origSet = Storage.prototype.setItem, origRemove = Storage.prototype.removeItem;
  let suppress = 0;
  const tracked = k => typeof k === 'string' && k.startsWith(P) && !EXCLUDE.has(k.slice(P.length));
  Storage.prototype.setItem = function (k, v) { origSet.call(this, k, v); if (this === localStorage && tracked(k)) mark(k); };
  Storage.prototype.removeItem = function (k) { origRemove.call(this, k); if (this === localStorage && tracked(k)) mark(k); };

  function mark(fullKey) {
    if (suppress || !state.hydrated) return;        // writes before the account copy is loaded are never pushed
    const k = fullKey.startsWith(P) ? fullKey.slice(P.length) : fullKey;
    if (EXCLUDE.has(k)) return;
    dirty.add(k); saveDirty(); schedule(1200); emit();
  }
  function markAll() {
    if (!state.hydrated) return;
    localKeys().forEach(k => dirty.add(k));
    Object.keys(state.k).forEach(k => dirty.add(k));   // keys removed locally get deleted remotely
    ['settings', 'logs', 'bw', 'food', 'photos'].forEach(k => dirty.add(k));
    saveDirty(); schedule(300); emit();
  }
  function localKeys() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (tracked(k)) out.push(k.slice(P.length)); }
    return out;
  }
  const getJSON = k => { try { const v = localStorage.getItem(P + k); return v == null ? undefined : JSON.parse(v); } catch (e) { return undefined; } };
  const setRaw = (k, v) => { suppress++; try { v === undefined ? origRemove.call(localStorage, P + k) : origSet.call(localStorage, P + k, JSON.stringify(v)); } finally { suppress--; } };

  // ---------- status for the Profile screen ----------
  let onStatus = null, busy = false, err = null, signedIn = false;
  // "ok" means synced or syncing normally; a failed push with changes still waiting shows as not synced
  const isOk = () => signedIn && state.hydrated && !(err && dirty.size);
  function emit() {
    if (onStatus) try { onStatus({ ok: isOk(), lastAt: state.lastAt, busy, pending: [...dirty], err }); } catch (e) {}
  }
  // iOS keeps navigator.onLine true in Airplane mode, so a failed request is the real offline signal
  const isNetErr = e => !navigator.onLine || /load failed|failed to fetch|networkerror|network connection|internet connection|offline|timed? ?out/i.test(String(e?.message || e));

  // ---------- helpers ----------
  function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
  const H = v => hash(JSON.stringify(v));
  const iso = ms => (typeof ms === 'number' && isFinite(ms)) ? new Date(ms).toISOString() : null;
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  const strip = p => { const { __seq, ...e } = p || {}; return e; };
  async function q(p) { const { data, error } = await p; if (error) throw error; return data; }
  async function all(table, cols) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const rows = await q(sb().from(table).select(cols).range(from, from + 999));
      out.push(...rows); if (rows.length < 1000) return out;
    }
  }
  const uid = () => window.caliberShell.session()?.user?.id || null;
  // Runs fn(signal); after ms the caller moves on and signal.late tells fn not to touch localStorage any more.
  const withTimeout = (fn, ms) => { const signal = { late: false };
    return Promise.race([fn(signal), new Promise((_, r) => setTimeout(() => { signal.late = true; r(new Error('timeout')); }, ms))]); };

  // ---------- push ----------
  let timer = null, flushing = null;
  function schedule(ms) { clearTimeout(timer); timer = setTimeout(() => flush().catch(() => {}), ms); }

  async function flush() {
    if (flushing) return flushing;
    if (!navigator.onLine) { err = 'offline'; emit(); return; }
    if (!dirty.size || !state.hydrated || !uid()) { emit(); return; }
    flushing = (async () => {
      busy = true; emit();
      try {
        while (dirty.size) {
          const k = dirty.values().next().value;
          await pushKey(k, uid());
          dirty.delete(k); saveDirty(); saveState();
        }
        state.lastAt = Date.now(); err = null; saveState();
      } catch (e) {
        err = isNetErr(e) ? 'offline' : (e.message || 'error');
        schedule(err === 'offline' ? 10000 : 8000);
      } finally { busy = false; flushing = null; emit(); }
    })();
    return flushing;
  }

  async function pushKey(k, user_id) {
    if (k === 'settings') {
      const v = getJSON(k);
      if (v === undefined) { await q(sb().from('settings').delete().eq('user_id', user_id)); delete state.k.settings; return; }
      const [r] = await q(sb().from('settings').upsert({ user_id, data: v }).select('updated_at'));
      state.k.settings = { h: H(v), u: r.updated_at }; return;
    }
    if (k === 'logs') return pushRows('workouts', 'w', getJSON(k) || [], e => String(e.id), (e, seq) => ({
      user_id, id: String(e.id), kind: e.kind || 'lift', date: e.date, started_at: iso(e.start), ended_at: iso(e.end),
      name: e.name || null, payload: { ...e, __seq: seq } }), user_id);
    if (k === 'food') {
      const flat = []; Object.entries(getJSON(k) || {}).forEach(([date, list]) => (list || []).forEach(e => flat.push({ ...e, __date: date })));
      return pushRows('food_entries', 'f', flat, e => String(e.id), (e, seq) => {
        const { __date, ...entry } = e;
        return { user_id, id: String(e.id), date: __date, meal: entry.meal || null, eaten_at: iso(entry.at), payload: { ...entry, __seq: seq } };
      }, user_id);
    }
    if (k === 'bw') {
      const list = (getJSON(k) || []).filter(e => e && e.date && +e.w > 0), seen = new Set();
      const changed = list.filter(e => { seen.add(e.date); return state.b[e.date]?.h !== H(e); });
      for (const part of chunk(changed, 200)) {
        const rows = await q(sb().from('body_weight').upsert(part.map(e => ({ user_id, date: e.date, lb: +e.w })), { onConflict: 'user_id,date' }).select('date,updated_at'));
        rows.forEach(r => { const e = part.find(x => x.date === r.date); state.b[r.date] = { h: H(e), u: r.updated_at }; });
      }
      const gone = Object.keys(state.b).filter(d => !seen.has(d));
      for (const part of chunk(gone, 200)) { await q(sb().from('body_weight').delete().eq('user_id', user_id).in('date', part)); part.forEach(d => delete state.b[d]); }
      return;
    }
    if (k === 'photos') return pushPhotos(getJSON(k) || {}, user_id);
    // everything else: one app_state row per key
    const v = getJSON(k);
    if (v === undefined) { await q(sb().from('app_state').delete().eq('user_id', user_id).eq('key', k)); delete state.k[k]; return; }
    const [r] = await q(sb().from('app_state').upsert({ user_id, key: k, value: v }, { onConflict: 'user_id,key' }).select('updated_at'));
    state.k[k] = { h: H(v), u: r.updated_at };
  }

  // Upsert changed records, delete removed ones. `slot` is the per-record state map ('w' or 'f').
  async function pushRows(table, slot, list, idOf, toRow, user_id) {
    const map = state[slot], seen = new Set(), changed = [];
    for (const e of list) {
      const id = idOf(e); seen.add(id);
      const rec = map[id], h = H(e);
      if (!rec || rec.h !== h) changed.push({ id, h, row: toRow(e, rec?.s ?? ++state.seq) });
    }
    for (const part of chunk(changed, 100)) {
      const rows = await q(sb().from(table).upsert(part.map(c => c.row), { onConflict: 'user_id,id' }).select('id,updated_at'));
      rows.forEach(r => { const c = part.find(x => x.id === r.id); map[r.id] = { h: c.h, u: r.updated_at, s: c.row.payload.__seq }; });
    }
    const gone = Object.keys(map).filter(id => !seen.has(id));
    for (const part of chunk(gone, 100)) { await q(sb().from(table).delete().eq('user_id', user_id).in('id', part)); part.forEach(id => delete map[id]); }
  }

  async function pushPhotos(photos, user_id) {
    const bucket = sb().storage.from('photos');
    for (const [id, url] of Object.entries(photos)) {
      if (state.ph[id]) continue;
      const m = /^data:(image\/jpeg);base64,(.*)$/.exec(url || '');
      if (!m) { state.ph[id] = 'skip'; continue; }            // only JPEGs are stored (bucket rule); others stay on the phone
      const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
      const { error } = await bucket.upload(`${user_id}/${id}.jpg`, bytes, { contentType: 'image/jpeg', upsert: true });
      if (error) throw error;
      state.ph[id] = 1;
    }
    const gone = Object.keys(state.ph).filter(id => !(id in photos));
    if (gone.length) { const { error } = await bucket.remove(gone.map(id => `${user_id}/${id}.jpg`)); if (error) throw error; gone.forEach(id => delete state.ph[id]); }
  }

  // ---------- pull ----------
  // Read the whole account copy. Returns null if the account has nothing yet.
  async function fetchAccount(user_id) {
    const [settings, workouts, bw, food, appState, files] = await Promise.all([
      q(sb().from('settings').select('data,updated_at').maybeSingle()),
      all('workouts', 'id,payload,updated_at'),
      all('body_weight', 'date,lb,updated_at'),
      all('food_entries', 'id,date,payload,updated_at'),
      all('app_state', 'key,value,updated_at'),
      sb().storage.from('photos').list(user_id, { limit: 1000 }).then(r => { if (r.error) throw r.error; return r.data || []; }),
    ]);
    const empty = !settings && !workouts.length && !bw.length && !food.length && !appState.length && !files.length;
    return empty ? null : { settings, workouts, bw, food, appState, files };
  }

  async function downloadPhotos(user_id, files) {
    const out = {};
    for (const f of files) {
      if (!f.name.endsWith('.jpg')) continue;
      const { data, error } = await sb().storage.from('photos').download(`${user_id}/${f.name}`);
      if (error) throw error;
      out[f.name.slice(0, -4)] = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(data); });
    }
    return out;
  }

  // Replace this phone's copy with the account copy (fresh install, or a different account signed in).
  async function hydrate(user_id, signal) {
    const acc = await fetchAccount(user_id);
    if (signal?.late) throw new Error('late');                // boot gave up waiting; the app already rendered
    if (!acc) {
      // New account: keep what's on this phone unless it belonged to someone else, then upload it.
      const cleared = !!(state.owner && state.owner !== user_id);
      if (cleared) localKeys().forEach(k => setRaw(k, undefined));
      state = { ...fresh(), owner: user_id, hydrated: true }; saveState();
      markAll();
      origSet.call(localStorage, OFFER_KEY, '1');          // brand-new account: offer "Bring your Caliber history"
      return { replaced: cleared };
    }
    const photos = acc.files.length ? await downloadPhotos(user_id, acc.files) : {};
    if (signal?.late) throw new Error('late');
    const next = fresh(); next.owner = user_id; next.hydrated = true;
    suppress++;
    try {
      localKeys().forEach(k => origRemove.call(localStorage, P + k));
      if (acc.settings) { setRaw('settings', acc.settings.data); next.k.settings = { h: H(acc.settings.data), u: acc.settings.updated_at }; }
      acc.appState.forEach(r => { if (TABLE_KEYS.has(r.key) || EXCLUDE.has(r.key)) return; setRaw(r.key, r.value); next.k[r.key] = { h: H(r.value), u: r.updated_at }; });
      const logs = acc.workouts.slice().sort((a, b) => (a.payload.__seq || 0) - (b.payload.__seq || 0)).map(r => {
        const e = strip(r.payload); next.w[r.id] = { h: H(e), u: r.updated_at, s: r.payload.__seq || 0 }; return e; });
      if (logs.length) setRaw('logs', logs);
      const food = {};
      acc.food.slice().sort((a, b) => (a.payload.__seq || 0) - (b.payload.__seq || 0)).forEach(r => {
        const e = strip(r.payload); (food[r.date] = food[r.date] || []).push(e);
        next.f[r.id] = { h: H({ ...e, __date: r.date }), u: r.updated_at, s: r.payload.__seq || 0 }; });
      if (acc.food.length) setRaw('food', food);
      const bw = acc.bw.map(r => ({ date: r.date, w: +r.lb })).sort((a, b) => a.date < b.date ? -1 : 1);
      bw.forEach((e, i) => { next.b[e.date] = { h: H(e), u: acc.bw.find(r => r.date === e.date).updated_at }; });
      if (bw.length) setRaw('bw', bw);
      if (Object.keys(photos).length) { setRaw('photos', photos); Object.keys(photos).forEach(id => { next.ph[id] = 1; }); }
      next.seq = Math.max(0, ...Object.values(next.w).map(x => x.s), ...Object.values(next.f).map(x => x.s));
      next.lastAt = Date.now();
    } finally { suppress--; }
    state = next; dirty = new Set(); saveState(); saveDirty();
    return { replaced: true };
  }

  // Bring in records another device changed since this phone last synced. Never touches dirty keys.
  async function pullChanges(user_id, signal) {
    const acc = await fetchAccount(user_id);
    if (signal?.late || !acc) return 0;
    let n = 0;
    suppress++;
    try {
      if (!dirty.has('settings') && acc.settings && acc.settings.updated_at !== state.k.settings?.u) {
        setRaw('settings', acc.settings.data); state.k.settings = { h: H(acc.settings.data), u: acc.settings.updated_at }; n++;
      }
      const serverKeys = new Set();
      acc.appState.forEach(r => {
        if (TABLE_KEYS.has(r.key) || EXCLUDE.has(r.key)) return;
        serverKeys.add(r.key);
        if (!dirty.has(r.key) && r.updated_at !== state.k[r.key]?.u) { setRaw(r.key, r.value); state.k[r.key] = { h: H(r.value), u: r.updated_at }; n++; }
      });
      Object.keys(state.k).forEach(k => { if (k !== 'settings' && !serverKeys.has(k) && !dirty.has(k)) { setRaw(k, undefined); delete state.k[k]; n++; } });
      if (!dirty.has('logs')) n += mergeList('logs', 'w', acc.workouts, r => r.id, r => strip(r.payload), e => e);
      if (!dirty.has('food')) {
        const flat = []; Object.entries(getJSON('food') || {}).forEach(([d, l]) => (l || []).forEach(e => flat.push({ ...e, __date: d })));
        const changes = mergeRows('f', flat, acc.food, r => r.id, r => ({ ...strip(r.payload), __date: r.date }));
        if (changes.n) {
          const food = {};
          changes.list.forEach(e => { const { __date, ...x } = e; (food[__date] = food[__date] || []).push(x); });
          setRaw('food', food); n += changes.n;
        }
      }
      if (!dirty.has('bw')) {
        const sv = acc.bw.map(r => ({ date: r.date, w: +r.lb, u: r.updated_at }));
        const changedBw = sv.some(e => state.b[e.date]?.u !== e.u) || Object.keys(state.b).length !== sv.length;
        if (changedBw) {
          const bw = sv.map(({ u, ...e }) => e).sort((a, b) => a.date < b.date ? -1 : 1);
          state.b = {}; sv.forEach(e => { state.b[e.date] = { h: H({ date: e.date, w: e.w }), u: e.u }; });
          setRaw('bw', bw); n++;
        }
      }
    } finally { suppress--; }
    saveState();
    return n;
  }
  // logs: rebuild the array in sequence order when any record changed or disappeared
  function mergeList(key, slot, rows, idOf, toEntry) {
    const local = getJSON(key) || [];
    const r = mergeRows(slot, local, rows, idOf, toEntry);
    if (r.n) setRaw(key, r.list);
    return r.n;
  }
  function mergeRows(slot, localList, rows, idOf, toEntry) {
    const map = state[slot], byId = new Map(rows.map(r => [String(idOf(r)), r]));
    let n = 0;
    const kept = [];
    localList.forEach(e => {
      const id = String(e.id), r = byId.get(id);
      if (!r) { if (map[id]) { delete map[id]; n++; return; } kept.push({ e, s: Infinity }); return; }   // deleted elsewhere / never pushed
      if (r.updated_at !== map[id]?.u) { const ne = toEntry(r); map[id] = { h: H(ne), u: r.updated_at, s: r.payload.__seq || 0 }; kept.push({ e: ne, s: map[id].s }); n++; }
      else kept.push({ e, s: map[id].s });
      byId.delete(id);
    });
    byId.forEach((r, id) => { const ne = toEntry(r); map[id] = { h: H(ne), u: r.updated_at, s: r.payload.__seq || 0 }; kept.push({ e: ne, s: map[id].s }); n++; });
    state.seq = Math.max(state.seq, ...Object.values(map).map(x => x.s || 0));
    kept.sort((a, b) => a.s - b.s);
    return { n, list: kept.map(x => x.e) };
  }

  // ---------- backup import (milestone 5) ----------
  // Counts the same way the web app's restore sheet does (backupSummary), plus what rows can actually hold.
  function backupCounts(pl) {
    const get = k => { try { return JSON.parse(pl.data[k]); } catch (e) { return null; } };
    const logs = get('logs') || [], bw = get('bw') || [], food = get('food') || {};
    return {
      workouts: logs.filter(l => l && l.kind === 'lift').length, logs: logs.length,
      weighIns: new Set(bw.filter(e => e && e.date && +e.w > 0).map(e => e.date)).size, weighInsRaw: bw.length,
      foodDays: Object.values(food).filter(l => Array.isArray(l) && l.length).length, foodDaysRaw: Object.keys(food).length,
      foods: Object.values(food).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0),
      photos: Object.keys(get('photos') || {}).length,
    };
  }

  async function importBackup(pl) {
    const user_id = uid();
    if (!user_id) throw new Error('Sign in first.');
    if (!pl || pl.app !== 'calibre' || !pl.data || typeof pl.data !== 'object') throw new Error('That file isn’t a Caliber backup.');
    const expected = backupCounts(pl);
    const overlay = busyOverlay('Importing your history…');
    try {
      // rows go in one transaction on the server; photos (large) go to Storage separately
      const { photos, workout, __cloudAt, ...rest } = pl.data;
      const counts = await q(sb().rpc('import_backup', { data: rest }));
      let photoCount = 0;
      const bucket = sb().storage.from('photos');
      const old = await bucket.list(user_id, { limit: 1000 });
      if (old.data?.length) await bucket.remove(old.data.map(f => `${user_id}/${f.name}`));
      let ph = {}; try { ph = JSON.parse(photos || '{}') || {}; } catch (e) {}
      for (const [id, url] of Object.entries(ph)) {
        const m = /^data:image\/jpeg;base64,(.*)$/.exec(url || ''); if (!m) continue;
        const { error } = await bucket.upload(`${user_id}/${id}.jpg`, Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)), { contentType: 'image/jpeg', upsert: true });
        if (!error) photoCount++;
      }
      counts.photos = photoCount;
      // drop this phone's copy and sync records; the relaunch loads the imported account copy
      suppress++;
      try { localKeys().forEach(k => origRemove.call(localStorage, P + k)); origRemove.call(localStorage, P + 'workout'); } finally { suppress--; }
      origRemove.call(localStorage, OFFER_KEY);
      origSet.call(localStorage, IMPORT_KEY, JSON.stringify({ expected, counts, file: pl.exported || null, at: Date.now() }));
      state = fresh(); dirty = new Set(); saveState(); saveDirty();
      location.reload();
    } catch (e) {
      overlay.remove();
      throw e;
    }
  }

  // ---------- small sheets (styled by shell/auth.css) ----------
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function busyOverlay(text) {
    const scrim = el('div', 'cs-scrim'); const sheet = el('div', 'cs-sheet');
    sheet.append(el('h3', 'cs-h3', text), el('p', 'cs-sub', 'Keep Caliber open. This takes a few seconds.'));
    scrim.append(sheet); document.body.append(scrim); return scrim;
  }
  function sheetWith(title, sub, build) {
    const scrim = el('div', 'cs-scrim'); const sheet = el('div', 'cs-sheet');
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', title);
    const close = () => { scrim.classList.add('cs-out'); setTimeout(() => scrim.remove(), 220); };
    sheet.append(el('div', 'cs-grab'), el('h3', 'cs-h3', title), el('p', 'cs-sub', sub));
    build(sheet, close);
    scrim.addEventListener('click', e => { if (e.target === scrim) close(); });
    window.caliberShell?.draggable?.(sheet, scrim, () => scrim.remove());
    scrim.append(sheet); document.body.append(scrim);
  }
  function showImportResult() {
    let r = null; try { r = JSON.parse(localStorage.getItem(IMPORT_KEY) || 'null'); } catch (e) {}
    if (!r) return;
    origRemove.call(localStorage, IMPORT_KEY);
    const rows = [['Workouts', 'workouts'], ['Weigh-ins', 'weighIns'], ['Food days', 'foodDays'], ['Foods', 'foods'], ['Photos', 'photos']]
      .filter(([, k]) => r.expected[k] || r.counts[k]);
    const allMatch = rows.every(([, k]) => r.expected[k] === r.counts[k]);
    sheetWith(allMatch ? 'History imported' : 'Imported, with differences',
      r.file ? `From your backup made ${new Date(r.file).toLocaleString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.` : 'From your backup file.',
      (sheet, close) => {
        const t = el('table', 'cs-counts');
        const head = el('tr'); ['', 'In backup', 'In account', ''].forEach(x => head.append(el('th', null, x))); t.append(head);
        rows.forEach(([label, k]) => {
          const tr = el('tr'), ok = r.expected[k] === r.counts[k];
          tr.append(el('td', null, label), el('td', 'num', String(r.expected[k] ?? 0)), el('td', 'num', String(r.counts[k] ?? 0)), el('td', ok ? 'cs-ok' : 'cs-bad', ok ? '✓' : '≠'));
          t.append(tr);
        });
        sheet.append(t);
        const notes = [];
        if (r.expected.foodDaysRaw > r.expected.foodDays) notes.push(`${r.expected.foodDaysRaw - r.expected.foodDays} food day(s) in the backup had no foods, so there was nothing to store.`);
        if (r.expected.weighInsRaw > r.expected.weighIns) notes.push(`${r.expected.weighInsRaw - r.expected.weighIns} weigh-in(s) were duplicates or empty.`);
        if (r.counts.skipped?.length) notes.push(`Skipped unreadable settings: ${r.counts.skipped.join(', ')}.`);
        if (notes.length) sheet.append(el('p', 'cs-sub', notes.join(' ')));
        const b = el('button', 'cs-btn cs-accent'); b.append(el('span', 'cs-label', 'Done')); b.addEventListener('click', close); sheet.append(b);
      });
  }
  function offerImport() {
    if (localStorage.getItem(OFFER_KEY) !== '1') return;
    if (document.querySelector?.('.cs-gate')) return;     // signed out, or waiting for web approval: offer it on a later open
    origRemove.call(localStorage, OFFER_KEY);
    sheetWith('Bring your Caliber history', 'Have a backup file from the Caliber web app? Import it and your workouts, weigh-ins and food come with you.', (sheet, close) => {
      const input = el('input'); input.type = 'file'; input.accept = '.json,application/json'; input.style.display = 'none';
      const msg = el('p', 'cs-status');
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0]; if (!f) return;
        let pl = null; try { pl = JSON.parse(await f.text()); } catch (e) {}
        try { close(); await importBackup(pl); } catch (e) { offerAgain(e.message); }
      });
      const pick = el('button', 'cs-btn cs-accent'); pick.append(el('span', 'cs-label', 'Choose backup file')); pick.addEventListener('click', () => input.click());
      const skip = el('button', 'cs-link', 'Not now'); skip.addEventListener('click', close);
      sheet.append(input, pick, msg, skip);
    });
    function offerAgain(m) { origSet.call(localStorage, OFFER_KEY, '1'); offerImport(); const s = document.querySelectorAll('.cs-status'); const last = s[s.length - 1]; if (last) { last.textContent = m; last.dataset.tone = 'warn'; } }
  }

  // ---------- lifecycle ----------
  let booted = false;
  async function boot(statusCb) {
    onStatus = statusCb || null;
    try {
      const { data } = await sb().auth.getSession();
      const id = data.session?.user?.id;
      signedIn = !!id;
      if (!id) return;
      if (state.owner !== id || !state.hydrated) {
        // fresh install (the Keychain session survives a reinstall) or another account: load the account copy first
        await withTimeout(s => hydrate(id, s), 25000).catch(e => { err = isNetErr(e) ? 'offline' : e.message; });
        if (!state.hydrated) retryHydrate();
      } else if (navigator.onLine) {
        // short waits: on a slow connection the app opens on this phone's copy and keeps syncing after
        await withTimeout(() => flush(), 2500).catch(() => {});
        if (!dirty.size) await withTimeout(s => pullChanges(id, s), 3000).catch(() => {});
      }
    } finally { booted = true; emit(); setTimeout(() => { showImportResult(); offerImport(); }, 2600); }
  }
  // The account copy couldn't load at launch (offline or slow): keep trying, then restart the app on it.
  let retrying = null;
  function retryHydrate() {
    if (retrying) return;
    retrying = setInterval(() => {
      const id = uid();
      if (!id || state.hydrated) { clearInterval(retrying); retrying = null; return; }
      if (!navigator.onLine) return;
      hydrate(id).then(r => { clearInterval(retrying); retrying = null; if (r.replaced) location.reload(); else emit(); }).catch(() => {});
    }, 20000);
  }

  sb().auth.onAuthStateChange((event, session) => {
    signedIn = !!session;
    if (event === 'SIGNED_OUT') { clearTimeout(timer); emit(); return; }
    if (event !== 'SIGNED_IN' || !booted || !session) { emit(); return; }
    const id = session.user.id;
    if (state.owner === id && state.hydrated) { flush(); return; }
    // signed in after the app opened: load this account's copy, then restart the app on it
    setTimeout(() => hydrate(id).then(r => { if (r.replaced) location.reload(); else { emit(); offerImport(); } })
      .catch(e => { err = e.message; emit(); }), 0);
  });
  window.addEventListener('online', () => {
    const id = uid();
    if (id && booted && (state.owner !== id || !state.hydrated)) hydrate(id).then(r => { if (r.replaced) location.reload(); else emit(); }).catch(() => {});
    else schedule(500);
  });
  window.addEventListener('offline', () => { err = 'offline'; emit(); });
  // Back in front: another device may have changed things, so pull them and reload the app on the new data,
  // unless a workout is in progress (it picks them up when it finishes). At most once a minute.
  let lastResumePull = 0;
  async function pullOnResume() {
    const id = uid();
    if (!id || !booted || !state.hydrated || state.owner !== id || !navigator.onLine) return;
    if (Date.now() - lastResumePull < 60000) return;
    lastResumePull = Date.now();
    try {
      await flush();
      if (dirty.size) return;                         // local changes still unsent: the next launch merges them
      const n = await pullChanges(id);
      if (n && localStorage.getItem(P + 'workout') == null) location.reload();
      else emit();
    } catch (e) { /* offline or slow: the next launch syncs */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); else pullOnResume(); });

  window.caliberSync = {
    boot, mark, markAll, flush, importBackup,
    // account deletion / sign-out cleanup
    reset() { suppress++; try { origRemove.call(localStorage, STATE_KEY); origRemove.call(localStorage, DIRTY_KEY); } finally { suppress--; } state = fresh(); dirty = new Set(); },
    status: () => ({ ok: isOk(), lastAt: state.lastAt, pending: dirty.size, err, owner: state.owner }),
  };
})();
