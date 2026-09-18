---
title: Harmonica AI Song Maker Backend
emoji: 🎵
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
---

# Harmonica AI Song Maker — backend

Two endpoints the browser cannot provide for itself. Everything else in the app runs
client-side; if this Space is asleep or removed, uploading an audio file still works.

| Endpoint | Method | Purpose |
|---|---|---|
| `/health` | GET | Reports which optional tools are installed. The front end calls this on load. |
| `/extract` | POST | `{"url": "..."}` → audio track of a link, as m4a. |
| `/separate` | POST | multipart audio file → isolated vocal stem, as wav. |

## Deploying

1. Create a new Space at huggingface.co/new-space, SDK **Docker**.
2. Upload `Dockerfile`, `requirements.txt`, `app.py` and this README.
3. Once it builds, set `ALLOWED_ORIGINS` in the Space's Settings → Variables to your
   GitHub Pages origin (for example `https://yourname.github.io`). It defaults to `*`.
4. Put the Space URL into the front end's Settings panel.

## Notes

- **Separation is slow.** `mdx_extra_q` on a free CPU Space takes several minutes for a
  normal-length song. It is worth it for busy mixes and pointless for solo recordings,
  so the front end leaves it off by default.
- **Free Spaces sleep** after inactivity. The first request after a nap takes ~30s while
  the container wakes.
- **Trimming the image:** if you do not want separation, remove `demucs` and `torch` from
  `requirements.txt`. The image drops by well over a gigabyte and builds far faster.
- **YouTube:** downloading audio from YouTube is against YouTube's Terms of Service. The
  endpoint exists because it was asked for; file upload is the path that does not depend
  on it.
