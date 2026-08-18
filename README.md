# FIU Revenue Estimator (backend + config storage)

This is the backend version of the tool: FIU metadata (legal name, TSP,
license type, use-case, billing model) and yield/CMGR are maintained as
**configs** that persist on the server, so a monthly upload only needs to
carry AU/DF counts — not the same metadata over and over.

Because it now stores data server-side, it needs an actual running process
(unlike the earlier single-file version, this can't be hosted on GitHub
Pages — see "Deploying" below).

## What's in each config

**FIU Metadata** (`FIU Metadata` tab): FIU ID, Legal Name, TSP Name, License
Type, Use-case, Billing Model.

**Yield & CMGR** (`Yield & CMGR` tab): FIU ID, Yield, CMGR (compound monthly
growth rate, as a decimal — `0.05` for 5% monthly growth, `0` for flat,
negative values are fine for a shrinking FIU).

Both are stored as plain JSON files under `data/` (`fiu-metadata.json`,
`yield-cmgr.json`) — no database server to install. That's a deliberate
choice for a dataset of a few hundred FIUs maintained by a small team; swap
`lib/store.js` for a real database later if you need concurrent multi-writer
support.

## Monthly workflow

1. Each month, export just **FIU ID, active_users, successful_data_fetches**
   from your live system (no yield, no billing model, no metadata needed).
2. Upload that file in the **Monthly Revenue** tab, set the as-of date (the
   date the counts were pulled — defaults to today), and click **Compute
   revenue**.
3. The tool joins the upload with both configs by FIU ID and computes:
   - **Current month revenue** — "Active Users"/"Unique Users" (same
     billing model) use the AU count as-is; "Data Fetch"/"Fix Billing"
     project the DF count from a month-to-date total to a full month using
     the as-of date (day-of-month ÷ days in that month).
   - **Every remaining month of the FY** — the current month's baseline
     usage (AU as-is, or the already-projected full-month DF figure) is
     grown by `(1 + CMGR)` compounded per month; yield is held constant.
     Revenue = usage × yield for every month.
4. FIUs whose billing model isn't recognized (blank, "Not billed",
   "Unbilled", or anything else unrecognized) are shown as excluded. FIUs
   missing a Yield & CMGR config entry, or with an unusable count, are shown
   as missing config — never guessed.
5. Any FIU in the upload with no FIU Metadata entry, and any FIU in your
   configs with no counts in this month's upload, are called out separately
   so gaps are visible instead of silently dropped.

## Seeding the configs quickly

If you already have a Master-Data-style spreadsheet (a sheet literally named
"Master Data" with `fiu_id`, `fiu_name`, `TSP`, `License`, `Use-case`,
`Billing Model`, a yield column, and optionally a CMGR/"Q2 CMGR Forecast"
column), use **Import / update from Master Data file** on the FIU Metadata
tab — it seeds *both* configs at once instead of retyping every row by hand.
Only the "Master Data" sheet is read; any other sheets in that file are
ignored. Re-running it later updates existing FIUs and adds new ones (an
upsert, not a wipe).

## Running it locally

```
npm install
npm start
```

Then open `http://localhost:3000` (or set `PORT=xxxx npm start` to use a
different port). Data persists in `data/*.json` between restarts.

## Deploying

This needs a host that runs a persistent Node process — GitHub Pages (static
files only) won't work for this version. Straightforward options:

- **Render / Railway / Fly.io** — connect the repo, set the start command to
  `npm start`, and use a persistent disk/volume mounted at the `data/`
  folder so your configs survive redeploys (all three platforms support
  this).
- **A VPS** (e.g. a small droplet/EC2 instance) — `git clone`, `npm
  install`, run with a process manager like `pm2` or a `systemd` service,
  put it behind nginx if you want a domain/TLS.
- **Docker** — a minimal `Dockerfile` would be `FROM node:20-alpine`, copy
  the repo, `npm install --production`, `CMD ["npm","start"]`, and mount a
  volume at `/app/data`.

Whichever you choose, back up `data/*.json` periodically (or point
`lib/store.js` at a real database) since that's where both configs live.

## API reference

- `GET/POST /api/fiu-metadata`, `PUT/DELETE /api/fiu-metadata/:fiuId`
- `GET/POST /api/yield-cmgr`, `PUT/DELETE /api/yield-cmgr/:fiuId`
- `POST /api/seed-from-master-data` — multipart `file`, seeds both configs
- `POST /api/compute` — multipart `file` + form fields `asOfDate`
  (`YYYY-MM-DD`, defaults to today) and `fyStartMonth` (`1`–`12`, defaults
  to `4` for an April–March FY)

## Extending it

- `lib/compute.js` — billing-model classification, MTD→full-month
  projection, the FY month list, and CMGR-based projection.
- `lib/columns.js` — loose column-header matching (aliases), shared by the
  Master Data importer and the monthly counts upload.
- `lib/store.js` — the JSON-file config storage; replace this to move to a
  real database.
- `public/index.html` — the whole frontend (plain HTML/CSS/JS, no build
  step), talking to the API above.
