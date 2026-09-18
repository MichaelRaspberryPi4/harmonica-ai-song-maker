/**
 * Application wiring: input -> pipeline -> arrangement -> playback.
 *
 * The pipeline is deliberately linear and re-runnable. Transcription is the slow step and
 * its output is cached, so changing key or difficulty re-arranges instantly rather than
 * re-analysing the audio.
 */

import { arrange, type ArrangeResult, type Difficulty, type NoteEvent } from '../core/arrange.ts';
import { extractMelody, quantise } from '../core/melody.ts';
import { midiToName } from '../core/pitch.ts';
import { detectBeats } from '../audio/beats.ts';
import { decodeToMono, transcribe, channelData } from '../audio/transcribe.ts';
import { Player } from '../audio/player.ts';
import { TabView } from './tab-view.ts';
import {
  checkHealth, extractFromLink, getBackendUrl, isolateVocals, setBackendUrl,
} from '../api/backend.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element #${id}`);
  return element as T;
};

interface SongState {
  name: string;
  /** Object URL of the audio the player sings along to. */
  trackUrl: string;
  rawNotes: NoteEvent[];
  beats: number[];
  bpm: number;
  beatConfidence: number;
  result: ArrangeResult;
}

let state: SongState | null = null;
let difficulty: Difficulty = 'easy';
let player: Player | null = null;
let tabView: TabView | null = null;
let loopStart: number | null = null;

// --- status reporting -------------------------------------------------------

function setStatus(message: string, kind: 'info' | 'working' | 'error' | 'done' = 'info'): void {
  const status = $('status');
  status.textContent = message;
  status.className = `status ${kind}`;
}

function setProgress(fraction: number | null): void {
  const bar = $<HTMLProgressElement>('progress');
  if (fraction === null) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  bar.value = Math.max(0, Math.min(1, fraction));
}

// --- the pipeline -----------------------------------------------------------

async function processAudio(data: ArrayBuffer, name: string): Promise<void> {
  setStatus('Decoding audio…', 'working');
  setProgress(0.05);
  const buffer = await decodeToMono(data);

  let analysed = buffer;
  if ($<HTMLInputElement>('isolate-vocals').checked) {
    setStatus('Isolating the vocal on the server — this takes a few minutes…', 'working');
    setProgress(0.1);
    try {
      const wav = await isolateVocals(new Blob([data]));
      analysed = await decodeToMono(wav);
    } catch (error) {
      // Not fatal: the mix transcribes acceptably, just less cleanly.
      setStatus(`Vocal isolation failed (${(error as Error).message}). Using the full mix.`, 'info');
    }
  }

  setStatus('Finding the beat…', 'working');
  setProgress(0.2);
  const grid = detectBeats(channelData(analysed), analysed.sampleRate);

  setStatus('Transcribing notes — this is the slow part…', 'working');
  const raw = await transcribe(analysed, {
    onProgress: (fraction) => setProgress(0.25 + fraction * 0.65),
  });

  setStatus('Arranging for the harp…', 'working');
  setProgress(0.95);
  const melody = quantise(extractMelody(raw, { beats: grid.beats }), grid.beats);
  const result = arrange(melody, { beats: grid.beats });

  state = {
    name,
    trackUrl: URL.createObjectURL(new Blob([data])),
    rawNotes: melody,
    beats: grid.beats,
    bpm: grid.bpm,
    beatConfidence: grid.confidence,
    result,
  };

  setProgress(null);
  setStatus(`Ready: ${name}`, 'done');
  showArrangement();
}

function reArrange(forceSemitones?: number): void {
  if (!state) return;
  state.result = arrange(state.rawNotes, { beats: state.beats, forceSemitones });
  showArrangement();
}

// --- rendering --------------------------------------------------------------

function showArrangement(): void {
  if (!state) return;
  const { result } = state;
  const layer = result.layers[difficulty];

  $('results').hidden = false;
  $('song-title').textContent = state.name;

  const onC = layer.notes.filter((n) => n.side === 'C').length;
  const onG = layer.notes.filter((n) => n.side === 'G').length;
  const sidesUsed = onC > 0 && onG > 0 ? `both (${onC} C / ${onG} G)`
    : onG > 0 ? 'G side only'
    : onC > 0 ? 'C side only'
    : '—';

  const substituted = layer.notes.filter((n) => n.altered === 'substituted').length;
  const octaveMoved = layer.notes.filter((n) => n.altered === 'octave').length;
  const pitches = layer.notes.map((n) => n.midi);

  $('stats').innerHTML = [
    stat('Playability', `${Math.round(result.chosen.score)}/100`),
    stat('Transposed', result.chosen.semitones === 0
      ? 'original key'
      : `${result.chosen.semitones > 0 ? '+' : ''}${result.chosen.semitones} semitones`),
    stat('Tempo', state.bpm > 0
      ? `${Math.round(state.bpm)} bpm${state.beatConfidence < 0.3 ? ' (unsure)' : ''}`
      : 'not detected'),
    stat('Notes', String(layer.notes.length)),
    stat('Side', sidesUsed),
    stat('Harp flips', String(layer.sideFlips)),
    stat('Substituted', substituted > 0 ? `${substituted} note${substituted === 1 ? '' : 's'}` : 'none'),
    stat('Octave-moved', octaveMoved > 0 ? `${octaveMoved}` : 'none'),
    stat('Range', pitches.length > 0
      ? `${midiToName(Math.min(...pitches))} – ${midiToName(Math.max(...pitches))}`
      : '—'),
  ].join('');

  const keySelect = $<HTMLSelectElement>('key-select');
  keySelect.replaceChildren();
  const options = [result.chosen, ...result.alternatives]
    .sort((a, b) => b.score - a.score);
  for (const option of options) {
    const element = document.createElement('option');
    element.value = String(option.semitones);
    const shift = option.semitones === 0
      ? 'Original key'
      : `${option.semitones > 0 ? '+' : ''}${option.semitones} semitones`;
    element.textContent = `${shift} — ${Math.round(option.score)}/100`
      + (option.outOfScale > 0 ? `, ${option.outOfScale} impossible notes` : '');
    element.selected = option.semitones === result.chosen.semitones;
    keySelect.appendChild(element);
  }

  tabView?.render(layer.notes, state.beats, difficulty);
  // ensurePlayer(), not player?. -- on a fresh page the player does not exist yet, so an
  // optional call here silently dropped the arrangement and the synth had nothing to play.
  // The first song loaded in a tab was therefore completely silent.
  const active = ensurePlayer();
  active.setArrangement(layer.notes, state.beats);
  tabView?.update(active.currentTime);
}

function stat(label: string, value: string): string {
  return `<div class="stat"><dt>${label}</dt><dd>${value}</dd></div>`;
}

// --- player wiring ----------------------------------------------------------

function ensurePlayer(): Player {
  if (player) return player;
  player = new Player({
    onTime: (seconds) => {
      tabView?.update(seconds);
      const scrub = $<HTMLInputElement>('scrub');
      if (document.activeElement !== scrub) {
        scrub.value = String(seconds);
        scrub.max = String(Math.max(1, player?.duration ?? 1));
      }
      $('time-readout').textContent = formatTime(seconds);
    },
    onEnded: () => { $<HTMLButtonElement>('play').textContent = '▶ Play'; },
  });
  return player;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// --- input handling ---------------------------------------------------------

async function handleFile(file: File): Promise<void> {
  try {
    const data = await file.arrayBuffer();
    await processAudio(data, file.name.replace(/\.[^.]+$/, ''));
    const p = ensurePlayer();
    if (state) p.attachTrack(state.trackUrl);
  } catch (error) {
    setProgress(null);
    setStatus(`Could not process that file: ${(error as Error).message}`, 'error');
  }
}

async function handleLink(url: string): Promise<void> {
  try {
    setStatus('Asking the backend for the audio (a sleeping Space takes ~30s to wake)…', 'working');
    setProgress(0.02);
    const data = await extractFromLink(url);
    await processAudio(data, url);
    const p = ensurePlayer();
    if (state) p.attachTrack(state.trackUrl);
  } catch (error) {
    setProgress(null);
    setStatus(`Link failed: ${(error as Error).message}`, 'error');
  }
}

// --- bootstrap --------------------------------------------------------------

export function start(): void {
  tabView = new TabView($('tab-container'), $('harp-container'), {
    onSeek: (seconds) => {
      ensurePlayer().seek(seconds);
      tabView?.update(seconds);
    },
    onSelectNote: (index) => {
      if (!state) return;
      const note = state.result.layers[difficulty].notes[index];
      if (note) {
        ensurePlayer().seek(note.start);
        tabView?.update(note.start);
      }
    },
  });

  $<HTMLInputElement>('file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void handleFile(file);
  });

  const drop = $('drop-zone');
  drop.addEventListener('dragover', (event) => {
    event.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('over');
    const file = event.dataTransfer?.files?.[0];
    if (file) void handleFile(file);
  });

  $('load-sample').addEventListener('click', async () => {
    try {
      setStatus('Loading the sample…', 'working');
      // Resolved against the deployed base path, which differs between dev and Pages.
      const response = await fetch(new URL('test-tune.wav', document.baseURI));
      if (!response.ok) throw new Error(`sample not found (${response.status})`);
      await processAudio(await response.arrayBuffer(), 'Sample — Twinkle Twinkle');
      const p = ensurePlayer();
      if (state) p.attachTrack(state.trackUrl);
    } catch (error) {
      setProgress(null);
      setStatus(`Could not load the sample: ${(error as Error).message}`, 'error');
    }
  });

  $('load-link').addEventListener('click', () => {
    const url = $<HTMLInputElement>('link').value.trim();
    if (url) void handleLink(url);
  });

  for (const level of ['easy', 'medium', 'full'] as const) {
    $(`difficulty-${level}`).addEventListener('click', () => {
      difficulty = level;
      document.querySelectorAll('.difficulty button').forEach((b) => b.classList.remove('selected'));
      $(`difficulty-${level}`).classList.add('selected');
      showArrangement();
    });
  }

  $<HTMLSelectElement>('key-select').addEventListener('change', (event) => {
    reArrange(Number((event.target as HTMLSelectElement).value));
  });

  $('play').addEventListener('click', async () => {
    const p = ensurePlayer();
    const button = $<HTMLButtonElement>('play');
    if (button.textContent?.startsWith('▶')) {
      button.textContent = '⏸ Pause';
      try {
        await p.play();
      } catch (error) {
        // Browsers reject play() without a recent user gesture. Swallowing that left the
        // button reading "Pause" while nothing was playing, which is worse than the error.
        button.textContent = '▶ Play';
        p.pause();
        setStatus(`Playback could not start: ${(error as Error).message}`, 'error');
      }
    } else {
      button.textContent = '▶ Play';
      p.pause();
    }
  });

  $<HTMLInputElement>('scrub').addEventListener('input', (event) => {
    const seconds = Number((event.target as HTMLInputElement).value);
    ensurePlayer().seek(seconds);
    tabView?.update(seconds);
  });

  $<HTMLInputElement>('speed').addEventListener('input', (event) => {
    const rate = Number((event.target as HTMLInputElement).value);
    ensurePlayer().rate = rate;
    $('speed-readout').textContent = `${Math.round(rate * 100)}%`;
  });

  $<HTMLInputElement>('track-volume').addEventListener('input', (event) => {
    ensurePlayer().trackVolume = Number((event.target as HTMLInputElement).value);
  });
  $<HTMLInputElement>('harp-volume').addEventListener('input', (event) => {
    ensurePlayer().harmonicaVolume = Number((event.target as HTMLInputElement).value);
  });
  $<HTMLInputElement>('metronome').addEventListener('change', (event) => {
    ensurePlayer().metronomeOn = (event.target as HTMLInputElement).checked;
  });
  $<HTMLInputElement>('count-in').addEventListener('change', (event) => {
    ensurePlayer().countInBeats = (event.target as HTMLInputElement).checked ? 4 : 0;
  });

  $('loop-set').addEventListener('click', () => {
    const p = ensurePlayer();
    if (loopStart === null) {
      loopStart = p.currentTime;
      $('loop-set').textContent = 'Set B';
      $('loop-readout').textContent = `A at ${formatTime(loopStart)}`;
    } else {
      const end = p.currentTime;
      if (end > loopStart) {
        p.loop = { start: loopStart, end };
        $('loop-readout').textContent = `${formatTime(loopStart)} – ${formatTime(end)}`;
      }
      loopStart = null;
      $('loop-set').textContent = 'Set A';
    }
  });

  $('loop-clear').addEventListener('click', () => {
    ensurePlayer().loop = null;
    loopStart = null;
    $('loop-set').textContent = 'Set A';
    $('loop-readout').textContent = 'no loop';
  });

  // Settings
  const backendInput = $<HTMLInputElement>('backend-url');
  backendInput.value = getBackendUrl();
  $('save-backend').addEventListener('click', async () => {
    setBackendUrl(backendInput.value.trim());
    setStatus('Checking the backend…', 'working');
    const health = await checkHealth();
    setStatus(
      health
        ? `Backend reachable. Links: ${health.ytdlp ? 'yes' : 'no'}. Vocal isolation: ${health.demucs ? 'yes' : 'no'}.`
        : 'No backend reachable. File upload still works.',
      health ? 'done' : 'error',
    );
  });

  void checkHealth().then((health) => {
    $<HTMLInputElement>('link').disabled = !health?.ytdlp;
    $<HTMLButtonElement>('load-link').disabled = !health?.ytdlp;
    $<HTMLInputElement>('isolate-vocals').disabled = !health?.demucs;
    if (!health) {
      $('backend-hint').textContent =
        'No backend configured — upload an audio file to get started, or add a backend in Settings for link support.';
    }
  });

  setStatus('Drop an audio file to begin.');
}
