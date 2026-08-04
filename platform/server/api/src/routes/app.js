/* Native app support endpoints.

   Most app changes ship over-the-air (EAS Update) and never touch this file.
   This is the escape hatch for the other kind: when a release genuinely needs a
   new binary — a new native module, an SDK bump, a runtime-version change — OTA
   can't deliver it, and older installs must be told to go get the new build.

   `minBuild` is that lever. It's stored in settings (jsonb) rather than baked
   into a deploy, so support can raise the floor the moment a bad build is
   identified, without shipping anything.

   Deliberately unauthenticated: the gate has to work on a launch where the
   user isn't signed in yet, or where their token is what the new build fixes. */

import { Router } from 'express';
import { q } from '../db.js';
import { requireAuth, ADMIN_ROLES } from '../authmw.js';

const r = Router();

const DEFAULTS = {
  ios: {
    // Oldest build allowed to run. Anything below is hard-blocked.
    minBuild: 1,
    // Newest build available, or null when we aren't tracking one. Drives the
    // soft "an update is ready" prompt, which the user can dismiss.
    latestBuild: null,
    // Where to send someone who has to update. TestFlight while in beta; swap
    // for the App Store listing at public launch.
    installUrl: null,
    message: null,
  },
  android: { minBuild: 1, latestBuild: null, installUrl: null, message: null },
};

async function readConfig() {
  const { rows } = await q(`select data->'appConfig' as cfg from settings where id=1`);
  const stored = rows[0]?.cfg || {};
  return {
    ios: { ...DEFAULTS.ios, ...(stored.ios || {}) },
    android: { ...DEFAULTS.android, ...(stored.android || {}) },
  };
}

/** GET /app/config?platform=ios&build=42
    `build` is the native build number (CFBundleVersion / versionCode). */
r.get('/config', async (req, res) => {
  const platform = req.query.platform === 'android' ? 'android' : 'ios';
  const cfg = (await readConfig())[platform];
  const build = parseInt(req.query.build, 10);
  const known = Number.isFinite(build);

  res.json({
    platform,
    minBuild: cfg.minBuild,
    latestBuild: cfg.latestBuild,
    installUrl: cfg.installUrl,
    message: cfg.message,
    // Hard stop: this build is no longer supported.
    updateRequired: known && build < cfg.minBuild,
    // Soft nudge: a newer binary exists, but this one still works.
    updateAvailable: known && cfg.latestBuild != null && build < cfg.latestBuild,
  });
});

/** POST /app/config {ios?:{...}, android?:{...}} — admin only, merges. */
r.post('/config', requireAuth(...ADMIN_ROLES), async (req, res) => {
  const current = await readConfig();
  const next = { ...current };
  for (const platform of ['ios', 'android']) {
    const patch = req.body?.[platform];
    if (!patch) continue;
    for (const key of ['minBuild', 'latestBuild', 'installUrl', 'message']) {
      if (key in patch) next[platform][key] = patch[key];
    }
  }
  await q(`update settings set data = jsonb_set(coalesce(data,'{}'::jsonb),
             '{appConfig}', $1::jsonb, true) where id=1`, [JSON.stringify(next)]);
  res.json(next);
});

export default r;
