/* robots.txt (Fast-Track Phase 4).

   Served dynamically rather than as a static file, for two reasons: the
   sitemap URL must be absolute and derived from PUBLIC_SITE_ORIGIN (a static
   file would have to hard-code a hostname), and non-production origins must
   be able to answer differently without a second deployment artefact.

   DISALLOW IS NOT A SECURITY CONTROL. Everything listed below is already
   protected server-side; robots.txt only asks well-behaved crawlers not to
   waste requests. It deliberately does NOT enumerate anything sensitive —
   a robots.txt is a public document, and a list of "interesting" paths in it
   is a map for anyone who reads it. The entries below are namespaces a
   visitor can already see in the site's own markup (the portal link, the API
   origin), so listing them reveals nothing new. */

import type { APIContext } from 'astro';
import { env } from '../env.ts';

export const prerender = false;

/* Paths that are not public content. `/admin` and `/api` are served by Caddy
   from other roots; `/s3` is the uploads proxy. None should ever appear in an
   index, and crawling them is pure waste. */
const DISALLOWED = ['/admin', '/api/', '/s3/'];

export async function GET({ site }: APIContext): Promise<Response> {
  const origin = (env.siteOrigin || site?.origin || '').replace(/\/$/, '');

  /* A non-production origin must never invite indexing. Getting this wrong
     is how a staging copy outranks the real site. */
  const isProduction = env.nodeEnv === 'production' && !looksNonProduction(origin);

  const lines = isProduction
    ? [
        'User-agent: *',
        ...DISALLOWED.map((path) => `Disallow: ${path}`),
        '',
        `Sitemap: ${origin}/sitemap.xml`,
        '',
      ]
    : [
        '# Non-production origin — indexing is disallowed in full.',
        'User-agent: *',
        'Disallow: /',
        '',
      ];

  return new Response(lines.join('\n'), {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      /* Short cache: a robots.txt change should take effect quickly, and the
         file is tiny. */
      'cache-control': 'public, max-age=300',
    },
  });
}

/** Recognises the origins this project actually uses for non-production, by
    shape rather than by a hard-coded hostname. */
function looksNonProduction(origin: string): boolean {
  return /localhost|127\.0\.0\.1|\.local(?::|$)|^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(origin);
}
