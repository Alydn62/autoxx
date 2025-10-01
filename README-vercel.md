
# Treasury Automation — Vercel Version

This package wraps your existing CLI (`app.js`) into Vercel Serverless API routes.
It spawns `node app.js <command>` under the hood, so your original flow stays intact.

## Deploy

1. Create a new Vercel project and **Import** this folder.
2. Set the following **Environment Variables** in Vercel → Project Settings → Environment Variables:

- `JASAOTP_API_KEY` (required)
- `JASAOTP_NEGARA` (default: `6`)
- `JASAOTP_LAYANAN` (default: `bnt`)
- `JASAOTP_OPERATOR` (default: `any`)
- `TREASURY_LOGIN_URL` (default: `https://www.treasury.id/login`)
- `TREASURY_PASSWORD` (default: `@Facebook20`)
- `EXPIRE_MINUTES` (default: `10`)
- `HEADLESS` (`true`/`false`, default: `true`)
- `SLOW_MO` (default: `0`)
- `PLAYWRIGHT_BROWSERS_PATH` (set automatically to `0` via `vercel.json`)

3. Deploy. Vercel will run `postinstall` to download Chromium for Playwright.

## Endpoints

- `GET  /api/status`
- `GET  /api/logs`
- `POST /api/create?n=5` — create N accounts (1–50)
- `POST /api/send-otp`
- `POST /api/check-otp`
- `POST /api/check-retry`
- `POST /api/auto-login` — body may contain numbers pasted by the CLI prompt (the CLI will still prompt; best used locally)
- `POST /api/clear`

> Notes:
> - These routes spawn the CLI and return `stdout/stderr` so you can see the same logs you see locally.
> - Long-running operations might hit function time limits; for heavy batches, prefer running locally or upgrade function limits.
> - Keep `config.js` committed as provided here; secrets come from ENV.
