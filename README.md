# Felt Ledger

A single-user poker discipline tracker and spaced-repetition study companion. Static site, no backend — your data is a single `data.json` committed to a GitHub repo via the REST API, so it syncs perfectly between desktop and phone.

## Files

- `index.html` — the app
- `styles.css` — styling (dark mode only)
- `script.js` — all logic
- `data.json` — your database (starts empty)

## Setup (10 minutes, once)

### 1. One public repo

Create a public repo and push all five files to it (`index.html`, `styles.css`, `script.js`, `data.json`, `README.md`), default branch `main`. Note that a public repo means your poker stats and study notes in `data.json` are publicly viewable — the app works the same either way, this is just a privacy trade-off.

### 2. Enable GitHub Pages

**Settings → Pages → Source: Deploy from a branch → main → / (root)**. Your app will be live at `https://<username>.github.io/<repo>/` in a minute or two.

### 3. Create a token

**GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token.**

- Repository access: **Only select repositories** → this repo
- Permissions: **Contents → Read and write**
- Nothing else. Set a long expiration.

Keep the scoping tight: this token can push commits to the repo, so if it ever leaked, someone could edit the site. Limiting it to just this one repo caps the damage. The token itself never appears in the repo — it's stored only in your browser on each device.

### 4. Connect the app

Open the app on each device, tap **⚙**, and enter your username, the repo name, branch (`main`), and the token. Saved locally per device — you do this once per device, then everything syncs automatically on every save.

## Daily use

- **Evening:** Daily Input → log hands, punts, BB punted, sloppy plays, and up to two study spots from the session. Save.
- **Morning:** Study → up to two cards: last night's new spots first, then the oldest due reviews. Write notes (always appended, never overwritten), tick **Completed today**. Reviews follow a fixed schedule: next morning, 3, 7, 14, 30, 60, 120, 365 days. Missed reviews wait — nothing ever advances on its own. If nothing is due, the app deals placeholder drills so the habit never breaks (these aren't saved).
- **Anytime:** Dashboard → trailing-7,500-hand punt rate, punt frequency, sloppy frequency, the verdict against your lifetime average, and the daily chart (30d / 90d / All).

## Notes

- If you save on the same date twice, the newer session replaces the older one for that date.
- Accidentally ticked a review? A toast with **Undo** appears for a few seconds.
- Offline or sync error? Data is cached on-device and pushed next time a save succeeds.
