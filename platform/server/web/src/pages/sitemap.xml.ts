/* XML sitemap (Fast-Track Phase 4).

   Built from getSitemapData() through the existing server-side public API
   client, plus the hand-listed static routes.

   AN UPSTREAM FAILURE ANSWERS NON-200, NEVER AN EMPTY SITEMAP. A sitemap
   containing only the static routes would be an authoritative-looking claim
   that no brand or model exists, which is exactly the signal that gets
   published pages de-indexed. A 503 tells a crawler to come back; a short
   200 tells it to forget things. */

import type { APIContext } from 'astro';
import { getSitemapData, PUBLIC_API_FAILURE_STATUS } from '../lib/public-api.ts';
import { buildSitemapEntries, renderSitemapXml } from '../lib/sitemap-xml.ts';
import { env } from '../env.ts';

export const prerender = false;

export async function GET({ site }: APIContext): Promise<Response> {
  const origin = (env.siteOrigin || site?.origin || '').replace(/\/$/, '');
  const result = await getSitemapData();

  if (!result.ok) {
    return new Response(
      `<?xml version="1.0" encoding="UTF-8"?>\n<!-- sitemap temporarily unavailable -->\n`,
      {
        status: PUBLIC_API_FAILURE_STATUS[result.kind],
        headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'no-store' },
      }
    );
  }

  const xml = renderSitemapXml(buildSitemapEntries(result.data, { origin }));
  return new Response(xml, {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      /* Short enough that a publication appears quickly, long enough that a
         crawler hammering it costs nothing. */
      'cache-control': 'public, max-age=600',
    },
  });
}
