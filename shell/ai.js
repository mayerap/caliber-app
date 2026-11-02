// Caliber native shell: AI food features through the ai-food Edge Function (CALIBER_HANDOFF.md 10),
// and the natural voice for rest cues through the tts Edge Function.
// Replaces the web app's `sample` capability; the prompts live on the server, so this only sends
// { mode, text | image | images } and returns the server's cleaned-up JSON. calibre.html maps the result.
(() => {
  const CFG = window.CALIBER_SUPABASE;
  if (!CFG) return;

  const blobToBase64 = blob => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

  async function call(body, signal) {
    const sb = window.caliberShell?.supabase;
    const session = sb && (await sb.auth.getSession()).data.session;
    if (!session) throw { code: 'not_signed_in' };
    let res;
    try {
      res = await fetch(`${CFG.url}/functions/v1/ai-food`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}`, apikey: CFG.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) { throw e && e.name === 'AbortError' ? { code: 'aborted' } : { code: 'offline' }; }
    const out = await res.json().catch(() => ({}));
    if (res.status === 429) throw { code: 'rate_limited' };
    if (!res.ok) throw { code: out.error || `http_${res.status}` };
    return out;
  }

  window.caliberAI = {
    // -> { label, serving, kcal, protein, carbs, fat }
    estimate: text => call({ mode: 'estimate', text }),
    // -> { items: [...] }; image is a JPEG Blob already scaled to 1280 px by calibre.html
    analyze: async ({ text, image }) => image
      ? call({ mode: 'photo', image: await blobToBase64(image) })
      : call({ mode: 'describe', text }),
    // Program import -> the CSV text Caliber's importer reads; images are JPEG Blobs (photos or PDF pages, up to 4).
    // wod: true asks for just "WOD" when it's a single workout, which calibre.html then reads with readWod.
    readProgram: async ({ images, text, signal }) => (await call(images && images.length
      ? { mode: 'program', wod: true, images: await Promise.all(images.slice(0, 4).map(blobToBase64)) }
      : { mode: 'program', wod: true, text }, signal)).text,
    // A whiteboard workout -> { name, format, minutes, text, blocks }; images are JPEG Blobs (<= 1600 px, up to 2), or pasted text
    readWod: async ({ images, text, signal }) => call(images && images.length
      ? { mode: 'wod', images: await Promise.all(images.slice(0, 2).map(blobToBase64)) }
      : { mode: 'wod', text }, signal),
  };

  // Spoken cues through the tts Edge Function (a natural cloud voice). Resolves to { blob, b64 } (MP3),
  // or null when signed out, offline or not set up, so calibre.html falls back to the phone's voice.
  window.caliberVoice = {
    clip: async text => {
      try {
        const sb = window.caliberShell?.supabase;
        const session = sb && (await sb.auth.getSession()).data.session;
        if (!session) return null;
        const res = await fetch(`${CFG.url}/functions/v1/tts`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}`, apikey: CFG.publishableKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        if (!res.ok || !/audio/.test(res.headers.get('Content-Type') || '')) return null;
        const blob = await res.blob();
        return { blob, b64: await blobToBase64(blob) };
      } catch (e) { return null; }
    },
  };
})();
