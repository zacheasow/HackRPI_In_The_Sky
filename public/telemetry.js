const TIMEOUT_MS = 8000;
const COLUMNS = ["t", "x", "y", "vx", "vy", "speed", "theta", "alpha", "cl", "cd", "lift", "drag", "stalled"];

export function createRecorder() {
  const rows = [];
  return {
    recorder(sample) {
      rows.push(sample);
    },
    samples() {
      const columns = {};
      for (const key of COLUMNS) {
        columns[key] = rows.map((row) => (row && row[key] != null ? row[key] : null));
      }
      return columns;
    },
  };
}

export function postFlight(flight) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch("/api/flights", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(flight),
    signal: controller.signal,
  })
    .then(async (response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}
