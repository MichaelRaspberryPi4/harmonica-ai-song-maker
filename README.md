# Harmonica AI Song Maker

Turn any song into something you can actually play on a **Hohner Echo Harp 56/96** — the
double-sided C/G tremolo. Drop in an audio file (or a link, with the optional backend), and
the app transcribes the melody, works out the best arrangement for the instrument, and
shows you a scrolling tab with exactly which channel to blow or draw, while playing the
notes back so you can hear what you are aiming for.

Everything except link-fetching and vocal isolation runs **in your browser**. No account,
no upload, no server bill.

---

## What the instrument can and cannot do

This is the whole problem the app exists to solve, so it is worth stating plainly.

**Available pitch classes: C D E F F♯ G A B.** That is eight of twelve. There is no C♯,
E♭, G♯ or B♭ anywhere on either side, and tremolo reeds do not bend. A quarter of the
chromatic scale simply does not exist.

**Range: E3 – D7.**

**Chords are thin.** Blowing gives you a clean C major triad on the C side and a G major
triad on the G side. Drawing gives clusters — D/F/A/B on the C side, A/C/E/F♯ on the G
side — which are usable as G7, Dm7 and D7 fragments but are not triads.

**Flipping the harp is expensive.** F natural exists only on the C side and F♯ only on the
G side, so some songs force you to physically turn the instrument over mid-tune. This is
the single costliest physical action, and the arranger treats it that way.

### Note layout

From Hohner's own datasheet (`ECHO WENDER TREMOLO 2 X 48`, model M5696357), reproduced in
code at [`src/core/harmonica.ts`](src/core/harmonica.ts) and pinned note-for-note by
[`test/harmonica.test.ts`](test/harmonica.test.ts).

**C side**

| Ch | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Blow | E3 | G3 | C4 | E4 | G4 | C5 | E5 | G5 | C6 | E6 | G6 | C7 |
| Draw | G3 | B3 | D4 | F4 | A4 | B4 | D5 | F5 | A5 | B5 | D6 | F6 |

**G side**

| Ch | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Blow | G3 | B3 | D4 | G4 | B4 | D5 | G5 | B5 | D6 | G6 | B6 | D7 |
| Draw | A3 | D4 | F♯4 | A4 | C5 | E5 | F♯5 | A5 | C6 | E6 | F♯6 | A6 |

> **⚠ Check this against your harp.** A tremolo has two rows of holes and each vertical
> pair sounds one note, so an instrument with 12 *playing channels* shows 24 *hole
> openings* per side. If the numbers printed on your cover plate run past 12, change
> `CHANNELS_PER_SIDE` in [`src/core/harmonica.ts`](src/core/harmonica.ts) — the layout is
> generated from the tuning cycles, so that one constant is the only thing to edit.

---

## How the arranger works

1. **Transcribe.** [Basic Pitch](https://github.com/spotify/basic-pitch) runs in the
   browser and emits polyphonic note events.
2. **Reduce to one line.** A harmonica plays one note at a time, so overlapping notes are
   resolved by pitch height, confidence, duration and melodic continuity.
3. **Repair octave errors.** Every pitch transcriber occasionally reports a harmonic
   instead of the fundamental. A note sitting more than a fifth from the local median,
   which an octave shift would bring back in line, gets pulled back. Genuine register
   changes survive, because they move the median with them.
4. **Find the beat**, via spectral-flux onsets and autocorrelation, and lightly quantise.
5. **Choose a key.** All 12 transpositions are scored on how many notes land on pitches
   the harp actually has, how many need octave-folding, and how many harp flips result.
   Ties break toward the original key. You can override the choice.
6. **Fit the notes.** Anything outside E3–D7 is folded by octaves; anything still on an
   impossible pitch class is substituted with the nearest playable neighbour, preferring
   to move down and preferring pitches already common in the piece.
7. **Assign sides.** A two-state Viterbi pass over the whole piece minimises
   (unplayable notes + weighted flips), where a flip across a long rest is cheap and one
   mid-phrase is nearly prohibitive. Greedy assignment fails badly here: the cheapest side
   for one note routinely strands the next ten.
8. **Add harmony**, in three switchable layers — Easy is single-note, Medium adds octave
   doubling and blow-chord accents on sustained or accented notes, Full adds draw clusters.
   Fast passages are never thickened.

---

## Running it locally

```bash
npm install
npm run dev
```

Then open the printed URL. `npm test` runs the suite; `npm run build` produces `dist/`.

## Deploying to GitHub Pages

1. Push this repository to GitHub.
2. **Settings → Pages → Source → GitHub Actions.**
3. Push to `main`. [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) runs the
   tests, builds, and deploys to `https://<you>.github.io/<repo>/`.

The workflow sets the Vite base path from the repository name automatically. For a custom
domain, set `BASE_PATH=/` in the workflow.

## The optional backend

Two things a browser cannot do for itself: fetch audio from a YouTube link, and isolate a
vocal from a full mix. [`backend/`](backend/) is a small FastAPI service for both, packaged
to run free on a Hugging Face Space. Setup is in [`backend/README.md`](backend/README.md);
paste the Space URL into the app's Settings panel.

**Without it the app still works** for any audio file you upload — you lose link input and
vocal isolation, nothing else.

> Downloading audio from YouTube is against YouTube's Terms of Service. The endpoint exists
> because it was asked for; file upload is the path that does not depend on it.

---

## Practice features

- **A–B loop** — mark a tricky bar and repeat it endlessly.
- **Slow down to 40%** without the pitch dropping.
- **Play along with the original**, with a balance slider against the synthesised harp.
- **Metronome and 4-beat count-in**, with bar lines drawn on the tab.
- **Harp diagram** showing the lit channel and breath direction for the current note.
- **Click anywhere** on the tab strip to jump there.

## Known limitations

- **Busy mixes transcribe poorly** without vocal isolation. A solo instrument, a clear
  lead vocal or a simple recording works far better than a dense production.
- **Transcription is slow on first run** — the Basic Pitch model is a few megabytes and
  downloads once, then caches.
- **Beat detection assumes a steady tempo.** Rubato and live recordings drift; the app
  reports "(unsure)" beside the BPM when the pulse is weak, and you can ignore the grid.
- **Substituted notes are compromises.** Where the original pitch does not exist, the app
  picks the nearest one and marks it with a dashed underline. Hover to see what it was.
- The arranger optimises for playability, not for musical taste. Check its key choice
  against the alternatives in the dropdown — sometimes the second-best score plays better.

## Layout

```
src/core/       instrument model, arranger, melody reduction  (pure, fully tested)
src/audio/      beat tracking, Basic Pitch glue, Web Audio playback
src/ui/         tab strip, harp diagram, application wiring
src/api/        optional backend client
backend/        FastAPI service for links and vocal isolation
test/           36 tests, no browser required
```
