'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

let cacheFile = null;

function init(userDataDir) {
  cacheFile = path.join(userDataDir, 'claude-limits-cache.json');
}

// last good snapshot survives restarts, so the card never goes blank
function loadCached() {
  try {
    const snap = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    return snap && snap.ok ? snap : null;
  } catch {
    return null;
  }
}

function saveCached(snap) {
  if (!cacheFile) return;
  fsp.writeFile(cacheFile, JSON.stringify(snap)).catch(() => {});
}

// Claude Code's own OAuth token — read-only, sent only to Anthropic's API.
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

// "max" + "default_claude_max_20x" -> "Max (20x)", "pro" -> "Pro", etc.
function planLabel(sub, tier) {
  const mult = ((tier || '').match(/(\d+)x/) || [])[1];
  if (sub === 'max') return mult ? `Max (${mult}x)` : 'Max';
  if (sub === 'pro') return 'Pro';
  if (sub === 'free') return 'Free';
  if (sub === 'enterprise') return 'Enterprise';
  if (sub === 'team') return 'Team';
  return sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : '';
}

async function fetchPlanLimits() {
  let token = null;
  let plan = null;
  let sub = null;
  let tier = null;
  try {
    const cred = JSON.parse(await fsp.readFile(CRED_PATH, 'utf8'));
    const oauth = cred && cred.claudeAiOauth;
    if (oauth) {
      token = oauth.accessToken;
      sub = oauth.subscriptionType || null;
      tier = oauth.rateLimitTier || null;
    }
  } catch {
    /* fall through */
  }
  // ~/.claude.json carries the *current* org tier; the credentials file can be
  // stale (it reflects the tier at the time the token was issued).
  try {
    const acct = JSON.parse(await fsp.readFile(CLAUDE_JSON, 'utf8')).oauthAccount;
    if (acct) {
      tier = acct.organizationRateLimitTier || acct.userRateLimitTier || tier;
      if (!sub && acct.organizationType === 'claude_max') sub = 'max';
      if (!sub && acct.organizationType === 'claude_pro') sub = 'pro';
    }
  } catch {
    /* fall through */
  }
  if (sub || tier) plan = { type: sub, tier, label: planLabel(sub, tier) };
  if (!token) return { ok: false, reason: 'no-credentials', plan };

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      return { ok: false, reason: `http-${res.status}`, retryAfter, plan };
    }
    const data = await res.json();
    return { ok: true, fetchedAt: Date.now(), data, plan };
  } catch {
    return { ok: false, reason: 'network', plan };
  }
}

module.exports = { fetchPlanLimits, init, loadCached, saveCached };
