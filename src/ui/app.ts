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
import { playableMidiForSide } from '../core/harmonica.ts';
import { detectBeats } from '../audio/beats.ts';
import { decodeStereo, decodeToMono, transcribe, channelData, bufferFromSamples } from '../audio/transcribe.ts';
import { isolateCentre, hasUsableStereo } from '../audio/vocals.ts';
import { Player } from '../audio/player.ts';
import { TabView } from './tab-view.ts';
import { Editor } from './editor.ts';
import {
  addNote, removeNote, clearRange, emptyProject, projectBeats, barCount,
  saveLocal, loadLocal, serialize, deserialize, type Project,
} from '../core/project.ts';
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
let project: Project = emptyProject();
let editor: Editor | null = null;
type Mode = 'transcribe' | 'edit' | 'create';
let mode: Mode = 'transcribe';
let arrangement: ArrangeResult | null = null;
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
  const audio = await decodeStereo(data);

  // Beat tracking always runs on the full mix. Drums are exactly what a vocal-focused
  // signal throws away, so isolating first would blind the tempo detector.
  setStatus('Finding the beat…', 'working');
  setProgress(0.15);
  const grid = detectBeats(audio.mono, audio.sampleRate);

  const focus = $<HTMLSelectElement>('vocal-focus').value;
  let melodySource = audio.mono;

  if (focus === 'centre') {
    if (audio.stereo && hasUsableStereo(audio.left, audio.right)) {
      setStatus('Focusing on the centre of the mix…', 'working');
      setProgress(0.2);
      melodySource = isolateCentre(audio.left, audio.right, audio.sampleRate);
    } else {
      setStatus('Recording is mono, so there is no centre to isolate — using the whole mix.', 'info');
    }
  } else if (focus === 'demucs') {
    setStatus('Isolating the vocal on the server — this takes a few minutes…', 'working');
    setProgress(0.2);
    try {
      const wav = await isolateVocals(new Blob([data]));
      melodySource = channelData(await decodeToMono(wav));
    } catch (error) {
      // Not fatal: the mix transcribes acceptably, just less cleanly.
      setStatus(`Vocal isolation failed (${(error as Error).message}). Using the full mix.`, 'info');
    }
  }

  setStatus('Transcribing notes — this is the slow part…', 'working');
  const raw = await transcribe(bufferFromSamples(melodySource, audio.sampleRate), {
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

  // Hand the editor the pitches that will actually sound, not the raw transcription.
  // The arranger transposes, octave-folds and substitutes; a note left on a pitch the harp
  // cannot play has no row in the grid, so it would be invisible there while still being
  // heard -- exactly the note someone opens the editor to correct.
  const played = result.layers.easy.notes.map((n) => ({
    midi: n.midi, start: n.start, end: n.end, confidence: 1,
    position: n.holes[0]?.position,
  }));

  project = {
    name,
    notes: played,
    bpm: grid.bpm > 0 ? grid.bpm : project.bpm,
    beatsPerBar: project.beatsPerBar,
    forceSemitones: undefined,
    origin: 'transcribed',
  };

  setProgress(null);
  const shift = result.chosen.semitones;
  const changed = result.layers.easy.notes.filter((n) => n.altered !== 'none').length;
  setStatus(
    `Ready: ${name}`
    + (shift !== 0 ? ` — transposed ${shift > 0 ? '+' : ''}${shift} semitones to fit the harp` : '')
    + (changed > 0 ? `, ${changed} note${changed === 1 ? '' : 's'} adjusted` : ''),
    'done',
  );
  syncEditorControls();
  rebuild();
}

/**
 * The beat grid in force: detected from the audio when a song was transcribed, generated
 * from the project's tempo when it was written by hand.
 */
function currentBeats(): number[] {
  if (project.origin === 'transcribed' && state) return state.beats;
  return projectBeats(project);
}

/**
 * Re-derives everything from the project and repaints.
 *
 * Every path in the app funnels through here -- finishing a transcription, clicking a note
 * into the grid, changing key, changing tempo -- so a hand-written tab and a transcribed
 * one cannot drift apart in behaviour.
 */
function rebuild(options: { save?: boolean } = {}): void {
  const beats = currentBeats();
  arrangement = arrange(project.notes, {
    beats,
    forceSemitones: project.forceSemitones,
    lockSide: project.lockedSide,
  });
  if (options.save !== false) saveLocal(project);
  showArrangement();
  if (mode !== 'transcribe') {
    const barSeconds = (60 / project.bpm) * project.beatsPerBar;
    editor?.render(project, barCount(project) * barSeconds);
  }
}

function reArrange(forceSemitones?: number): void {
  project.forceSemitones = forceSemitones;
  rebuild();
}

// --- rendering --------------------------------------------------------------

function showArrangement(): void {
  if (!arrangement) return;
  const result = arrangement;
  const layer = result.layers[difficulty];
  const beats = currentBeats();

  $('results').hidden = false;
  $('song-title').textContent = project.name;

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
    stat('Tempo', project.origin === 'transcribed' && state
      ? `${Math.round(state.bpm)} bpm${state.beatConfidence < 0.3 ? ' (unsure)' : ''}`
      : `${Math.round(project.bpm)} bpm`),
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

  tabView?.render(layer.notes, beats, difficulty);
  // ensurePlayer(), not player?. -- on a fresh page the player does not exist yet, so an
  // optional call here silently dropped the arrangement and the synth had nothing to play.
  // The first song loaded in a tab was therefore completely silent.
  const active = ensurePlayer();
  active.setArrangement(layer.notes, beats);
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
      editor?.update(seconds);
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

// --- modes and the editor ----------------------------------------------------

const MODES: Mode[] = ['transcribe', 'edit', 'create'];

function setMode(next: Mode): void {
  mode = next;
  for (const m of MODES) {
    const button = $(`mode-${m}`);
    button.classList.toggle('selected', m === next);
    button.setAttribute('aria-pressed', String(m === next));
  }
  $('panel-transcribe').hidden = next !== 'transcribe';
  $('panel-editor').hidden = next === 'transcribe';

  if (next === 'create' && project.origin === 'transcribed') {
    // Starting fresh should not silently discard a transcription, so it becomes a new
    // project only on an explicit confirmation.
    if (confirm('Start a new empty tab? The transcribed one will be replaced.')) {
      project = emptyProject();
      state = null;
      ensurePlayer().detachTrack();
    }
  }
  syncEditorControls();
  rebuild({ save: false });
}

function syncEditorControls(): void {
  $<HTMLInputElement>('project-name').value = project.name;
  $<HTMLInputElement>('project-bpm').value = String(Math.round(project.bpm));
  $<HTMLSelectElement>('locked-side').value = project.lockedSide ?? '';
  $('side-hint').textContent = project.lockedSide
    ? `Locked to the ${project.lockedSide} side: every note is reachable without turning the harp over. `
      + `That side plays ${project.lockedSide === 'C' ? 'C major, so there is no F sharp' : 'G major, so there is no F natural'} — `
      + 'anything needing it is moved to the nearest note this side has.'
    : 'Both sides in use. The arranger will pick sides for you and may ask you to turn the harp over mid-tune.';
}

function download(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function wireEditor(): void {
  editor = new Editor($('editor-container'), {
    onAdd: (midi, start, duration, position) => {
      project.notes = addNote(project.notes, midi, start, duration, position);
      rebuild();
      // Sound the note back so writing a tab is audible as you go.
      const p = ensurePlayer();
      void p.context.resume().then(() => p.preview(midi, duration));
    },
    onRemove: (midi, time) => {
      project.notes = removeNote(project.notes, midi, time);
      rebuild();
    },
  });

  $<HTMLInputElement>('project-name').addEventListener('input', (event) => {
    project.name = (event.target as HTMLInputElement).value || 'Untitled tab';
    saveLocal(project);
    $('song-title').textContent = project.name;
  });

  $<HTMLInputElement>('project-bpm').addEventListener('change', (event) => {
    const bpm = Number((event.target as HTMLInputElement).value);
    if (!Number.isFinite(bpm) || bpm < 30 || bpm > 260) {
      syncEditorControls();
      return;
    }
    // Keep the music where it sits on the grid rather than in absolute seconds, so
    // changing tempo re-times the tab instead of scattering the notes off the beat.
    const ratio = project.bpm / bpm;
    project.notes = project.notes.map((n) => ({ ...n, start: n.start * ratio, end: n.end * ratio }));
    project.bpm = bpm;
    rebuild();
  });

  $<HTMLSelectElement>('locked-side').addEventListener('change', (event) => {
    const value = (event.target as HTMLSelectElement).value;
    const next = value === 'C' || value === 'G' ? value : undefined;

    // Changing side can move notes the new side cannot sound, so say so rather than
    // letting a tab quietly change under the writer.
    if (next && project.notes.length > 0) {
      const reachable = playableMidiForSide(next);
      const stranded = project.notes.filter((n) => !reachable.has(n.midi)).length;
      // Say "adjusted" rather than "moved": the key search usually transposes the whole
      // tab into a key the side can play, which keeps the music intact, and only falls
      // back to shifting individual notes when no transposition fits.
      if (stranded > 0 && !confirm(
        `${stranded} note${stranded === 1 ? '' : 's'} cannot be played on the ${next} side. `
        + 'The tab will be adjusted to fit — usually by transposing the whole thing to a key '
        + 'that side can play. Continue?')) {
        syncEditorControls();
        return;
      }
      // Commit the move so the grid shows what will actually be played.
      const fitted = arrange(project.notes, {
        beats: currentBeats(), forceSemitones: project.forceSemitones, lockSide: next,
      });
      project.notes = fitted.layers.easy.notes.map((n) => ({
        midi: n.midi, start: n.start, end: n.end, confidence: 1,
        position: n.holes[0]?.position,
      }));
      project.forceSemitones = fitted.chosen.semitones === 0 ? project.forceSemitones : undefined;
    }

    project.lockedSide = next;
    syncEditorControls();
    rebuild();
  });

  $<HTMLSelectElement>('grid-subdivision').addEventListener('change', (event) => {
    if (editor) editor.subdivision = Number((event.target as HTMLSelectElement).value);
    rebuild({ save: false });
  });

  $<HTMLSelectElement>('note-length').addEventListener('change', (event) => {
    if (editor) editor.noteLengthSteps = Number((event.target as HTMLSelectElement).value);
  });

  $('editor-clear').addEventListener('click', () => {
    if (project.notes.length === 0) return;
    if (!confirm(`Delete all ${project.notes.length} notes?`)) return;
    project.notes = clearRange(project.notes, 0, Number.MAX_SAFE_INTEGER);
    rebuild();
  });

  $('editor-export').addEventListener('click', () => {
    download(`${project.name.replace(/[^\w -]/g, '') || 'tab'}.json`, serialize(project));
  });

  $('editor-import').addEventListener('click', () => $<HTMLInputElement>('editor-import-file').click());

  $<HTMLInputElement>('editor-import-file').addEventListener('change', async (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const loaded = deserialize(await file.text());
    if (!loaded) {
      setStatus('That file is not a tab this app can read.', 'error');
      return;
    }
    project = loaded;
    state = null;
    ensurePlayer().detachTrack();
    syncEditorControls();
    rebuild();
    setStatus(`Loaded ${project.name}`, 'done');
  });

  for (const m of MODES) $(`mode-${m}`).addEventListener('click', () => setMode(m));
}

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
    const demucsOption = document.querySelector<HTMLOptionElement>('#vocal-focus option[value="demucs"]');
    if (demucsOption) demucsOption.disabled = !health?.demucs;
    $('focus-hint').textContent = health?.demucs
      ? 'Server isolation is available and gives the cleanest result, but takes a few minutes per song.'
      : 'Browser focus works on any stereo recording and takes about a second. True vocal isolation '
        + 'is cleaner still on dense mixes but needs the optional backend — add one in Settings.';
    if (!health) {
      $('backend-hint').textContent =
        'No backend configured — upload an audio file to get started, or add a backend in Settings for link support.';
    }
  });

  wireEditor();

  // Pick up where the last session left off. A transcription cannot be restored (the
  // audio is gone), but a hand-written tab is entirely in the saved notes.
  const saved = loadLocal();
  if (saved && saved.notes.length > 0) {
    project = saved;
    project.origin = 'composed';
    syncEditorControls();
    rebuild({ save: false });
    setStatus(`Restored "${project.name}" from your last session.`, 'info');
  } else {
    syncEditorControls();
    setStatus('Drop an audio file to begin, or switch to "Write from scratch".');
  }
}
