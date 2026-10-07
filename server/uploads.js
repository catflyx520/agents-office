// server/uploads.js
// 把上传的文件存到本地，返回绝对路径，供 agent 用 Read 工具查看。
const fs = require('fs');
const path = require('path');
const os = require('os');

const UPLOAD_DIR = path.join(os.homedir(), '.virtual-office', 'uploads');

// 文件名只保留安全字符（含中文），其余替换为下划线，并去掉路径部分防目录穿越
function sanitize(name) {
  return path.basename(String(name || 'file')).replace(/[^\w.\-一-龥]/g, '_') || 'file';
}

function saveUpload(name, buffer, dir = UPLOAD_DIR) {
  if (!buffer || buffer.length === 0) throw new Error('空文件');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${Date.now()}-${sanitize(name)}`); // 时间戳前缀防重名
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

module.exports = { saveUpload, UPLOAD_DIR };
