// Caliber native shell: friends (supabase/migrations/20261031000000_friends.sql). calibre.html decides what's
// shared (socialSummary, the activity it posts) and draws the screens; this reads and writes with the signed-in
// session. Friendships and requests only change through the database's own functions.
(() => {
  const sb = () => window.caliberShell?.supabase;
  async function uid() {
    const s = sb();
    if (!s) return null;
    const session = s && (await s.auth.getSession()).data.session;
    return session ? session.user.id : null;
  }
  async function rpc(name, args) {
    const { data, error } = await sb().rpc(name, args || {});
    if (error) throw error;
    return data;
  }
  // Database errors raised by the functions carry their reason in the message ('no_such_code', 'own_code' ...)
  const reason = e => (e && /^[a-z_]+$/.test(e.message || '') ? e.message : (e && e.code) || 'error');

  window.caliberFriends = {
    me: uid,
    reason,
    // my shared profile: { nickname, summary, discoverable } (summary null = friends see only the name)
    // row.avatar (a small JPEG data URL, or null) needs 20261107000000_friend_avatars.sql; until that's run the
    // column is missing (PGRST204), so the rest is saved without it
    publish: async row => {
      const id = await uid();
      if (!id) throw { message: 'not_signed_in' };
      let { error } = await sb().from('profiles_public').upsert({ user_id: id, ...row });
      if (error && 'avatar' in row && (error.code === 'PGRST204' || /avatar/.test(error.message || ''))) {
        const { avatar, ...rest } = row;
        ({ error } = await sb().from('profiles_public').upsert({ user_id: id, ...rest }));
      }
      if (error) throw error;
    },
    mine: async () => {
      const id = await uid();
      if (!id) return null;
      const { data, error } = await sb().from('profiles_public').select('nickname,summary,discoverable,updated_at').eq('user_id', id).maybeSingle();
      if (error) throw error;
      return data || null;
    },
    // invite code, made on first use; fresh: a new one, and the old link stops working
    code: fresh => rpc('friend_code', { fresh: !!fresh }),
    addByCode: async code => (await rpc('friend_add_by_code', { p_code: code }))[0] || null,
    search: q => rpc('friend_search', { q }),
    request: id => rpc('friend_request', { p_to: id }),
    respond: (id, accept) => rpc('friend_respond', { p_from: id, p_accept: !!accept }),
    cancel: id => rpc('friend_cancel', { p_to: id }),
    remove: id => rpc('friend_remove', { p_other: id }),
    // [{ user_id, nickname, summary, updated_at, since, avatar }] (avatar once the friend_avatars migration is in)
    list: () => rpc('friend_list'),
    // [{ user_id, nickname, incoming, created_at }]
    inbox: () => rpc('friend_inbox'),
    // Friend alerts (supabase/migrations/20261105000000_push_friends.sql): this phone's Apple push token, and whether
    // it gets friend requests and new friends. The token is kept so signing out can take it back.
    pushRegister: async (token, env, on) => {
      await rpc('push_register', { p_token: token, p_env: env || 'production', p_friends: !!on });
      localStorage.setItem('calibre:pushToken', JSON.stringify(token));
    },
    pushUnregister: async () => {
      let t = null;
      try { t = JSON.parse(localStorage.getItem('calibre:pushToken') || 'null'); } catch (e) {}
      if (!t || !(await uid())) return;
      await rpc('push_unregister', { p_token: t });
      localStorage.removeItem('calibre:pushToken');
    },

    // Activity: { log_id, kind: 'lift' | 'cardio', at (ms), item } for one finished session; posting again replaces it
    post: async a => {
      const id = await uid();
      if (!id) throw { message: 'not_signed_in' };   // so the app tries again later instead of counting it as done
      const { error } = await sb().from('friend_activity')
        .upsert({ user_id: id, log_id: a.log_id, kind: a.kind, at: new Date(a.at).toISOString(), item: a.item }, { onConflict: 'user_id,log_id' });
      if (error) throw error;
    },
    unpost: async logId => {
      const id = await uid();
      if (!id) throw { message: 'not_signed_in' };   // so the app tries again later instead of counting it as done
      const { error } = await sb().from('friend_activity').delete().eq('user_id', id).eq('log_id', logId);
      if (error) throw error;
    },
    // Newest first, mine and my friends': [{ id, user_id, kind, at, item, reactions: [{ user_id, emoji }] }]
    feed: async (limit = 40) => {
      const { data, error } = await sb().from('friend_activity').select('id,user_id,kind,at,item')
        .order('at', { ascending: false }).limit(limit);
      if (error) throw error;
      const rows = data || [];
      if (!rows.length) return rows;
      const r = await sb().from('activity_reactions').select('activity_id,user_id,emoji').in('activity_id', rows.map(x => x.id));
      if (r.error) throw r.error;
      const by = {};
      (r.data || []).forEach(x => { (by[x.activity_id] = by[x.activity_id] || []).push({ user_id: x.user_id, emoji: x.emoji }); });
      return rows.map(x => ({ ...x, reactions: by[x.id] || [] }));
    },
    // emoji null takes my reaction away
    react: async (activityId, emoji) => {
      const id = await uid();
      if (!id) throw { message: 'not_signed_in' };   // so the app tries again later instead of counting it as done
      const q = emoji
        ? sb().from('activity_reactions').upsert({ activity_id: activityId, user_id: id, emoji })
        : sb().from('activity_reactions').delete().eq('activity_id', activityId).eq('user_id', id);
      const { error } = await q;
      if (error) throw error;
    },
    // Calls back when a request, activity or reaction that I can see changes; returns a function that stops listening
    watch: cb => {
      const s = sb();
      if (!s) return () => {};
      const ch = s.channel('friends');
      ['friend_requests', 'friend_activity', 'activity_reactions'].forEach(table =>
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => cb(table)));
      ch.subscribe();
      return () => { s.removeChannel(ch); };
    },
  };
})();
