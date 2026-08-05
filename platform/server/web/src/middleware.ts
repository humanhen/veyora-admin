/* Thin wrapper around the pure resolveRedirect() (src/lib/redirects.ts) —
   this file's only job is translating Astro's request context into a
   pathname/search pair and, if a redirect is due, returning it. All
   redirect decision logic lives in redirects.ts so it can be unit tested
   without an Astro request context. */
import { defineMiddleware } from 'astro:middleware';
import { resolveRedirect } from './lib/redirects.ts';

export const onRequest = defineMiddleware((context, next) => {
  const { pathname, search } = context.url;
  const redirect = resolveRedirect(pathname, search);
  if (redirect) {
    return context.redirect(redirect.location, redirect.status);
  }
  return next();
});
