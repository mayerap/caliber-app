// Caliber native shell: bridges to the native screens and devices.
// - logger: the SwiftUI workout logger (app/ios/App/App/Logger/CaliberLoggerPlugin.swift); calibre.html renders
//   NativeLogger instead of the web Logger whenever it's present.
// - watch: the Apple Watch app (app/ios/App/App/CaliberWatchPlugin.swift); calibre.html sends today's plan and the
//   workout, and takes back the Watch's workout and finished sessions.
// - fitness: the live cardio coach (cues, Lock Screen countdown) and Apple Health workouts
//   (app/ios/App/App/CaliberFitnessPlugin.swift).
// - places: one-shot location for the optional gym/home suggestion (app/ios/App/App/CaliberPlacesPlugin.swift).
// - system: the rest-timer Live Activity and the Home Screen widgets (app/ios/App/App/CaliberSystemPlugin.swift),
//   including water and caffeine logged from a widget's buttons and the widgets' caliber://open/… links.
(() => {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  const listen = (plugin, event) => cb => {
    const handle = plugin.addListener(event, cb);
    return () => { Promise.resolve(handle).then(h => h && h.remove()); };
  };
  const native = window.caliberNative = {};
  if (cap.isPluginAvailable('CaliberLogger')) {
    const plugin = window.capacitorExports.registerPlugin('CaliberLogger');
    native.logger = {
      show: opts => plugin.show(opts),
      close: () => plugin.close(),
      respond: (id, result) => plugin.respond({ id, result: JSON.stringify(result === undefined ? null : result) }),
      listen: listen(plugin, 'logger'),
      // filmed sets: which clips are on this iPhone, and sharing one with its card burned in
      videos: names => plugin.videos({ names }).then(r => r.have || []).catch(() => []),
      shareSetVideo: opts => plugin.shareSetVideo(opts),
      saveSetVideo: opts => plugin.saveSetVideo(opts),
      // a natural-voice clip (MP3, base64) for a cue the logger will say, fetched by calibre.html during the rest
      voiceClip: (text, b64) => plugin.voiceClip({ text, b64 }).catch(() => {}),
      // say a line with the iPhone's best installed voice (the web view only reaches the basic ones)
      say: text => plugin.say({ text }).catch(() => {}),
    };
  }
  if (cap.isPluginAvailable('CaliberWatch')) {
    const plugin = window.capacitorExports.registerPlugin('CaliberWatch');
    native.watch = { update: msg => plugin.update(msg).catch(() => {}), listen: listen(plugin, 'watch') };
  }
  if (cap.isPluginAvailable('CaliberFitness')) {
    const plugin = window.capacitorExports.registerPlugin('CaliberFitness');
    native.fitness = {
      // live GPS during an outdoor session: { id, distM, pace, avg (seconds per meter), splits, splitM, up (climb, m) }
      onGps: listen(plugin, 'gps'),
      cardio: msg => plugin.cardio(msg).catch(() => {}),
      finishCardio: () => plugin.finishCardio(),
      discardCardio: () => plugin.discardCardio().catch(() => {}),
      saveWorkout: w => plugin.saveWorkout(w).catch(() => ({ saved: false })),
      sleep: days => plugin.sleep({ days }).then(r => r.samples || []).catch(() => []),
      // overnight recovery measurements for readiness: [{ t: hrv | rhr | resp | temp, s, v, src }]
      recovery: days => plugin.recovery({ days }).then(r => r.samples || []).catch(() => []),
      // { sleep, all }: whether iPhone already asked, so reading won't pop up a permission sheet
      healthStatus: () => plugin.healthStatus().catch(() => ({})),
      // one Health sheet for sleep, recovery and workouts
      connect: () => plugin.connect().then(r => !!r.ok).catch(() => false),
      // an Apple Maps picture of a map rect (MKMapPoint units) for the map under a route; null offline
      routeMap: opts => plugin.routeMap(opts).then(r => cap.convertFileSrc(r.path)).catch(() => null),
    };
  }
  if (cap.isPluginAvailable('CaliberPlaces')) {
    const plugin = window.capacitorExports.registerPlugin('CaliberPlaces');
    native.places = { here: () => plugin.here() };
  }
  if (cap.isPluginAvailable('CaliberSystem')) {
    const plugin = window.capacitorExports.registerPlugin('CaliberSystem');
    native.system = { rest: r => plugin.rest(r).catch(() => {}), widgets: data => plugin.widgets({ data }).catch(() => {}),
      // the workout in progress, kept on the iPhone (WorkoutStore) for the logger, the Watch and the Lock Screen;
      // -> { newer } when the Watch or a Lock Screen button changed it since
      live: (ws, units, name) => plugin.live({ ws, units, name }).catch(() => ({})),
      // the workout as changed on the Watch or the Lock Screen: { ws }
      listen: listen(plugin, 'workout'),
      // replaces scheduled reminders ([{ id, title, body, at }]) and the "Rest's up" alert; -> { granted, scheduled }
      reminders: (items, rest) => plugin.reminders({ items, rest }).catch(() => ({ granted: false, scheduled: 0 })),
      // water and caffeine tapped on a Home Screen widget since Caliber was last open (taken once)
      pending: () => plugin.pending().then(r => r.items || []).catch(() => []) };
  }
  // Widget links: caliber://open/<screen> (food, week, today), and friend invites: caliber://friend/<code>,
  // whether Caliber was running or launched by the tap.
  // calibre.html reads window.__caliberOpen when it starts and on each caliber:open event.
  if (cap.isPluginAvailable('App')) {
    const app = window.capacitorExports.registerPlugin('App');
    const route = url => {
      const m = /^caliber:\/\/open\/([a-z]+)/.exec(url || ''), f = /^caliber:\/\/friend\/([A-Za-z0-9-]{8,9})/.exec(url || '');
      if (!m && !f) return;
      window.__caliberOpen = m ? m[1] : 'friend:' + f[1].replace('-', '');
      document.dispatchEvent(new Event('caliber:open'));
    };
    app.addListener('appUrlOpen', e => route(e.url));
    app.getLaunchUrl().then(l => route(l && l.url)).catch(() => {});
  }
})();
