import english from './translations.js';

let language = 'zh';
try { language = localStorage.getItem('vo_language') === 'en' ? 'en' : 'zh'; } catch { /* Storage unavailable. */ }
export const getLanguage = () => language;
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pattern = new RegExp(Object.keys(english).sort((a, b) => b.length - a.length).map(escapeRegex).join('|'), 'g');
// Called only on authored UI literals, never user messages, names, or model output.
export function tr(source) {
  return language === 'en' ? source.replace(pattern, key => english[key]) : source;
}

export function initLanguage() {
  const textNodes = [];
  const attributes = [];
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('script,style')) continue;
    if (/[\u3400-\u9fff]/.test(node.textContent)) textNodes.push([node, node.textContent]);
  }
  document.querySelectorAll('[title],[placeholder],[aria-label]').forEach(element => {
    for (const name of ['title', 'placeholder', 'aria-label']) {
      const value = element.getAttribute(name);
      if (value && /[\u3400-\u9fff]/.test(value)) attributes.push([element, name, value]);
    }
  });
  function renderStatic() {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    for (const [textNode, original] of textNodes) {
      if (textNode.isConnected) textNode.textContent = tr(original);
    }
    for (const [element, name, original] of attributes) element.setAttribute(name, tr(original));
  }
  renderStatic();
  const select = document.getElementById('og-language');
  select.value = language;
  select.addEventListener('change', () => {
    language = select.value === 'en' ? 'en' : 'zh';
    try { localStorage.setItem('vo_language', language); } catch { /* Storage unavailable. */ }
    renderStatic();
    window.dispatchEvent(new Event('office-language'));
  });
}
