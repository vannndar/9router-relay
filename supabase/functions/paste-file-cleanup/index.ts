import { withSupabase } from 'npm:@supabase/server@1';

export default {
  fetch: withSupabase({ auth: 'secret' }, async (request, ctx) => {
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const admin = ctx.supabaseAdmin;
    const { data, error } = await admin.rpc('paste_file_cleanup_candidates');
    if (error) return Response.json({ error: 'Cleanup queue unavailable' }, { status: 500 });
    const paths = (data || []).map((item: { storage_path: string }) => item.storage_path);
    if (!paths.length) return Response.json({ deleted: 0 });
    const deleted = await admin.storage.from('paste-files').remove(paths);
    if (deleted.error) return Response.json({ error: 'File cleanup failed' }, { status: 502 });
    const acknowledged = await admin.rpc('paste_file_cleanup_done', { p_paths: paths });
    if (acknowledged.error) return Response.json({ error: 'Cleanup acknowledgement failed' }, { status: 500 });
    return Response.json({ deleted: paths.length });
  }),
};
