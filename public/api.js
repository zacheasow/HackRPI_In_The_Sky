const TIMEOUT_MS = 8000;

async function request(path, options, timeout = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
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

export function coach(body) {
  return request("/api/coach", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, 35000);
}

export function designs(body) {
  return request("/api/designs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function leaderboard(limit = 20) {
  return request(`/api/leaderboard?limit=${limit}`);
}

export function listFlights(limit = 20) {
  return request(`/api/flights?limit=${limit}`);
}

export function flightTelemetry(id, resolution = 0.05) {
  return request(`/api/flights/${encodeURIComponent(id)}/telemetry?resolution=${resolution}`);
}

export function compareFlights(a, b, resolution = 0.05) {
  return request(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}&resolution=${resolution}`);
}

const LOCAL_BOARD = "clouds.board";

export function readLocalBoard() {
  try {
    const raw = localStorage.getItem(LOCAL_BOARD);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveLocalBoard(entry) {
  const list = readLocalBoard();
  list.push(entry);
  list.sort((a, b) => b.distance - a.distance || new Date(a.createdAt) - new Date(b.createdAt));
  const kept = list.slice(0, 50);
  try {
    localStorage.setItem(LOCAL_BOARD, JSON.stringify(kept));
  } catch {
    // A full or private store still leaves this page able to say it saved.
  }
  return kept;
}
