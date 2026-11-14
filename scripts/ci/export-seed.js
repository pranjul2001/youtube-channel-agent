#!/usr/bin/env node
// Exports the channel's non-secret configuration (settings, channel profile, channel strategy)
// from the local database to config/channel-seed.json, so cloud runs (GitHub Actions) start
// from the same channel rules. Secrets never go in this file: they live in GitHub Secrets.
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const fs = require('fs');
const path = require('path');
const { Database } = require('../../database/db');

// Run-state keys (dates, attempts, errors) and anything credential-like are not exported.
const SKIP = /^(daily_(last|attempts|check_|resumed_)|topics_curated_at|last_content_generation|api_key|.*token.*|.*secret.*|.*password.*)/i;

(async () => {
  const db = new Database();
  await db.initialize();
  const settings = Object.fromEntries(Object.entries(await db.getAllSettings()).filter(([key]) => !SKIP.test(key)));
  const seed = {
    exportedAt: new Date().toISOString(),
    settings,
    channelProfiles: await db.getAllRows('SELECT * FROM channel_profiles'),
    channelStrategies: await db.getAllRows('SELECT * FROM channel_strategies')
  };
  const file = path.join(__dirname, '..', '..', 'config', 'channel-seed.json');
  fs.writeFileSync(file, JSON.stringify(seed, null, 2) + '\n');
  console.log(`Wrote ${file}: ${Object.keys(settings).length} settings, ${seed.channelProfiles.length} profile, ${seed.channelStrategies.length} strategy`);
  process.exit(0);
})().catch(error => { console.error('FAILED', error.message); process.exit(1); });
