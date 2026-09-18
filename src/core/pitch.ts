/** Pitch helpers. Everything internally is a MIDI note number; C4 = 60. */

export const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Semitone offsets from the tonic, by letter, for building scale-degree cycles. */
export const SEMITONE: Readonly<Record<string, number>> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

export function midiToName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  return `${SHARP_NAMES[pc]}${octave}`;
}

/** Parses "C4", "F#5", "Bb3". Returns a MIDI number. */
export function nameToMidi(name: string): number {
  const m = /^([A-Ga-g])([#b]*)(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error(`Unparseable note name: ${name}`);
  const [, letter, accidentals, octave] = m as unknown as [string, string, string, string];
  const base = SEMITONE[letter.toUpperCase()];
  if (base === undefined) throw new Error(`Unparseable note name: ${name}`);
  let semis = base;
  for (const a of accidentals) semis += a === '#' ? 1 : -1;
  return (Number(octave) + 1) * 12 + semis;
}

export function pitchClass(midi: number): number {
  return ((midi % 12) + 12) % 12;
}

/** Distance in semitones to the nearest note with the given pitch class (signed, smallest magnitude). */
export function distanceToPitchClass(midi: number, pc: number): number {
  const diff = ((pc - pitchClass(midi)) % 12 + 12) % 12;
  return diff <= 6 ? diff : diff - 12;
}
