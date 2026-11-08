# AGENTS.md

Shared rules for every coding agent on this repo (Cursor, Freebuff, Claude Code, Codex). Read this before changing anything.

## Project
"Aerogami": a paper airplane flight simulator for HackRPI. The player edits a paper airplane's shape, launches it, and tries to maximize flight distance. Sky gradient and drifting clouds theme.

- Frontend: plain HTML/CSS/vanilla JS in `public/`. No frameworks, no bundler, no build step.
- Backend: small Node.js + Express server in `server/` (ES modules, `"type": "module"`).
- Setup is always `npm install` then `npm start` (serves http://localhost:3000). Deploy target is a Vultr VPS (pm2 + nginx reverse proxy).
- Repo: https://github.com/zacheasow/HackRPI_In_The_Sky

## File layout and ownership
- `public/physics.js`: pure sim logic. No DOM access. ALL tunable constants live in one commented `CONFIG` object at the top. Seeded RNG only, never `Math.random` in the sim.
- `public/plane.js`: shape -> physical parameters (wing area, AR, mass, CG, AC, static margin, tail, inertia).
- `public/render.js`: side-view flight, trail, wind streaks.
- `public/main.js`: UI wiring. `public/sim.html`, `public/style.css`: layout and theme. `public/index.html`: landing page.
- Planned: `public/editor.js` (draggable shape editor), `public/api.js` (fetch wrappers), `server/coach.js` (Gemini), `server/db.js` (MongoDB Atlas).
- `tests/`: plain Node scripts run by `npm test`.

## Hard rules
1. Read the files you are about to change first. Do not guess at their contents.
2. Keep edits small and surgical. Match the existing style. No new dependencies unless the task names them.
3. Never break the baselines. With wind off:
   - Default throw (7 m/s, 4 deg, 1.5 m) glides 16.45 m in 3.95 s, peak height 2.71 m, no stall.
   - Default glider at 4 m/s, 3 deg lands at 12.39 m. Readouts: wing area 198 cm^2, AR 6.55, mass 3.3 g, CG 7.95 cm, AC 9.07 cm, static margin +20%.
4. `npm test` must pass before you call a task done. Show the output.
5. Clamp every input to a sane range. A flight must always finish (ends at y <= 0 or on NaN/inf).
6. Secrets (`GEMINI_API_KEY`, `MONGODB_URI`) stay server-side in `.env`. Never send them to the browser or commit them. Missing keys fall back silently (local diagnosis, localStorage leaderboard).
7. Do only the stage you were asked for, then stop and report: files changed (one line each) and test output.

## Build order
1. Physics + sliders + launch + trajectory (done)
2. Derived parameters + stability readouts (done)
2.5 Seeded random wind (random / fixed / off) (built; headwind result under review)
3. Draggable shape editor
4. Local diagnosis + flight history (last 10, best distance)
5. Express server + /api/health
6. Gemini coach endpoint + Coach panel
7. MongoDB leaderboard with localStorage fallback
8. Auto-tune (random search + hill climbing)

## Parked / future ideas
- A 3D paper-folding animation (anime.js) was removed from the app. If it comes back, keep it in its own files and off the flight page.

## Working in parallel
- Cursor builds the main stages on `main`.
- Freebuff takes side work in its own git worktree/branch (browser click-through testing, code review, README and deploy notes). It must not edit `physics.js` or `plane.js` while a main stage is in progress.
- Merge side branches only after `main` passes `npm test`.