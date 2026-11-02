// Caliber native shell: library requests (supabase/migrations/20261101000000_exercise_requests.sql). When someone adds
// their own exercise and asks for it, calibre.html sends it here; the owner reviews them (docs/custom-exercises.md).
(() => {
  const sb = () => window.caliberShell?.supabase;

  window.caliberRequests = {
    // 'duplicate' (already asked for this one), 'too_many', 'not_signed_in' or 'error'
    reason: e => (e && e.code === '23505' ? 'duplicate' : e && /^[a-z_]+$/.test(e.message || '') ? e.message : 'error'),
    exercise: async ({ name, muscle, equipment, note }) => {
      const s = sb();
      const session = s && (await s.auth.getSession()).data.session;
      if (!session) throw { message: 'not_signed_in' };
      const { error } = await s.from('exercise_requests').insert({ name, muscle: muscle || null, equipment: equipment || null, note: note || null });
      if (error) throw error;
    },
    // your requests the owner has answered: [{ name, status: 'added' | 'declined', library_id, reply }]
    // (supabase/migrations/20261102000000_exercise_request_digest.sql lets people read only their own)
    answers: async () => {
      const s = sb();
      const session = s && (await s.auth.getSession()).data.session;
      if (!session) return [];
      const { data, error } = await s.from('exercise_requests').select('name, status, library_id, reply').neq('status', 'new');
      if (error) throw error;
      return data || [];
    },
  };
})();
