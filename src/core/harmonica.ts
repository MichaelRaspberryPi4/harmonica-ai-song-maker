/**
 * Note layout for the Hohner Echo Harp 56/96 (double-sided C/G tremolo, Wiener tuning).
 *
 * Source: HOHNER DATASHEET "ECHO WENDER TREMOLO 2 X 48", model M5696357 (C/G).
 * The datasheet gives 12 numbered channels per side. `CHANNELS_PER_SIDE` below is the
 * one knob to turn if your instrument is physically larger -- everything else derives
 * from the tuning cycles, so no other code needs to change.
 *
 * Wiener tuning is regular from channel 3 upward: blow walks a root/3rd/5th cycle and
 * draw walks a 2nd/4th/6th/7th cycle. Only the bottom two channels deviate, where Hohner
 * substitutes more useful low chord tones for the awkward ones. Those three deviations
 * are listed explicitly in LOW_OCTAVE_EXCEPTIONS and are covered by test/harmonica.test.ts,
 * which asserts the generated table against the datasheet note for note.
 */

import { SEMITONE, nameToMidi, pitchClass } from './pitch.ts';

export type Side = 'C' | 'G';
export type Direction = 'blow' | 'draw';

/** Playing positions per side. Datasheet says 12; see the module comment. */
export const CHANNELS_PER_SIDE = 12;

export interface Hole {
  side: Side;
  /** 1-based, as printed on the cover plate. */
  channel: number;
  direction: Direction;
  midi: number;
}

interface SideSpec {
  tonic: string;
  /** Scale degrees sounded by blowing, as letters, in ascending cycle order. */
  blowCycle: string[];
  /** Scale degrees sounded by drawing. */
  drawCycle: string[];
  /** A known (channel, direction) -> note pair used to lock the cycle's phase and octave. */
  blowAnchor: { channel: number; note: string };
  drawAnchor: { channel: number; note: string };
}

const SIDE_SPECS: Record<Side, SideSpec> = {
  C: {
    tonic: 'C',
    blowCycle: ['C', 'E', 'G'],
    drawCycle: ['D', 'F', 'A', 'B'],
    blowAnchor: { channel: 3, note: 'C4' },
    drawAnchor: { channel: 3, note: 'D4' },
  },
  G: {
    tonic: 'G',
    blowCycle: ['G', 'B', 'D'],
    drawCycle: ['A', 'C', 'E', 'F#'],
    blowAnchor: { channel: 1, note: 'G3' },
    drawAnchor: { channel: 4, note: 'A4' },
  },
};

/** Hohner's deliberate substitutions in the incomplete bottom octave. */
const LOW_OCTAVE_EXCEPTIONS: Array<{ side: Side; channel: number; direction: Direction; note: string }> = [
  { side: 'C', channel: 1, direction: 'draw', note: 'G3' },
  { side: 'G', channel: 1, direction: 'draw', note: 'A3' },
  { side: 'G', channel: 2, direction: 'draw', note: 'D4' },
];

/**
 * Converts a degree cycle into strictly ascending semitone offsets. The cycle is written
 * in ascending pitch order (G, B, D), so whenever a letter's pitch class does not exceed
 * its predecessor's the cycle has crossed an octave and must carry 12. Without this, the
 * D of the G side's blow cycle reads as a pitch class below G and lands an octave low.
 */
function ascendingOffsets(cycle: string[]): number[] {
  const offsets: number[] = [];
  let carry = 0;
  let previous = -Infinity;
  for (const deg of cycle) {
    let s = SEMITONE[deg[0]!]!;
    for (const a of deg.slice(1)) s += a === '#' ? 1 : -1;
    if (s <= previous) carry += 12;
    previous = s;
    offsets.push(s + carry);
  }
  return offsets;
}

/**
 * Walks a degree cycle out from its anchor. The cycle repeats every `cycle.length`
 * channels and rises one octave each time it wraps -- including downward, for channels
 * below the anchor. That regularity is what makes Wiener tuning generable rather than
 * something we have to transcribe by hand.
 */
function noteAt(cycle: string[], anchor: { channel: number; note: string }, channel: number): number {
  const offsets = ascendingOffsets(cycle);
  const len = cycle.length;
  const steps = channel - anchor.channel;
  const idx = ((steps % len) + len) % len;
  const octaveShift = Math.floor(steps / len);
  return nameToMidi(anchor.note) + (offsets[idx]! - offsets[0]!) + 12 * octaveShift;
}

function buildSide(side: Side, channels: number): Hole[] {
  const spec = SIDE_SPECS[side];
  const holes: Hole[] = [];
  for (let channel = 1; channel <= channels; channel++) {
    holes.push({ side, channel, direction: 'blow', midi: noteAt(spec.blowCycle, spec.blowAnchor, channel) });
    holes.push({ side, channel, direction: 'draw', midi: noteAt(spec.drawCycle, spec.drawAnchor, channel) });
  }
  for (const ex of LOW_OCTAVE_EXCEPTIONS) {
    if (ex.side !== side || ex.channel > channels) continue;
    const hole = holes.find((h) => h.channel === ex.channel && h.direction === ex.direction);
    if (hole) hole.midi = nameToMidi(ex.note);
  }
  return holes;
}

export function buildLayout(channelsPerSide: number = CHANNELS_PER_SIDE): Hole[] {
  return [...buildSide('C', channelsPerSide), ...buildSide('G', channelsPerSide)];
}

export const LAYOUT: Hole[] = buildLayout();

/** Every MIDI note the instrument can produce, across both sides. */
export const PLAYABLE_MIDI: ReadonlySet<number> = new Set(LAYOUT.map((h) => h.midi));

/** The eight pitch classes that exist anywhere on the harp: C D E F F# G A B. */
export const PLAYABLE_PITCH_CLASSES: ReadonlySet<number> = new Set(LAYOUT.map((h) => pitchClass(h.midi)));

export const LOWEST_MIDI: number = Math.min(...LAYOUT.map((h) => h.midi));
export const HIGHEST_MIDI: number = Math.max(...LAYOUT.map((h) => h.midi));

/** All the ways to play a given pitch. Empty if the harp cannot produce it at all. */
export function holesForMidi(midi: number, layout: Hole[] = LAYOUT): Hole[] {
  return layout.filter((h) => h.midi === midi);
}

export function holesOnSide(side: Side, layout: Hole[] = LAYOUT): Hole[] {
  return layout.filter((h) => h.side === side);
}
