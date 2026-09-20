/**
 * Note layout for the Hohner Echo Harp 56/96 (double-sided C/G tremolo, Wiener tuning).
 *
 * Source: HOHNER DATASHEET "ECHO WENDER TREMOLO 2 X 48", model M5696357 (C/G).
 *
 * The single most important thing about this instrument, and the thing the datasheet
 * communicates only through the layout of its table: **blow and draw are separate holes.**
 * The Blow and Draw rows are drawn offset from one another because they genuinely sit at
 * different places along the comb. A "channel" is a pair of adjacent hole positions -- one
 * you blow, one you draw -- not a single opening you do both into.
 *
 * The arithmetic confirms it. 12 channels x 2 breath positions x 2 rows (the tremolo pair,
 * two reeds a few cents apart) = 48 holes per side, 96 across the instrument, which is
 * where 56/96 and "2 x 48" come from. Were blow and draw to share a chamber there would be
 * only 24 holes a side.
 *
 * So the number a player needs is the **hole position**, 1-24 along the side, not the
 * channel. Reading the C side left to right: E3 blow, G3 draw, G3 blow, B3 draw, C4 blow,
 * D4 draw... Middle C is the fifth hole, not the third. Getting this wrong makes every
 * number in a tab wrong, which is exactly what it did.
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

/** Channels per side. Each channel occupies two hole positions: one blow, one draw. */
export const CHANNELS_PER_SIDE = 12;

/** Physical hole positions along one side: two per channel. */
export const POSITIONS_PER_SIDE = CHANNELS_PER_SIDE * 2;

export interface Hole {
  side: Side;
  /** Channel number, 1-12, as the Hohner datasheet labels it ("Kanal"). */
  channel: number;
  /**
   * Physical hole position along the side, 1-24, counting every opening left to right.
   * This is what the player actually puts their mouth on, and what a tab must show.
   */
  position: number;
  direction: Direction;
  midi: number;
}

/**
 * Blow sits on the left of its channel, draw on the right, so positions interleave:
 * channel 1 is positions 1 (blow) and 2 (draw), channel 2 is 3 and 4, and so on.
 */
export function holePosition(channel: number, direction: Direction): number {
  return direction === 'blow' ? channel * 2 - 1 : channel * 2;
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
    holes.push({
      side, channel, direction: 'blow',
      position: holePosition(channel, 'blow'),
      midi: noteAt(spec.blowCycle, spec.blowAnchor, channel),
    });
    holes.push({
      side, channel, direction: 'draw',
      position: holePosition(channel, 'draw'),
      midi: noteAt(spec.drawCycle, spec.drawAnchor, channel),
    });
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

/**
 * The pitches one side alone can sound.
 *
 * Each side is a single major scale -- C side C major, G side G major -- so locking to one
 * costs you a pitch class: the C side has no F#, the G side no F natural. That is exactly
 * the trade for never having to turn the harp over.
 */
export function playableMidiForSide(side: Side, layout: Hole[] = LAYOUT): Set<number> {
  return new Set(layout.filter((h) => h.side === side).map((h) => h.midi));
}

export function playablePitchClassesForSide(side: Side, layout: Hole[] = LAYOUT): Set<number> {
  return new Set([...playableMidiForSide(side, layout)].map(pitchClass));
}

/** One side's holes in the order they physically appear, left to right. */
export function holesInPositionOrder(side: Side, layout: Hole[] = LAYOUT): Hole[] {
  return holesOnSide(side, layout).sort((a, b) => a.position - b.position);
}
