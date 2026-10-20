// The browser renders this same public catalogue; it contains no user data.
const catalog = require('../client/data/models.json');
const nativeCodexModels = require('./codex-chat-models.json').models;
function selectionFor(agent, fallback = 'claude') {
  const provider = ['claude', 'codex'].includes(agent?.modelProvider) ? agent.modelProvider : fallback;
  const explicit = ['claude', 'codex'].includes(agent?.modelProvider) && typeof agent.modelId === 'string';
  return { provider, modelId: explicit ? agent.modelId : (provider === 'codex' ? agent?.codexModel : agent?.model) || '' };
}
function allowedModel(provider, modelId) {
  const group = catalog.providers.find(item => item.id === provider);
  if (!group || typeof modelId !== 'string') return false;
  if (modelId === '') return true;
  if (!group.models.some(item => item.id === modelId || item.aliases?.includes(modelId))) return false;
  return provider !== 'codex' || nativeCodexModels.some(item => item.slug === modelId && item.visibility === 'list' && item.supported_in_api === true);
}
function labelFor(provider, modelId, language = 'en') {
  const group = catalog.providers.find(item => item.id === provider);
  if (!group) return modelId;
  if (!modelId) return `${group.label} · ${language === 'zh' ? '账号默认' : 'Account default'}`;
  const found = group.models.find(item => item.id === modelId || item.aliases?.includes(modelId));
  const label = found?.id === modelId ? found.label : `${modelId} (${language === 'zh' ? '原有别名' : 'saved alias'})`;
  return `${group.label} · ${label}`;
}
module.exports = { catalog, selectionFor, allowedModel, labelFor };
