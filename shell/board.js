// Caliber native shell: the opt-in Your Caliber leaderboard (supabase/migrations/20261030000000_leaderboard.sql).
// calibre.html decides what goes on the board (LeaderboardSheet, boardRow); this only reads and writes the
// table with the signed-in session, and tells an open leaderboard when anyone's row changes (Realtime).
(() => {
  const sb = () => window.caliberShell?.supabase;
  async function uid() {
    const s = sb();
    const session = s && (await s.auth.getSession()).data.session;
    return session ? session.user.id : null;
  }
  const COLS = 'user_id,nickname,score,bracket,sex,lifts,updated_at,name_locked';
  const division = (q, { sex, bracket }) => { q = q.eq('sex', sex); return bracket ? q.eq('bracket', bracket) : q; };

  window.caliberBoard = {
    me: uid,
    // { nickname, sex, bracket, score, lifts } for the signed-in lifter
    publish: async row => {
      const id = await uid();
      if (!id) throw { code: 'not_signed_in' };
      const { error } = await sb().from('leaderboard').upsert({ user_id: id, ...row });
      if (error) throw error;
    },
    // my row as others see it (the name may have been locked by Caliber), or null
    mine: async () => {
      const id = await uid();
      if (!id) return null;
      const { data, error } = await sb().from('leaderboard').select(COLS).eq('user_id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },
    leave: async () => {
      const id = await uid();
      if (!id) return;
      const { error } = await sb().from('leaderboard').delete().eq('user_id', id);
      if (error) throw error;
    },
    // The top of a division (bracket null = all ages), highest score first; ties go to whoever got there first
    top: async ({ sex, bracket, limit = 10 }) => {
      const { data, error } = await division(sb().from('leaderboard').select(COLS), { sex, bracket })
        .order('score', { ascending: false }).order('updated_at', { ascending: true }).limit(limit);
      if (error) throw error;
      return data || [];
    },
    // Where a score ranks in a division: lifters with a higher score, plus one (ties share a place), and the division size
    rank: async ({ sex, bracket, score }) => {
      const head = { count: 'exact', head: true };
      const [above, all] = await Promise.all([
        division(sb().from('leaderboard').select('user_id', head), { sex, bracket }).gt('score', score),
        division(sb().from('leaderboard').select('user_id', head), { sex, bracket }),
      ]);
      if (above.error || all.error) throw above.error || all.error;
      return { rank: (above.count || 0) + 1, of: all.count || 0 };
    },
    // Calls back whenever any row changes; returns a function that stops listening
    watch: cb => {
      const s = sb();
      if (!s) return () => {};
      const ch = s.channel('leaderboard').on('postgres_changes', { event: '*', schema: 'public', table: 'leaderboard' }, () => cb()).subscribe();
      return () => { s.removeChannel(ch); };
    },
  };
})();
