import fs from "fs";
import path from "path";
import { fetch as undiciFetch, setGlobalDispatcher, ProxyAgent as UndiciProxyAgent, getGlobalDispatcher } from "undici";

const PROXY_FILE_PATH = path.join(process.cwd(), "proxy.txt");

export const proxyState = {
  bannedProxies: [],
  currentActiveProxy: null
};

export function getValidProxies() {
  if (!fs.existsSync(PROXY_FILE_PATH)) {
    return [];
  }
  const content = fs.readFileSync(PROXY_FILE_PATH, "utf-8");
  const matches = content.match(/(?:http|https):\/\/[^\s"',\\}]+/gi);
  if (!matches) return [];
  const cleaned = matches.map(url => url.replace(/\\/g, ''));
  return Array.from(new Set(cleaned));
}

export function getRandomProxy(excludeProxies = []) {
  const proxies = getValidProxies().filter(p => !excludeProxies.includes(p));
  if (proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}

const defaultDispatcher = getGlobalDispatcher();

export function applyProxy(proxyUrl) {
  if (proxyUrl) {
    console.log(`[Proxy] Đang áp dụng Proxy: ${proxyUrl}`);
    process.env.HTTP_PROXY = proxyUrl;
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.http_proxy = proxyUrl;
    process.env.https_proxy = proxyUrl;

    if (proxyUrl.startsWith("http://") || proxyUrl.startsWith("https://")) {
      const agent = new UndiciProxyAgent(proxyUrl);
      setGlobalDispatcher(agent);
    }
  } else {
    console.log("[Proxy] Sử dụng kết nối trực tiếp (Direct IP).");
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    setGlobalDispatcher(defaultDispatcher);
  }
}

export async function checkProxy(proxyUrl) {
  try {
    const dispatcher = proxyUrl ? new UndiciProxyAgent(proxyUrl) : getGlobalDispatcher();
    const res = await undiciFetch("https://huggingface.co/spaces/selfit-camera/omni-image-editor", {
      dispatcher,
      method: 'HEAD',
      signal: AbortSignal.timeout(5000)
    });
    if (res.status >= 200 && res.status < 400) {
      return proxyUrl;
    }
    throw new Error(`Bad status: ${res.status}`);
  } catch (err) {
    throw err;
  }
}

export async function findFastestProxy(numProxies = 5) {
  const proxies = [];
  for (let i = 0; i < numProxies; i++) {
    const p = getRandomProxy([...proxies, ...proxyState.bannedProxies]);
    if (p) proxies.push(p);
  }

  if (proxies.length === 0) return null;

  console.log(`[Proxy] Đang ping đua ${proxies.length} proxy cùng lúc để chọn proxy nhanh nhất (Timeout 5s)...`);

  try {
    const fastest = await Promise.any(proxies.map(p => checkProxy(p)));
    console.log(`[Proxy] 🏆 Proxy nhanh nhất chiến thắng: ${fastest}`);
    proxyState.currentActiveProxy = fastest;
    return fastest;
  } catch (e) {
    console.log(`[Proxy] ❌ Tất cả ${proxies.length} proxy đua đều thất bại/timeout. Sẽ dùng Direct IP.`);
    proxyState.currentActiveProxy = null;
    return null;
  }
}
