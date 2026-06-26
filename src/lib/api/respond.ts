// Shared response envelope + error codes for /api/v1 (see plan/PERPSPAD_LAUNCH.md §7).
//   success: { ok: true, data }
//   error:   { ok: false, error: { code, message, field? } }
export function apiOk(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

export function apiErr(
  status: number,
  code: string,
  message: string,
  field?: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code, message, ...(field ? { field } : {}) } }),
    { status, headers: { "content-type": "application/json", ...(extraHeaders ?? {}) } },
  );
}
