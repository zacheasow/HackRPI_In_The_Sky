# In the Clouds

A paper airplane flight simulator. Shape the wing, watch the balance, then see how far the glide carries.

Shape sliders set the span, chords, sweep, tail, and nose weight. The page derives wing area, aspect ratio, mass, center of gravity, aerodynamic center, and static margin from that shape. The flight coach and leaderboard are not wired up yet.

## Run locally

Requires Node.js 18 or newer.

```bash
npm install
cp .env.example .env
npm start
```

Open [http://localhost:3000](http://localhost:3000).

Check the physics with:

```bash
npm test
```

That prints a baseline distance for the default airplane thrown at 4 m/s and 3° from 1.5 m, plus its CG, AC, and static margin.

## Environment variables

Copy the example file and fill in what you have. The server starts without any of these set.

```bash
cp .env.example .env
```

| Variable | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Key for the Gemini flight coach. Stays on the server. |
| `GEMINI_MODEL` | Gemini model name. Defaults to `gemini-2.5-flash`. |
| `MONGODB_URI` | MongoDB Atlas connection string for the shared leaderboard. |
| `PORT` | Port Express listens on. Defaults to `3000`. |

## Tuning the flight model

All aerodynamic constants live in the `CONFIG` object at the top of `public/physics.js`. The default airplane is `defaultPlane()` in `public/plane.js`.

## Deploy on a Vultr VPS

These notes assume a fresh Ubuntu VPS and that the app should be served on port 80.

1. Install Node.js 20 and git.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git nginx
```

2. Clone the project and install dependencies.

```bash
git clone <your-repo-url> in-the-clouds
cd in-the-clouds
cp .env.example .env
# edit .env and set PORT=3000 plus any API keys
npm install
```

3. Keep the process running with pm2.

```bash
sudo npm install -g pm2
pm2 start server/index.js --name in-the-clouds
pm2 save
pm2 startup
```

4. Reverse-proxy port 80 to the Node process.

```nginx
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 80/tcp
```

The app is same-origin: the Express server serves the page and, in later stages, the API. Do not open CORS for this setup.
