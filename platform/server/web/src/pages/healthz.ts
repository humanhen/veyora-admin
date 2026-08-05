import type { APIRoute } from 'astro';

// No database or API dependency, no auth, no environment detail in the
// body — this endpoint only asserts that the process is up and answering.
export const prerender = false;

export const GET: APIRoute = () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      // The health endpoint is an operational surface, never a search result.
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
};
