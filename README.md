# Harmonica AI Song Maker

**▶ [Open the app](https://michaelraspberrypi4.github.io/harmonica-ai-song-maker/)**

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

### Blow and draw are separate holes

This is the single most important fact about the instrument, and the thing that makes its
tab unlike any other harmonica's. In Hohner's datasheet the Blow and Draw rows are drawn
offset from one another, and that offset is literal: they sit at **different places along
the comb**. You do not blow and draw into the same opening.

The arithmetic confirms it. 12 channels x 2 breath positions x 2 rows (the tremolo pair,
two reeds a few cents apart) = **48 holes per side, 96 across the instrument** — which is
where `56/96` and `2 x 48` come from. If blow and draw shared a chamber there would be
only 24 holes a side.

So the number a tab must show is the **hole position**, 1–24 along the side, not the
channel. Odd holes blow, even holes draw.

**C side, in physical order**

| Hole | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | E3↑ | G3↓ | G3↑ | B3↓ | **C4↑** | D4↓ | E4↑ | F4↓ | G4↑ | A4↓ | C5↑ | B4↓ |

| Hole | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | E5↑ | D5↓ | G5↑ | F5↓ | C6↑ | A5↓ | E6↑ | B5↓ | G6↑ | D6↓ | C7↑ | F6↓ |

**G side, in physical order**

| Hole | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | G3↑ | A3↓ | B3↑ | D4↓ | D4↑ | F♯4↓ | G4↑ | A4↓ | B4↑ | C5↓ | D5↑ | E5↓ |

| Hole | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| | G5↑ | F♯5↓ | B5↑ | A5↓ | D6↑ | C6↓ | G6↑ | E6↓ | B6↑ | F♯6↓ | D7↑ | A6↓ |

Two consequences worth internalising:

- **Middle C is hole 5, not hole 3.** Channel 3 is a pair of holes, and its blow half is
  the fifth opening along. Numbering by channel makes every note in a tab wrong.
- **The same pitch can sit in two adjacent holes.** Hole 2 draws G3 and hole 3 blows the
  same G3. The app picks whichever keeps your mouth closest to where it already was.

Chords fall out of the alternation for free: cover holes 1–5 and blow, and you sound
holes 1, 3 and 5 (E3, G3, C4) while the draw holes between them stay silent. That is why
the tab writes chords as a span — `cover 1-5` — rather than a list of holes.

Generated in [`src/core/harmonica.ts`](src/core/harmonica.ts) and pinned hole-by-hole
against the datasheet by [`test/harmonica.test.ts`](test/harmonica.test.ts).

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
6. **Fit the notes.** Every pitch is matched against the set of 30 notes the harp can
   genuinely sound — not against its range, which is not the same thing. Wiener tuning
   leaves the bottom octave incomplete, so F3 and F♯3 fall inside E3–D7 and are otherwise
   valid pitch classes, yet no hole sounds them. A miss is resolved by moving to the
   nearest octave that *does* have the note; only if the letter is absent everywhere does
   the pitch change, and then to the nearest neighbour, preferring to move down and
   preferring pitches already common in the piece. Nothing is ever dropped.
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

## Three ways in

A mode switcher at the top of the page. All three end up in the same place, because they
are the same thing underneath: a list of pitches in time, which the arranger turns into
holes and sides.

| Mode | For |
|---|---|
| **Transcribe a song** | Drop in audio, get a tab. |
| **Edit the tab** | Fix what the transcriber misheard, or rework a phrase to suit you. |
| **Write from scratch** | Click a tab in by hand and hear it played back. |

### Locking to one side

A new tab starts locked to the **C side**, and the selector offers C, G, or both. With a
side locked the arrangement is guaranteed flip-free: pitches that side cannot sound are
substituted or transposed away rather than reached for on the other one, and the editor
grid shows only the 23 pitches that side has, so there is no way to write a note the
arranger would then have to move.

Each side is a single major scale, so the cost of locking is one pitch class — the C side
has no F♯, the G side no F natural. When switching side would strand notes, the app says
how many and asks first; usually it resolves by transposing the whole tab into a key the
new side can play, which keeps the music intact. Writing a G major scale on the G side
gives `↑7 ↓8 ↑9 ↓10 ↑11 ↓12 ↓14 ↑13` with no flips; moving that tab to the C side
transposes it up a fifth rather than mangling the F♯.

The editor is a grid of pitch against time. Click to place a note, click a note to remove
it; rows are labelled with the hole each pitch lands on, and the tab strip below updates as
you go. Tempo, grid resolution and new-note length are all adjustable, work saves to this
browser automatically, and **Export** writes a JSON file you can keep or re-import.

Rows are pitches rather than holes deliberately. Which hole a note lands on depends on its
neighbours, since the side solve looks at the whole phrase — so a hole-per-row grid would
have to renumber itself under the cursor every time you placed a note.

Notes handed to the editor after a transcription are the pitches that will actually sound,
not the raw transcription. The arranger transposes, octave-folds and substitutes, and a
note left on a pitch the harp cannot play would have no row in the grid: invisible, but
still audible. That is exactly the note someone opens the editor to fix.

## The sound

The synthesised harmonica is a pair of detuned reeds ([`src/audio/reed.ts`](src/audio/reed.ts)),
not a generic oscillator. A sawtooth through a lowpass with a fast attack sounds struck,
like a cheap piano patch, for three reasons, each addressed:

- **Harmonic balance.** A sawtooth rolls off as 1/n forever. A free reed has a strong
  second and third partial, a dip at the fourth and little above the eighth, so that shape
  is specified as a table and handed to a `PeriodicWave`. Measured output matches the
  target partials exactly.
- **Attack.** 12ms reads as a hammer. A reed is set moving by air and takes 30–50ms;
  this one measures 37ms, with brightness arriving after the fundamental rather than with it.
- **Body and breath.** Fixed formants at 780Hz and 2.1kHz that do not track pitch, plus
  filtered breath noise loudest at the onset, and a shallow vibrato on longer notes.

Gain staging matters more than it looks: two summed oscillators through two peaking filters
reached 2.1x full scale in an early version and clipped, which sounds harsh however good
the timbre is. It now peaks at 0.45.

## Melody source

Dense arrangements confuse the transcriber, so there are three ways to give it a cleaner
line to follow.

| Mode | Needs | Speed | What it does |
|---|---|---|---|
| Whole mix | nothing | instant | Transcribes everything. Fine for solo recordings. |
| **Focus on the lead vocal** | nothing | ~1s | Centre-channel extraction in the browser. |
| Isolate the vocal | the backend | minutes | Demucs source separation. Cleanest on dense mixes. |

Centre focus works because commercial mixes put the lead vocal dead centre and spread
everything else out to the sides. In each frequency bin where the two channels agree the
sound is centred; where they disagree it is not. A soft mask built from that agreement,
applied to the mid signal, keeps the vocal and pushes the rest down.

It is not source separation and will not match Demucs. Bass and kick are centred too, so
they survive the mask and are removed by frequency instead; a vocal panned off-centre
defeats it; and a mono file has no stereo cue at all, so the app detects that and skips it.
On a test mix of a centred melody against a hard-panned accompaniment in the same register,
the whole mix transcribed as 26 garbled notes and centre focus gave the 14 correct ones.

[`src/audio/vocals.ts`](src/audio/vocals.ts).

## Practice features

- **A–B loop** — mark a tricky bar and repeat it endlessly.
- **Slow down to 40%** without the pitch dropping.
- **Play along with the original**, with a balance slider against the synthesised harp.
- **Metronome and 4-beat count-in**, with bar lines drawn on the tab.
- **Harp diagram** showing the lit channel and breath direction for the current note.
- **Click anywhere** on the tab strip to jump there.

## Known limitations

- **Busy mixes transcribe poorly** without help. Set **Melody source** to *Focus on the
  lead vocal* (the default) and most of the backing drops away; a solo instrument or clear
  lead vocal still works best.
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
src/ui/         tab strip, harp diagram, grid editor, application wiring
src/api/        optional backend client
backend/        FastAPI service for links and vocal isolation
test/           89 tests, no browser required
```
