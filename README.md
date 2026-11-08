# In the Clouds

In the Clouds is a paper airplane flight simulator built for HackRPI. You shape a plane, throw it through seeded wind, and try to fly as far as you can. The sim shows the distance and a plain-language reason for how the flight ended.

You can drag the wing and tail, read the stability numbers, ask a Gemini coach for changes, auto-tune the shape, and save a score to a shared MongoDB leaderboard. If the coach key or the database is missing, the page still flies and keeps scores in this browser.

## Features

- Drag handles and sliders for span, chords, sweep, tail area, and nose weight
- Seeded wind: random, fixed, or off
- Local flight diagnosis and a history of the last 10 throws
- Gemini coach that explains a flight and can apply numeric changes
- Auto-tune that searches for a longer flight inside the editor limits
- MongoDB leaderboard, with a local fallback

## Tech stack

Plain HTML, CSS, and JavaScript in the browser. Node.js and Express serve the pages and the API. The coach uses the Gemini API. The leaderboard uses MongoDB. Production is a Vultr VPS with pm2 and nginx.

## Local setup

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000).

```bash
npm test
```

With the wind off, the default glider thrown at 4 m/s and 3° from 1.5 m flies 12.39 m. The same plane thrown at 7 m/s and 4° flies 16.45 m.

## Environment variables

Copy `.env.example` to `.env`. Leave a value blank to skip that feature. Do not commit `.env`.

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Server-side key for the Gemini flight coach. Blank skips the coach. |
| `GEMINI_MODEL` | Gemini model name. Defaults to `gemini-2.5-flash`. |
| `MONGODB_URI` | MongoDB connection string for the shared leaderboard. Blank keeps scores in the browser. |
| `MONGODB_DB` | Database name. Defaults to `HackRPI`. |
| `MONGODB_COLLECTION` | Collection name. Defaults to `hackrpi`. |
| `PORT` | Port Express listens on. Defaults to `3000`. |

## Deploy to Vultr

These steps assume a fresh Ubuntu VPS. The Node app listens on port 3000. nginx serves port 80 and proxies to it.

1. Create an Ubuntu VPS in the Vultr panel and SSH in as a user with sudo.

2. Install Node.js 20, nginx, and pm2.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx
sudo npm install -g pm2
```

3. Clone the repo and install dependencies.

```bash
git clone https://github.com/zacheasow/HackRPI_In_The_Sky.git
cd HackRPI_In_The_Sky
npm install
```

4. Create `.env` on the server. Fill in the values you have. `PORT` should stay `3000`.

```bash
cp .env.example .env
nano .env
```

5. Start the app with pm2, save the process list, and register the startup script.

The config is `ecosystem.config.cjs` because this package is an ES module, and pm2 loads a CommonJS file.

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Run the command `pm2 startup` prints, then run `pm2 save` again.

6. Copy the nginx config into place and reload.

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/in-the-clouds
sudo ln -s /etc/nginx/sites-available/in-the-clouds /etc/nginx/sites-enabled/in-the-clouds
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

7. Add HTTPS with certbot after the DNS name points at the VPS. Set `server_name` in the nginx file to that domain first.

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

The app is same-origin. Express serves the pages and the API. Do not open CORS for this setup.

## Project structure

- `public/index.html` — landing page
- `public/sim.html` — flight page
- `public/leaderboard.html` — leaderboard page
- `public/physics.js` — flight model and tunable `CONFIG`
- `public/plane.js` — shape, mass, CG, and static margin
- `public/editor.js` — drag handles
- `public/main.js` — flight page wiring
- `public/autotune.js` — shape search
- `public/render.js` — canvas sky and flight view
- `server/index.js` — process entry
- `server/app.js` — Express app and routes
- `server/coach.js` — Gemini coach
- `server/db.js` — MongoDB connection
- `ecosystem.config.cjs` — pm2 process file
- `deploy/nginx.conf` — reverse proxy
- `tests/` — `npm test`
