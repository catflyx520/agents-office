// server/weather.js
// 当地天气：定位（手动设置的邮编位置 > ip-api.com 自动 IP 定位）→ open-meteo.com（免费天气，无需 key）。
// 服务端定时拉取并缓存，index.js 广播给前端墙上的天气牌。
// 手动位置：zippopotam.us（免费邮编→经纬度）解析后持久化到 ~/.virtual-office/settings.json。
const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_FILE = path.join(os.homedir(), '.virtual-office', 'settings.json');
function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; } }
function writeSettings(patch) {
  const s = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

let cache = null;

async function locate() {
  const saved = readSettings().weatherLocation;
  if (saved && saved.lat != null) return { ...saved, manual: true };
  const res = await fetch('http://ip-api.com/json/?fields=status,city,lat,lon', { signal: AbortSignal.timeout(8000) });
  const loc = await res.json();
  if (loc.status !== 'success') throw new Error('IP 定位失败');
  return { city: loc.city, lat: loc.lat, lon: loc.lon, manual: false };
}

async function fetchWeather() {
  const loc = await locate();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
    + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m'
    + '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto';
  const wRes = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const w = await wRes.json();
  if (!w.current) throw new Error('天气数据为空');

  cache = {
    city: loc.city,
    manual: !!loc.manual, // true = 用户手动设置的邮编位置
    zip: loc.zip || null,
    temp: Math.round(w.current.temperature_2m),
    tempMax: Math.round(w.daily.temperature_2m_max[0]),
    tempMin: Math.round(w.daily.temperature_2m_min[0]),
    humidity: w.current.relative_humidity_2m,
    wind: Math.round(w.current.wind_speed_10m),
    code: w.current.weather_code, // WMO 天气码，前端映射成 emoji/文案
    ts: Date.now(),
  };
  return cache;
}

// 邮编 → 经纬度（zippopotam.us），成功则持久化为手动位置并立刻刷新天气。
// zip 传空 = 清除手动位置，恢复 IP 自动定位。
async function setLocationByZip(zip, country = 'us') {
  zip = String(zip || '').trim();
  if (!zip) {
    writeSettings({ weatherLocation: null });
    return fetchWeather();
  }
  const res = await fetch(`https://api.zippopotam.us/${encodeURIComponent(country)}/${encodeURIComponent(zip)}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`邮编 ${zip}（${country.toUpperCase()}）没查到，检查邮编和国家是否匹配`);
  const data = await res.json();
  const place = data.places && data.places[0];
  if (!place) throw new Error('邮编解析结果为空');
  writeSettings({
    weatherLocation: {
      zip, country,
      city: place['place name'],
      lat: Number(place.latitude),
      lon: Number(place.longitude),
    },
  });
  return fetchWeather();
}

function getWeather() { return cache; }

module.exports = { fetchWeather, getWeather, setLocationByZip };
