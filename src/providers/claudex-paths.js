'use strict';

const path = require('path');
const os = require('os');

function expandHome(value, home) {
  const raw = String(value || '');
  if (raw === '~') return home;
  if (/^~[\\/]/.test(raw)) return path.join(home, raw.slice(2));
  return raw;
}

function resolveConfigDir(env = process.env, home = os.homedir()) {
  const configured = expandHome(env.CLAUDEX_CONFIG_DIR, home);
  return configured ? path.resolve(configured) : path.join(home, '.config', 'claudex');
}

const CONFIG_DIR = resolveConfigDir();
const PROJECTS_DIR = path.join(CONFIG_DIR, 'projects');
const USAGE_DIR = path.join(CONFIG_DIR, 'usage-cache');

module.exports = { resolveConfigDir, CONFIG_DIR, PROJECTS_DIR, USAGE_DIR };
