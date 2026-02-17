# Curling Poke

A tiny browser curling mini‑game.

## Local run

Open `index.html` in a browser, or run a simple static server:

```bash
# Python
python -m http.server 8000
# then open http://localhost:8000
```

## GitHub Pages

This repo is ready to be deployed as a static site on GitHub Pages (no build step).

Recommended settings:

- **Settings → Pages**
- **Source:** Deploy from a branch
- **Branch:** `main` / **Folder:** `/ (root)`

Then your game will be available at:

`https://<your-username>.github.io/<repo-name>/`

## Supabase global counter (optional)

The game can show a global “world wide total” via Supabase. If you don’t configure Supabase keys, the game still runs normally.
