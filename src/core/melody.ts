/**
 * Reduces a polyphonic transcription to the single line a harmonica can actually play.
 *
 * Basic Pitch returns every note it hears, including chords, harmonies and bleed from
 * other instruments. A harmonica plays one note at a time, so something has to choose.
 * The rules here, in order of influence:
 *
 *   - Melody usually sits on top. Higher notes win ties.
 *   - Confident, sustained notes are more likely to be melody than brief, uncertain ones,
 *     which are usually transcription noise or the attack transient of another instrument.
 *   - Melodies move in small steps. A candidate near the previous note beats a distant one,
 *     which stops the line jumping an octave for a single frame and back again.
 */

import type { NoteEvent } from './arrange.ts';

export interface MelodyOptions {
  /** Notes shorter than this are treated as transcription noise. Seconds. */
  minDuration?: number;
  /** Notes below this confidence are discarded outright. 0-1. */
  minConfidence?: number;
  /** Cost of leaping one octave away from the previous note. */
  continuityWeight?: number;
  /** Gaps shorter than this between two notes of the same pitch are closed up. Seconds. */
  mergeGap?: number;
  /**
   * Beat onsets in seconds. When supplied, a repeated pitch landing on the beat is kept
   * as a separate note however small the gap before it.
   */
  beats?: number[];
}

const DEFAULTS: Required<MelodyOptions> = {
  minDuration: 0.06,
  minConfidence: 0.3,
  continuityWeight: 1.5,
  mergeGap: 0.06,
  beats: [],
};

/** How close to a beat line an onset must be to count as landing on it. Seconds. */
const ON_BEAT_TOLERANCE = 0.05;

/** Pitch range used to normalise height into roughly 0-1, so no one term can dominate. */
const HEIGHT_FLOOR = 40;
const HEIGHT_SPAN = 48;

/**
 * Every term is normalised to about 0-1 before weighting. Using raw MIDI numbers here
 * is tempting and wrong: it makes height worth twelve points per octave while confidence
 * is worth at most one, so a quiet harmonic an octave above the tune always wins.
 */
function salience(note: NoteEvent, previousMidi: number | null, continuityWeight: number): number {
  const height = (note.midi - HEIGHT_FLOOR) / HEIGHT_SPAN;
  const confidence = note.confidence ?? 0.5;
  const duration = Math.min(note.end - note.start, 1);

  let score = height * 1.0 + confidence * 1.5 + duration * 1.0;
  if (previousMidi !== null) {
    score -= (Math.abs(note.midi - previousMidi) / 12) * continuityWeight;
  }
  return score;
}

/**
 * Picks one note at a time from a polyphonic transcription, trimming overlaps so the
 * result is strictly sequential.
 */
export function extractMelody(notes: NoteEvent[], options: MelodyOptions = {}): NoteEvent[] {
  const opts = { ...DEFAULTS, ...options };

  const usable = notes
    .filter((n) => n.end - n.start >= opts.minDuration && (n.confidence ?? 1) >= opts.minConfidence)
    .sort((a, b) => a.start - b.start || b.midi - a.midi);
  if (usable.length === 0) return [];

  const line: NoteEvent[] = [];
  let previousMidi: number | null = null;
  let cursor = 0;

  while (cursor < usable.length) {
    const head = usable[cursor]!;

    // Everything starting before the head note ends is competing for the same moment.
    const competing: NoteEvent[] = [];
    for (let i = cursor; i < usable.length && usable[i]!.start < head.end; i++) {
      competing.push(usable[i]!);
    }

    const winner = competing.reduce((best, n) =>
      salience(n, previousMidi, opts.continuityWeight) > salience(best, previousMidi, opts.continuityWeight)
        ? n : best);

    // The winner runs until the next note that beats it starts, or until it ends.
    const nextStart = usable.find((n) => n.start > winner.start && n !== winner)?.start ?? Infinity;
    const end = Math.min(winner.end, nextStart);
    if (end - winner.start >= opts.minDuration) {
      line.push({ ...winner, start: winner.start, end });
      previousMidi = winner.midi;
    }

    // Advance past everything that started at or before the winner.
    const resumeFrom = Math.max(winner.start, line.at(-1)?.start ?? winner.start);
    let next = cursor;
    while (next < usable.length && usable[next]!.start <= resumeFrom) next++;
    cursor = next;
  }

  return mergeRepeats(repairOctaveErrors(line), opts.mergeGap, opts.beats);
}

/**
 * Pulls stray octave jumps back into line.
 *
 * Octave errors are the characteristic failure of every pitch transcriber: a strong second
 * harmonic gets reported instead of the fundamental. The continuity term in `salience`
 * cannot catch these, because it only chooses between candidates that overlap in time --
 * when the transcriber emits nothing but the harmonic there is no competition to lose.
 *
 * The signal we can use instead is that a real melody is locally coherent. A note sitting
 * more than a fifth away from the median of its neighbours, which an octave shift would
 * bring back inside that span, is almost certainly misheard. A genuine register change is
 * safe from this: when a melody really does move up an octave and stay there, it carries
 * the local median with it and nothing looks like an outlier.
 */
export function repairOctaveErrors(notes: NoteEvent[], windowSize = 4, toleranceSemitones = 7): NoteEvent[] {
  if (notes.length < 3) return notes;

  return notes.map((note, index) => {
    const from = Math.max(0, index - windowSize);
    const to = Math.min(notes.length, index + windowSize + 1);
    const neighbours: number[] = [];
    for (let i = from; i < to; i++) {
      if (i !== index) neighbours.push(notes[i]!.midi);
    }
    if (neighbours.length === 0) return note;

    neighbours.sort((a, b) => a - b);
    const middle = Math.floor(neighbours.length / 2);
    const median = neighbours.length % 2 === 0
      ? (neighbours[middle - 1]! + neighbours[middle]!) / 2
      : neighbours[middle]!;

    const distance = Math.abs(note.midi - median);
    if (distance <= toleranceSemitones) return note;

    // Only shift if it genuinely helps, and only by whole octaves.
    let best = note.midi;
    let bestDistance = distance;
    for (const shift of [-24, -12, 12, 24]) {
      const candidate = note.midi + shift;
      const candidateDistance = Math.abs(candidate - median);
      if (candidateDistance < bestDistance) {
        bestDistance = candidateDistance;
        best = candidate;
      }
    }
    return best === note.midi ? note : { ...note, midi: best };
  });
}

/**
 * Joins consecutive notes of identical pitch separated by an inaudible gap -- but only
 * when they are really one note the transcriber tore in half.
 *
 * Telling the two cases apart by gap size alone does not work. Basic Pitch sustains each
 * note right up to the next onset, so a deliberately repeated note (the opening of
 * Twinkle Twinkle, say) arrives with a gap of a few milliseconds, exactly like a
 * fragmented one. Rhythm is the thing that separates them: a repeat is played on the
 * beat, whereas a transcriber splits a note at an arbitrary moment. So when a beat grid
 * is available, an onset sitting on a beat is always treated as a real rearticulation.
 */
function mergeRepeats(notes: NoteEvent[], mergeGap: number, beats: number[] = []): NoteEvent[] {
  // Eighth-note resolution: fine enough for repeated notes, coarse enough that an
  // arbitrary split is unlikely to land on a line by chance.
  const grid: number[] = [];
  for (let i = 0; i < beats.length; i++) {
    grid.push(beats[i]!);
    const next = beats[i + 1];
    if (next !== undefined) grid.push((beats[i]! + next) / 2);
  }
  const startsOnBeat = (time: number): boolean =>
    grid.some((g) => Math.abs(g - time) <= ON_BEAT_TOLERANCE);

  const merged: NoteEvent[] = [];
  for (const note of notes) {
    const previous = merged.at(-1);
    const sameNote = previous && previous.midi === note.midi && note.start - previous.end <= mergeGap;
    if (sameNote && !startsOnBeat(note.start)) {
      previous.end = Math.max(previous.end, note.end);
      previous.confidence = Math.max(previous.confidence ?? 0, note.confidence ?? 0);
    } else {
      merged.push({ ...note });
    }
  }
  return merged;
}

/**
 * Quantises onsets and releases onto a beat grid. Transcribers drift by a few tens of
 * milliseconds, which is inaudible alone but makes a scrolling tab look ragged and a
 * metronome feel wrong. Notes are only nudged when they are already close to a grid line.
 */
export function quantise(notes: NoteEvent[], beats: number[], subdivisions = 4): NoteEvent[] {
  if (beats.length < 2) return notes;

  const grid: number[] = [];
  for (let i = 0; i < beats.length - 1; i++) {
    const from = beats[i]!;
    const span = beats[i + 1]! - from;
    for (let s = 0; s < subdivisions; s++) grid.push(from + (span * s) / subdivisions);
  }
  grid.push(beats.at(-1)!);

  const averageStep = (beats.at(-1)! - beats[0]!) / (beats.length - 1) / subdivisions;
  // Only snap a note that is already within a third of a subdivision; anything further
  // out is more likely swing, an ornament or a genuine syncopation than a timing error.
  const tolerance = averageStep / 3;

  const snap = (time: number): number => {
    let best = time;
    let bestDistance = tolerance;
    for (const g of grid) {
      const d = Math.abs(g - time);
      if (d < bestDistance) {
        bestDistance = d;
        best = g;
      }
    }
    return best;
  };

  return notes.map((n) => {
    const start = snap(n.start);
    const end = Math.max(start + averageStep / 2, snap(n.end));
    return { ...n, start, end };
  });
}
