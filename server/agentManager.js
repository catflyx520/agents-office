// server/agentManager.js
const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const os = require('os');

const DEFAULT_AGENTS_DIR = path.join(os.homedir(), '.virtual-office', 'agents');

function getAgentsDir(override) {
  return override || DEFAULT_AGENTS_DIR;
}

function agentFilePath(id, dir) {
  return path.join(getAgentsDir(dir), `${id}.md`);
}

const VALID_ID_RE = /^[a-zA-Z0-9_-]+$/;

function validateId(id) {
  if (!VALID_ID_RE.test(id)) {
    throw new Error(`Invalid agent id: "${id}". Only alphanumerics, underscores, and hyphens are allowed.`);
  }
}

function saveAgent(config, dir) {
  validateId(config.id);
  const { systemPrompt, ...frontMatter } = config;
  const content = matter.stringify(systemPrompt || '', frontMatter);
  fs.mkdirSync(getAgentsDir(dir), { recursive: true });
  fs.writeFileSync(agentFilePath(config.id, dir), content, 'utf8');
}

function loadAgent(id, dir) {
  validateId(id);
  const filePath = agentFilePath(id, dir);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`Agent not found: "${id}" (${filePath})`);
  }
  const parsed = matter(raw);
  return { ...parsed.data, systemPrompt: parsed.content.trim() };
}

function listAgents(dir) {
  const agentsDir = getAgentsDir(dir);
  if (!fs.existsSync(agentsDir)) return [];
  const agents = [];
  for (const f of fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'))) {
    const id = path.basename(f, '.md');
    try {
      agents.push(loadAgent(id, dir));
    } catch (err) {
      process.stderr.write(`[agentManager] Skipping corrupt agent file "${f}": ${err.message}\n`);
    }
  }
  return agents;
}

function deleteAgent(id, dir) {
  validateId(id);
  const filePath = agentFilePath(id, dir);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

module.exports = { getAgentsDir, saveAgent, loadAgent, listAgents, deleteAgent };
