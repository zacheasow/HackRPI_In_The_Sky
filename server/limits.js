import rateLimit from "express-rate-limit";

function perMinute(limit) {
  return rateLimit({
    windowMs: 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests" },
  });
}

// Mount these on /api/coach and /api/designs when those routes exist.
export const coachLimiter = perMinute(10);
export const designsLimiter = perMinute(30);
