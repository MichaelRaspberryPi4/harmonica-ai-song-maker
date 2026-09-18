/**
 * Turns a transcribed melody into something playable on the Echo Harp 56/96.
 *
 * The instrument imposes three hard constraints, and this module is organised around them:
 *
 *   1. Only eight pitch classes exist (C D E F F# G A B) and tremolo reeds do not bend,
 *      so a quarter of the chromatic scale is simply absent. -> chooseTransposition, substitute
 *   2. The range is E3-D7, narrower than most songs. -> foldIntoRange
 *   3. F natural lives only on the C side and F# only on the G side, so some songs force
 *      you to physically flip the harp. Flipping mid-phrase is the one genuinely expensive
 *      physical action, so side assignment is solved globally, not note by note. -> assignSides
 */

import {
  LAYOUT, LOWEST_MIDI, HIGHEST_MIDI, PLAYABLE_PITCH_CLASSES, PLAYABLE_MIDI,
  holesForMidi, type Hole, type Side, type Direction,
} from './harmonica.ts';
import { pitchClass } from './pitch.ts';

export interface NoteEvent {
  midi: number;
  /** Seconds from the start of the track. */
  start: number;
  end: number;
  confidence?: number;
}

export type Alteration = 'none' | 'octave' | 'substituted';

export interface ArrangedNote {
  start: number;
  end: number;
  /** The pitch actually sounded on the harp. */
  midi: number;
  /** The pitch the transcriber heard, before transposition, folding or substitution. */
  sourceMidi: number;
  side: Side;
  direction: Direction;
  /** Melody hole first; any octave-double or chord tones follow. */
  holes: Hole[];
  altered: Alteration;
}

export type Difficulty = 'easy' | 'medium' | 'full';

export interface Arrangement {
  difficulty: Difficulty;
  notes: ArrangedNote[];
  sideFlips: number;
}

export interface TranspositionOption {
  /** Semitones to shift the source material. */
  semitones: number;
  /** 0-100. Higher is more comfortable to play. */
  score: number;
  /** Notes landing on a pitch class the harp does not have, before substitution. */
  outOfScale: number;
  /** Notes needing an octave shift to fit E3-D7. */
  octaveShifted: number;
  estimatedFlips: number;
}

export interface ArrangeResult {
  chosen: TranspositionOption;
  alternatives: TranspositionOption[];
  layers: Record<Difficulty, Arrangement>;
}

// --- tuning constants -------------------------------------------------------
// Flipping the harp costs far more than any other compromise, so it dominates the
// scoring. A flip across a long rest is nearly free; one mid-phrase is close to
// impossible, and the cost curve below reflects that rather than counting flips flat.
const FLIP_COST_MAX = 40;
const FLIP_COST_MIN = 1;
/** A gap at or above this many seconds makes a flip comfortable. */
const FLIP_COMFORT_GAP = 0.8;
const UNPLAYABLE_ON_SIDE = 1000;

function flipCost(gapSeconds: number): number {
  const comfort = Math.max(0, Math.min(1, gapSeconds / FLIP_COMFORT_GAP));
  return FLIP_COST_MIN + (FLIP_COST_MAX - FLIP_COST_MIN) * (1 - comfort);
}

// --- range and pitch fitting ------------------------------------------------

/** Shifts a pitch by whole octaves until it sits inside the instrument's range. */
export function foldIntoRange(midi: number): { midi: number; shifted: boolean } {
  let m = midi;
  while (m < LOWEST_MIDI) m += 12;
  while (m > HIGHEST_MIDI) m -= 12;
  return { midi: m, shifted: m !== midi };
}

/**
 * The nearest pitch of the same letter that a hole actually produces.
 *
 * Being inside E3-D7 with a playable pitch class is *not* enough to be playable. Wiener
 * tuning leaves the bottom octave incomplete: F3 and F#3 both fall in range and are both
 * perfectly good pitch classes elsewhere on the harp, yet no hole on either side sounds
 * them. Range-checking alone silently loses those notes.
 */
export function nearestPlayableOctave(midi: number): number {
  if (PLAYABLE_MIDI.has(midi)) return midi;
  let best: number | null = null;
  for (const candidate of PLAYABLE_MIDI) {
    if (pitchClass(candidate) !== pitchClass(midi)) continue;
    if (best === null || Math.abs(candidate - midi) < Math.abs(best - midi)) best = candidate;
  }
  return best ?? midi;
}

/** The nearest pitch of any letter that a hole actually produces. The last resort. */
export function nearestPlayablePitch(midi: number): number {
  if (PLAYABLE_MIDI.has(midi)) return midi;
  let best = midi;
  let bestDistance = Infinity;
  for (const candidate of PLAYABLE_MIDI) {
    const distance = Math.abs(candidate - midi);
    // Ties go downward: a flattened note reads as a colour choice, a sharpened one as an error.
    if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

/**
 * Maps any pitch onto a note the instrument can genuinely sound, and says what it cost.
 *
 * This is the guarantee the rest of the pipeline relies on: whatever comes in, what comes
 * out corresponds to a real hole. Nothing is ever dropped, because a missing note in the
 * middle of a tune you are learning is worse than an approximated one.
 */
export function fitToInstrument(
  midi: number,
  keyPitchClasses: ReadonlySet<number>,
): { midi: number; altered: Alteration } {
  if (PLAYABLE_MIDI.has(midi)) return { midi, altered: 'none' };

  // The letter exists somewhere on the harp: move it by octaves to where it lives.
  if (PLAYABLE_PITCH_CLASSES.has(pitchClass(midi))) {
    return { midi: nearestPlayableOctave(midi), altered: 'octave' };
  }

  // The letter does not exist at all, so the pitch has to change.
  const swapped = substitute(midi, keyPitchClasses);
  return { midi: nearestPlayablePitch(swapped), altered: 'substituted' };
}

/**
 * Replaces a pitch the harp cannot produce with the nearest one it can, preferring to
 * move down (a flattened leading tone reads as bluesy; a sharpened one reads as wrong)
 * and preferring pitch classes already common in the piece.
 */
export function substitute(midi: number, keyPitchClasses: ReadonlySet<number>): number {
  if (PLAYABLE_PITCH_CLASSES.has(pitchClass(midi))) return midi;
  const candidates: Array<{ midi: number; cost: number }> = [];
  for (const delta of [-1, 1, -2, 2]) {
    const m = midi + delta;
    if (!PLAYABLE_PITCH_CLASSES.has(pitchClass(m))) continue;
    let cost = Math.abs(delta) * 2 + (delta > 0 ? 1 : 0);
    if (keyPitchClasses.has(pitchClass(m))) cost -= 2;
    candidates.push({ midi: m, cost });
  }
  if (candidates.length === 0) return midi;
  candidates.sort((a, b) => a.cost - b.cost);
  return candidates[0]!.midi;
}

/** Pitch classes carrying the most weight in the melody, used to steer substitutions. */
function dominantPitchClasses(notes: NoteEvent[]): Set<number> {
  const weight: number[] = new Array(12).fill(0);
  for (const n of notes) {
    weight[pitchClass(n.midi)] = weight[pitchClass(n.midi)]! + Math.max(0.05, n.end - n.start);
  }
  const ranked = weight
    .map((w, pc) => ({ w, pc }))
    .sort((a, b) => b.w - a.w)
    .slice(0, 7)
    .map((x) => x.pc);
  return new Set(ranked);
}

// --- transposition search ---------------------------------------------------

function sidesFor(midi: number): Set<Side> {
  const sides = new Set<Side>();
  for (const h of holesForMidi(midi)) sides.add(h.side);
  return sides;
}

/** A cheap flip estimate used for ranking transpositions, before the real DP runs. */
function estimateFlips(notes: NoteEvent[], semitones: number): number {
  let flips = 0;
  let current: Side | null = null;
  for (const n of notes) {
    const { midi } = foldIntoRange(n.midi + semitones);
    const sides = sidesFor(midi);
    if (sides.size !== 1) continue; // playable either side, or not at all: constrains nothing
    const only = [...sides][0]!;
    if (current !== null && only !== current) flips++;
    current = only;
  }
  return flips;
}

export function scoreTransposition(notes: NoteEvent[], semitones: number): TranspositionOption {
  let outOfScale = 0;
  let octaveShifted = 0;
  for (const n of notes) {
    const shifted = n.midi + semitones;
    if (!PLAYABLE_PITCH_CLASSES.has(pitchClass(shifted))) {
      outOfScale++;
    } else if (!PLAYABLE_MIDI.has(shifted)) {
      // Right letter, wrong octave -- including the F3/F#3 gap in the bottom octave,
      // which a plain range check would wrongly call playable.
      octaveShifted++;
    }
  }
  const total = Math.max(1, notes.length);
  const estimatedFlips = estimateFlips(notes, semitones);

  // Out-of-scale notes are the worst outcome: every one is a note the listener will
  // hear as wrong. Octave folding only breaks melodic contour, so it costs less.
  const scalePenalty = (outOfScale / total) * 70;
  const foldPenalty = (octaveShifted / total) * 18;
  const flipPenalty = Math.min(12, (estimatedFlips / total) * 60);
  const score = Math.max(0, 100 - scalePenalty - foldPenalty - flipPenalty);

  return { semitones, score, outOfScale, octaveShifted, estimatedFlips };
}

export function chooseTransposition(notes: NoteEvent[]): TranspositionOption[] {
  const options: TranspositionOption[] = [];
  for (let semitones = -11; semitones <= 11; semitones++) {
    options.push(scoreTransposition(notes, semitones));
  }
  // Ties break toward leaving the song in its original key.
  options.sort((a, b) =>
    b.score - a.score || Math.abs(a.semitones) - Math.abs(b.semitones) || a.semitones - b.semitones);
  return options;
}

// --- side assignment --------------------------------------------------------

/**
 * Picks a side for every note so that (unplayable notes + weighted flips) is minimised
 * across the whole piece. This is a two-state Viterbi pass: greedy assignment fails badly
 * here, because the cheapest side for one note routinely strands the next ten.
 */
export function assignSides(pitches: Array<{ midi: number; start: number; end: number }>): Side[] {
  if (pitches.length === 0) return [];
  const SIDES: Side[] = ['C', 'G'];

  const localCost = (midi: number, side: Side): number =>
    sidesFor(midi).has(side) ? 0 : UNPLAYABLE_ON_SIDE;

  let prev: Record<Side, number> = {
    C: localCost(pitches[0]!.midi, 'C'),
    G: localCost(pitches[0]!.midi, 'G'),
  };
  const backpointers: Array<Record<Side, Side>> = [];

  for (let i = 1; i < pitches.length; i++) {
    const gap = pitches[i]!.start - pitches[i - 1]!.end;
    const cost = flipCost(gap);
    const next: Record<Side, number> = { C: Infinity, G: Infinity };
    const bp: Record<Side, Side> = { C: 'C', G: 'C' };
    for (const to of SIDES) {
      const base = localCost(pitches[i]!.midi, to);
      for (const from of SIDES) {
        const total = prev[from] + base + (from === to ? 0 : cost);
        if (total < next[to]) {
          next[to] = total;
          bp[to] = from;
        }
      }
    }
    prev = next;
    backpointers.push(bp);
  }

  const path: Side[] = new Array(pitches.length);
  path[pitches.length - 1] = prev.C <= prev.G ? 'C' : 'G';
  for (let i = pitches.length - 1; i > 0; i--) {
    path[i - 1] = backpointers[i - 1]![path[i]!]!;
  }
  return path;
}

/** Within a side a pitch can appear twice; prefer the hole closest to where the mouth already is. */
function pickHole(midi: number, side: Side, previousChannel: number | null): Hole | null {
  const options = holesForMidi(midi).filter((h) => h.side === side);
  if (options.length === 0) return null;
  if (options.length === 1 || previousChannel === null) return options[0]!;
  return options.reduce((best, h) =>
    Math.abs(h.channel - previousChannel) < Math.abs(best.channel - previousChannel) ? h : best);
}

// --- harmony layers ---------------------------------------------------------

/** The same pitch class one octave down, same side and same breath -- a tongue-block octave. */
function octavePartner(hole: Hole): Hole | null {
  return LAYOUT.find((h) =>
    h.side === hole.side && h.direction === hole.direction && h.midi === hole.midi - 12) ?? null;
}

/** The next hole down on the same breath, which on this tuning is always a chord tone. */
function chordToneBelow(hole: Hole, distance: number): Hole | null {
  return LAYOUT.find((h) =>
    h.side === hole.side && h.direction === hole.direction && h.channel === hole.channel - distance) ?? null;
}

function isStrongBeat(time: number, beats: number[] | undefined, tolerance = 0.09): boolean {
  if (!beats || beats.length === 0) return false;
  return beats.some((b) => Math.abs(b - time) <= tolerance);
}

/**
 * Thickens a melody line. The Echo Harp only really offers a C triad (blow, C side) and a
 * G triad (blow, G side), so blow notes take chords and draw notes mostly take octaves.
 * Only sustained or accented notes get thickened: doubling a fast passage is unplayable
 * and muddies the line.
 */
function addHarmony(notes: ArrangedNote[], difficulty: Difficulty, beats?: number[]): ArrangedNote[] {
  if (difficulty === 'easy') return notes;
  const minDuration = difficulty === 'medium' ? 0.35 : 0.22;

  return notes.map((note) => {
    const duration = note.end - note.start;
    const accented = duration >= minDuration || isStrongBeat(note.start, beats);
    if (!accented) return note;

    const melody = note.holes[0]!;
    const extra: Hole[] = [];

    const octave = octavePartner(melody);
    if (octave) extra.push(octave);

    if (melody.direction === 'blow') {
      const third = chordToneBelow(melody, 1);
      if (third && !extra.some((h) => h.channel === third.channel)) extra.push(third);
      if (difficulty === 'full') {
        const fifth = chordToneBelow(melody, 2);
        if (fifth && !extra.some((h) => h.channel === fifth.channel)) extra.push(fifth);
      }
    } else if (difficulty === 'full') {
      const neighbour = chordToneBelow(melody, 1);
      if (neighbour && !extra.some((h) => h.channel === neighbour.channel)) extra.push(neighbour);
    }

    return extra.length > 0 ? { ...note, holes: [melody, ...extra] } : note;
  });
}

// --- top level --------------------------------------------------------------

export interface ArrangeOptions {
  /** Force a transposition instead of searching for the best one. */
  forceSemitones?: number;
  /** Beat onsets in seconds, used to decide which notes get harmony. */
  beats?: number[];
}

export function arrange(source: NoteEvent[], options: ArrangeOptions = {}): ArrangeResult {
  const notes = [...source].sort((a, b) => a.start - b.start);
  const ranked = chooseTransposition(notes);
  const chosen = options.forceSemitones !== undefined
    ? scoreTransposition(notes, options.forceSemitones)
    : ranked[0]!;

  const keyPitchClasses = dominantPitchClasses(notes);

  // Transpose, then force every note onto a pitch the instrument can genuinely sound.
  const fitted = notes.map((n) => {
    const fit = fitToInstrument(n.midi + chosen.semitones, keyPitchClasses);
    return { start: n.start, end: n.end, midi: fit.midi, sourceMidi: n.midi, altered: fit.altered };
  });

  const sides = assignSides(fitted);

  const melody: ArrangedNote[] = [];
  let previousChannel: number | null = null;
  for (let i = 0; i < fitted.length; i++) {
    const f = fitted[i]!;
    // fitToInstrument guarantees this pitch exists somewhere, and the side solve prefers a
    // side that has it (being stranded costs far more than any flip). Should the preferred
    // side still not carry the note, take it on the other side rather than dropping it:
    // a wrong-looking side marker is recoverable, a missing note in the middle of a tune
    // you are learning is not.
    const hole: Hole | undefined =
      pickHole(f.midi, sides[i]!, previousChannel) ?? holesForMidi(f.midi)[0];
    if (!hole) continue; // only if the layout itself has no such pitch
    previousChannel = hole.channel;
    melody.push({
      start: f.start,
      end: f.end,
      midi: f.midi,
      sourceMidi: f.sourceMidi,
      side: hole.side,
      direction: hole.direction,
      holes: [hole],
      altered: f.altered,
    });
  }

  const countFlips = (ns: ArrangedNote[]): number =>
    ns.reduce((acc, n, i) => acc + (i > 0 && n.side !== ns[i - 1]!.side ? 1 : 0), 0);

  const build = (difficulty: Difficulty): Arrangement => {
    const withHarmony = addHarmony(melody, difficulty, options.beats);
    return { difficulty, notes: withHarmony, sideFlips: countFlips(withHarmony) };
  };

  return {
    chosen,
    alternatives: ranked.filter((o) => o.semitones !== chosen.semitones).slice(0, 3),
    layers: { easy: build('easy'), medium: build('medium'), full: build('full') },
  };
}
