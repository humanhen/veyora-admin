/* A minimal reverse proxy, built from Node core only.

   It exists so the enquiry-form tests can exercise the PRODUCTION request
   topology rather than a convenient approximation of it. In production,
   browser traffic reaches Caddy on the public origin and Caddy forwards to
   the Astro standalone server on an internal port, rewriting `Host` to the
   public host and adding the `X-Forwarded-*` family. Astro's
   `NodeApp.createRequest()` reconstructs the request URL from exactly those
   headers, and its CSRF `checkOrigin` middleware then compares the browser's
   `Origin` against that reconstructed origin.

   Testing against the internal server directly skips all of that, which is
   how the overnight run ended up unable to reproduce the real behaviour. This
   proxy reproduces the header contract Caddy provides; it does not attempt to
   be Caddy, and a real RC smoke test is still required.

   No dependency, no TLS, loopback only. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReverseProxy {
  /** The public origin a browser would use. */
  origin: string;
  port: number;
  /** Every request forwarded upstream, with the headers as rewritten. */
  forwarded: Array<{ method: string; url: string; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}

export interface ReverseProxyOptions {
  /** Port of the Astro standalone server to forward to. */
  upstreamPort: number;
  /** The public origin to present. Defaults to the proxy's own loopback
   * origin, which is what the tests use. */
  publicOrigin?: string;
  /** Omit the X-Forwarded-* family, to exercise a misconfigured proxy. */
  omitForwardedHeaders?: boolean;
  /** Override a single forwarded header, to exercise inconsistency. */
  forwardedOverrides?: Record<string, string>;
}

export async function startReverseProxy(options: ReverseProxyOptions): Promise<ReverseProxy> {
  const forwarded: ReverseProxy['forwarded'] = [];

  const server = http.createServer((clientReq, clientRes) => {
    const publicOrigin = options.publicOrigin ?? resolvedOrigin;
    const publicUrl = new URL(publicOrigin);

    /* What a reverse proxy sets. `host` becomes the PUBLIC host — this is the
       single most important line: without it Astro sees the internal
       host:port, fails its allowedDomains check, and falls back to
       `http://localhost`. */
    const headers: http.OutgoingHttpHeaders = { ...clientReq.headers, host: publicUrl.host };

    if (!options.omitForwardedHeaders) {
      headers['x-forwarded-proto'] = publicUrl.protocol.replace(':', '');
      headers['x-forwarded-host'] = publicUrl.host;
      headers['x-forwarded-port'] = publicUrl.port || (publicUrl.protocol === 'https:' ? '443' : '80');
      headers['x-forwarded-for'] = '127.0.0.1';
    }
    for (const [key, value] of Object.entries(options.forwardedOverrides ?? {})) {
      headers[key] = value;
    }

    forwarded.push({ method: clientReq.method ?? '', url: clientReq.url ?? '', headers: { ...headers } as http.IncomingHttpHeaders });

    const upstream = http.request(
      {
        host: '127.0.0.1',
        port: options.upstreamPort,
        path: clientReq.url,
        method: clientReq.method,
        headers,
      },
      (upstreamRes) => {
        clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(clientRes);
      }
    );
    upstream.on('error', (err) => {
      clientRes.writeHead(502, { 'content-type': 'text/plain' });
      clientRes.end(`proxy upstream error: ${err.message}`);
    });
    clientReq.pipe(upstream);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const resolvedOrigin = options.publicOrigin ?? `http://127.0.0.1:${port}`;

  return {
    origin: resolvedOrigin,
    port,
    forwarded,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/**
 * Issues a request with full control over headers.
 *
 * `fetch()` cannot be used for these tests: `Origin` is a FORBIDDEN HEADER
 * NAME in the Fetch spec, so `fetch` silently refuses to set it. A browser
 * sets it automatically on a same-origin form submission; a test has to use a
 * client that can.
 */
export function rawRequest(
  port: number,
  path: string,
  { method = 'GET', headers = {}, body = '' }: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const outgoing: Record<string, string | number> = { ...headers };
    if (body) outgoing['content-length'] = Buffer.byteLength(body);

    const req = http.request({ host: '127.0.0.1', port, path, method, headers: outgoing }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { out += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: out }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** Encodes fields exactly as a browser encodes a `<form method="post">`. */
export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}
