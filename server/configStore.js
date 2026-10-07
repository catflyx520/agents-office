// server/configStore.js
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(os.homedir(), '.virtual-office', 'config.json');

function saveConfig(key, val) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  cfg[key] = val;
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
}

function getConfig(key) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return cfg[key];
  } catch {
    return null;
  }
}

module.exports = { saveConfig, getConfig };
