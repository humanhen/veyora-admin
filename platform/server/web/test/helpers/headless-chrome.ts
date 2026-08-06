/* A dependency-free headless-browser driver (Fast-Track WS2 Phase 4).
 *
 * The brief for this phase forbids installing Playwright or downloading a
 * browser binary. It also says to check whether a browser is ALREADY on the
 * machine and can be driven without adding a dependency. It can:
 *
 *   - Chrome and Edge ship with the Chrome DevTools Protocol over a plain
 *     WebSocket, and Node 22 has a global `WebSocket`. So the whole driver is
 *     `spawn()` plus `fetch()` plus `WebSocket` — no package, no download, no
 *     `node_modules` entry, nothing to keep up to date.
 *
 * WHY A REAL BROWSER AT ALL
 *
 * Responsive and accessibility questions are not answerable from source. "Does
 * anything overflow horizontally at 375px", "is this tap target 24px", "is
 * this text contrast 4.5:1 against what is actually behind it" are questions
 * about COMPUTED LAYOUT after CSS cascade and media queries. A DOM shim or a
 * stylesheet scan can only approximate them, and the approximation is wrong in
 * exactly the cases that matter.
 *
 * SAFETY
 *
 *   - A throwaway `--user-data-dir` under the OS temp directory, so the
 *     operator's real Chrome profile, history, cookies and logins are never
 *     opened, read or written.
 *   - `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1` — DNS is dead
 *     inside this browser. It can reach loopback and nothing else, so a
 *     mis-typed URL cannot contact a real host, let alone a Veyora one.
 *   - Background networking, sync, component updates, extensions and the
 *     first-run flow are all disabled.
 *   - Every caller gets `isAvailable()` first. On a machine with no browser
 *     the suite SKIPS with a clear message rather than failing — a QA control
 *     that goes red because of the machine it runs on gets ignored.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Where Chrome and Edge actually install. Checked in order; the first that
   exists wins. No download, no PATH guessing beyond these, and no attempt to
   install anything if none is found. */
const CANDIDATES: string[] = process.platform === 'win32'
  ? [
      String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
      String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
      String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
      String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
    ]
  : process.platform === 'darwin'
    ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];

export function findBrowser(): string | null {
  for (const candidate of CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* not installed here */
    }
  }
  return null;
}

export const isAvailable = (): boolean => findBrowser() !== null;

export interface Viewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly mobile: boolean;
}

/** The three widths this phase audits at, as the brief specifies. */
export const VIEWPORTS: readonly Viewport[] = Object.freeze([
  { name: 'mobile 375', width: 375, height: 812, mobile: true },
  { name: 'tablet 768', width: 768, height: 1024, mobile: false },
  { name: 'desktop 1280', width: 1280, height: 900, mobile: false },
]);

interface CdpMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

export class HeadlessBrowser {
  private child: ChildProcess | undefined;
  private ws: WebSocket | undefined;
  private profile = '';
  private nextId = 0;
  private readonly pending = new Map<number, (m: CdpMessage) => void>();
  private sessionId = '';
  readonly executable: string;

  private constructor(executable: string) {
    this.executable = executable;
  }

  static async launch(port = 9411): Promise<HeadlessBrowser> {
    const executable = findBrowser();
    if (!executable) throw new Error('no Chrome or Edge installation was found');
    const browser = new HeadlessBrowser(executable);
    await browser.start(port);
    return browser;
  }

  /* Sweeps profiles left behind by an earlier run that was interrupted, or
     whose browser outlived its launcher. Without this a leak accumulates
     silently: each abandoned profile keeps a Chrome process group alive and
     several megabytes on disk, and thirty runs later the machine is out of
     space with two hundred orphaned processes. Best-effort — a directory that
     is still locked belongs to a live run and is left alone. */
  private static sweepStaleProfiles(): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('veyora-a11y-'));
    } catch {
      return;
    }
    for (const name of entries) {
      try {
        fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      } catch {
        /* still in use by a concurrent run */
      }
    }
  }

  private async start(port: number): Promise<void> {
    HeadlessBrowser.sweepStaleProfiles();
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'veyora-a11y-'));
    this.child = spawn(this.executable, [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${this.profile}`,
      /* DNS is dead except for loopback. This browser cannot reach a real
         host even if something asked it to. */
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--disable-extensions', '--disable-background-networking', '--disable-sync',
      '--disable-component-update', '--disable-default-apps', '--no-service-autorun',
      '--metrics-recording-only', '--mute-audio',
      'about:blank',
    ], { shell: false, stdio: 'ignore' });

    const deadline = Date.now() + 30_000;
    let version: { webSocketDebuggerUrl: string } | null = null;
    while (Date.now() < deadline && !version) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) version = (await response.json()) as { webSocketDebuggerUrl: string };
      } catch {
        /* not listening yet */
      }
      if (!version) await new Promise((r) => setTimeout(r, 200));
    }
    if (!version) throw new Error('the browser never exposed a debugging endpoint');

    this.ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      this.ws!.onopen = () => resolve();
      this.ws!.onerror = () => reject(new Error('could not connect to the browser'));
    });
    this.ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const resolve = this.pending.get(message.id);
        if (resolve) {
          this.pending.delete(message.id);
          resolve(message);
        }
      }
    };

    const target = await this.rawSend('Target.createTarget', { url: 'about:blank' });
    const attached = await this.rawSend('Target.attachToTarget', {
      targetId: (target.result as { targetId: string }).targetId,
      flatten: true,
    });
    this.sessionId = (attached.result as { sessionId: string }).sessionId;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  private rawSend(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<CdpMessage> {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 30_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message);
      });
      this.ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private send(method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> {
    return this.rawSend(method, params, this.sessionId);
  }

  /** Applies a viewport. `mobile: true` also switches on Chrome's mobile
   * viewport emulation, so a page WITHOUT a `<meta name="viewport">` lays out
   * at the legacy 980px default exactly as a phone would — which is itself
   * worth knowing, and is asserted. */
  async setViewport(viewport: Viewport): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: viewport.mobile,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    /* One frame for the media queries to settle before anything is measured. */
    await this.evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))', true);
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState');
      if (state === 'complete') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`the page never finished loading: ${url}`);
  }

  /** Evaluates an expression in the page and returns its value. */
  async evaluate<T = unknown>(expression: string, awaitPromise = false): Promise<T> {
    const message = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    const result = message.result as { result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  /**
   * Shuts the browser down.
   *
   * Three steps, and all three are needed. `child.kill()` alone is NOT
   * enough — it signals the launcher process, while Chrome's crashpad handler,
   * network service, GPU process and renderers are separate processes that
   * survive it. That leak is not theoretical: it accumulated ~200 orphaned
   * processes and several gigabytes across repeated runs of this suite before
   * it was found.
   *
   *   1. `Browser.close` over CDP — the graceful path, which brings down the
   *      whole process group the way quitting the browser would.
   *   2. Kill the process TREE as a fallback, for the case where CDP is
   *      already gone.
   *   3. Remove the profile, retried, because Chrome holds its lock for a
   *      moment after the processes exit.
   */
  async close(): Promise<void> {
    try {
      await Promise.race([
        this.rawSend('Browser.close'),
        new Promise((resolve) => setTimeout(resolve, 5_000)),
      ]);
    } catch {
      /* already gone, or never came up */
    }
    try { this.ws?.close(); } catch { /* already closed */ }

    if (this.child) {
      const pid = this.child.pid;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        this.child!.once('exit', () => { clearTimeout(timer); resolve(); });
        this.child!.kill();
      });
      /* The tree, not just the launcher. Windows has no process groups to
         signal, so taskkill /T is the portable-on-Windows equivalent of
         killing a POSIX process group. */
      if (pid && this.child.exitCode === null) {
        try {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
          } else {
            process.kill(-pid, 'SIGKILL');
          }
        } catch {
          /* already reaped */
        }
      }
    }

    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(this.profile, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    /* Still locked. The next run's sweepStaleProfiles() will clear it, so a
       leak self-heals rather than accumulating. */
  }
}
