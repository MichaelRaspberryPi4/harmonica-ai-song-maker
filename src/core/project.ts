/**
 * A piece of work in progress, whichever of the three ways it started.
 *
 * Transcribing a song, correcting a tab and writing one from scratch look like three
 * features but they are one: all three end up as a list of pitches in time, which the
 * arranger turns into holes and sides. Keeping that single representation means an edit
 * to a transcribed song and a note typed in from nothing go through exactly the same
 * code, and the arranger never needs to know which happened.
 *
 * Pitches and times are the source of truth, never holes. Hole and side assignment is
 * derived, because it depends on neighbouring notes -- change one note and the best side
 * for the next three can change with it.
 */

import type { NoteEvent } from './arrange.ts';
import { PLAYABLE_MIDI } from './harmonica.ts';

export interface Project {
  name: string;
  /** Source of truth: what is played, and when. */
  notes: NoteEvent[];
  bpm: number;
  beatsPerBar: number;
  /** Transposition forced by the user, or undefined to let the arranger choose. */
  forceSemitones?: number;
  /** Set when the project came from an audio file, so playback can sing along. */
  origin: 'transcribed' | 'composed';
}

export const DEFAULT_BPM = 100;
export const DEFAULT_BEATS_PER_BAR = 4;

export function emptyProject(name = 'Untitled tab'): Project {
  return {
    name,
    notes: [],
    bpm: DEFAULT_BPM,
    beatsPerBar: DEFAULT_BEATS_PER_BAR,
    origin: 'composed',
  };
}

/** Every pitch the harp can sound, highest first: one row per pitch in the editor. */
export function editorRows(): number[] {
  return [...PLAYABLE_MIDI].sort((a, b) => b - a);
}

/** An evenly spaced beat grid, for projects with no audio to detect a tempo from. */
export function beatsForTempo(bpm: number, bars: number, beatsPerBar = DEFAULT_BEATS_PER_BAR): number[] {
  const period = 60 / bpm;
  const beats: number[] = [];
  for (let i = 0; i < bars * beatsPerBar; i++) beats.push(Number((i * period).toFixed(4)));
  return beats;
}

/** Bars needed to hold the project, with a spare one to write into. */
export function barCount(project: Project, minimum = 8): number {
  const end = project.notes.reduce((a, n) => Math.max(a, n.end), 0);
  const barSeconds = (60 / project.bpm) * project.beatsPerBar;
  return Math.max(minimum, Math.ceil(end / barSeconds) + 1);
}

export function projectBeats(project: Project): number[] {
  return beatsForTempo(project.bpm, barCount(project), project.beatsPerBar);
}

/** Seconds per editor step, where `subdivision` is steps per beat. */
export function stepSeconds(bpm: number, subdivision: number): number {
  return 60 / bpm / subdivision;
}

// --- editing ----------------------------------------------------------------

const EPSILON = 1e-6;

/** The note sounding at a given pitch and moment, if any. */
export function noteAt(notes: NoteEvent[], midi: number, time: number): NoteEvent | undefined {
  return notes.find((n) => n.midi === midi && time >= n.start - EPSILON && time < n.end - EPSILON);
}

/**
 * Adds a note, trimming anything it would overlap at the same pitch.
 *
 * Overlap has to be resolved rather than allowed: two notes of one pitch sounding at once
 * is meaningless on a harmonica, and the melody reducer downstream would silently drop one
 * of them anyway. Trimming makes the outcome visible in the editor instead.
 */
export function addNote(notes: NoteEvent[], midi: number, start: number, duration: number): NoteEvent[] {
  const end = start + duration;
  const kept: NoteEvent[] = [];

  for (const note of notes) {
    if (note.midi !== midi || note.end <= start + EPSILON || note.start >= end - EPSILON) {
      kept.push(note);
      continue;
    }
    // Keep whatever of the old note falls outside the new one.
    if (note.start < start - EPSILON) kept.push({ ...note, end: start });
    if (note.end > end + EPSILON) kept.push({ ...note, start: end });
  }

  kept.push({ midi, start, end, confidence: 1 });
  return kept.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

export function removeNote(notes: NoteEvent[], midi: number, time: number): NoteEvent[] {
  const target = noteAt(notes, midi, time);
  if (!target) return notes;
  return notes.filter((n) => n !== target);
}

/** Moves every note by a number of semitones, keeping the result playable. */
export function transposeNotes(notes: NoteEvent[], semitones: number): NoteEvent[] {
  return notes.map((n) => ({ ...n, midi: n.midi + semitones }));
}

export function clearRange(notes: NoteEvent[], from: number, to: number): NoteEvent[] {
  return notes.filter((n) => n.end <= from + EPSILON || n.start >= to - EPSILON);
}

// --- persistence -------------------------------------------------------------

const STORAGE_KEY = 'harmonica.project';
const FORMAT_VERSION = 1;

interface StoredProject {
  version: number;
  project: Project;
}

export function serialize(project: Project): string {
  return JSON.stringify({ version: FORMAT_VERSION, project } satisfies StoredProject, null, 2);
}

/**
 * Parses a saved project, returning null rather than throwing.
 *
 * This reads files people may have hand-edited and localStorage that may predate a format
 * change, so every field is checked. A corrupt save should cost the user their last
 * session, not put the app in a state where it cannot start.
 */
export function deserialize(text: string): Project | null {
  try {
    const parsed = JSON.parse(text) as Partial<StoredProject>;
    const project = parsed?.project;
    if (!project || !Array.isArray(project.notes)) return null;

    // Coercing with Number() is not enough here. JSON has no NaN, so a NaN written out
    // comes back as null, and Number(null) is 0 -- a finite, plausible-looking MIDI note.
    // Requiring an actual number keeps that from silently becoming a bass C.
    const isNumber = (value: unknown): value is number =>
      typeof value === 'number' && Number.isFinite(value);

    const notes: NoteEvent[] = [];
    for (const note of project.notes) {
      const { midi, start, end } = (note ?? {}) as Partial<NoteEvent>;
      if (!isNumber(midi) || !isNumber(start) || !isNumber(end)) continue;
      if (end <= start || start < 0) continue;
      if (midi < 0 || midi > 127) continue;
      notes.push({ midi: Math.round(midi), start, end, confidence: 1 });
    }

    const bpm = project.bpm;
    const beatsPerBar = project.beatsPerBar;
    const forced = project.forceSemitones;
    return {
      name: typeof project.name === 'string' && project.name ? project.name : 'Untitled tab',
      notes: notes.sort((a, b) => a.start - b.start),
      bpm: isNumber(bpm) && bpm >= 20 && bpm <= 300 ? bpm : DEFAULT_BPM,
      beatsPerBar: isNumber(beatsPerBar) && beatsPerBar > 0 && beatsPerBar <= 16
        ? Math.round(beatsPerBar) : DEFAULT_BEATS_PER_BAR,
      forceSemitones: isNumber(forced) && Math.abs(forced) <= 24 ? Math.round(forced) : undefined,
      origin: project.origin === 'transcribed' ? 'transcribed' : 'composed',
    };
  } catch {
    return null;
  }
}

/** Browser storage is unavailable in private mode and can throw; never let that break a save. */
export function saveLocal(project: Project): void {
  try {
    localStorage.setItem(STORAGE_KEY, serialize(project));
  } catch {
    /* the work stays in memory; the user can still export it */
  }
}

export function loadLocal(): Project | null {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    return text ? deserialize(text) : null;
  } catch {
    return null;
  }
}
