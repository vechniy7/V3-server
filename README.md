# Nexus License Server v4

Backend for **Nexus** cheat: license keys (Upstash Redis), admin panel, remote updates for the launcher.

**Hosting:** [Render.com](https://render.com) (web service) + [Upstash](https://upstash.com) (Redis).

## Environment (Render → Environment)

| Variable | Description |
|----------|-------------|
| `UPSTASH_REDIS_REST_URL` | From Upstash console |
| `UPSTASH_REDIS_REST_TOKEN` | From Upstash console |
| `ADMIN_RESET_TOKEN` | Long random secret for admin API & panel login |
| `REDIS_PREFIX` | Optional, default `nexus:v3` |
| `PORT` | Set by Render automatically |

Copy `.env.example` for local runs. **Never commit real tokens.**

## Deploy on Render

1. New **Web Service** → connect repo → root `V3-server-main`
2. Build: `npm install`
3. Start: `npm start`
4. Add env vars above
5. Open `https://YOUR-SERVICE.onrender.com/admin`

## Admin panel

URL: `/admin`

- Login with `ADMIN_RESET_TOKEN`
- Generate keys: **2 min**, **1 month**, **3 months**, **lifetime**
- List / search keys, reset HWID, ban, delete
- Upload `kernel32.exe` + version (stored in Redis, max ~12 MB)
- Users get updates via launcher on startup

## API (public)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/activate` | Activate / validate key + HWID |
| GET | `/release/latest?version=2.2.0` | Check for update |
| GET | `/release/download` | Download latest build |

## API (admin, Bearer token)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/admin/api/stats` | Stats |
| GET | `/admin/api/licenses` | List keys |
| POST | `/admin/api/licenses/generate` | Create keys `{ type, count }` |
| POST | `/admin/reset` | Reset HWID `{ key }` |
| POST | `/admin/api/licenses/ban` | Ban key |
| POST | `/admin/api/release/upload` | Publish update |
| DELETE | `/admin/api/release` | Remove update |

Key types: `trial_2m`, `month_1`, `month_3`, `lifetime`

## Bundled keys (`keys/`)

| File | Type | Count |
|------|------|-------|
| `trial_2m.json` / `.txt` | 2 min test (`NXS-T2-...`) | 1000 |
| `month_1.json` / `.txt` | 1 month (`NXS-1M-...`) | 1000 |
| `month_3.json` / `.txt` | 3 months (`NXS-3M-...`) | 1000 |
| `lifetime.json` / `.txt` | Lifetime (`NXS-L-...`) | 1000 |

`.txt` — one key per line (for distribution).  
`.json` — database with status/HWID (committed to repo).

On first start after deploy, all files are imported into Upstash Redis once (flag `imported:bundled:v2`).

Regenerate locally:

```bash
npm run generate-keys
```

Then commit `keys/` and push.

## Local

```bash
cd V3-server-main
npm install
# set UPSTASH_* and ADMIN_RESET_TOKEN
npm start
```

## Client

Set the same host in `LicenseAuth.cpp` / `AppUpdate.cpp` as your Render URL.  
Bump `NEXUS_APP_VERSION` in `AppVersion.h` when publishing a new build, then upload matching version in admin panel.
