const TIMEOUT_MS = 8000;

async function request(path, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function getHealth() {
  return request("/api/health");
}

export function coach() {
  return Promise.resolve(null);
}

export function designs() {
  return Promise.resolve(null);
}
