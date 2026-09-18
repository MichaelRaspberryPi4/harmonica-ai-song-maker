import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, PLAYABLE_PITCH_CLASSES, LOWEST_MIDI, HIGHEST_MIDI } from '../src/core/harmonica.ts';
import { midiToName, nameToMidi } from '../src/core/pitch.ts';

/**
 * Transcribed directly from HOHNER DATASHEET "ECHO WENDER TREMOLO 2 X 48",
 * model M5696357, Keys of C/G. Index 0 == channel 1.
 */
const DATASHEET = {
  C: {
    blow: ['E3', 'G3', 'C4', 'E4', 'G4', 'C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C7'],
    draw: ['G3', 'B3', 'D4', 'F4', 'A4', 'B4', 'D5', 'F5', 'A5', 'B5', 'D6', 'F6'],
  },
  G: {
    blow: ['G3', 'B3', 'D4', 'G4', 'B4', 'D5', 'G5', 'B5', 'D6', 'G6', 'B6', 'D7'],
    draw: ['A3', 'D4', 'F#4', 'A4', 'C5', 'E5', 'F#5', 'A5', 'C6', 'E6', 'F#6', 'A6'],
  },
} as const;

test('generated layout matches the Hohner datasheet note for note', () => {
  const layout = buildLayout(12);
  for (const side of ['C', 'G'] as const) {
    for (const direction of ['blow', 'draw'] as const) {
      const expected = DATASHEET[side][direction];
      for (let ch = 1; ch <= 12; ch++) {
        const hole = layout.find((h) => h.side === side && h.channel === ch && h.direction === direction);
        assert.ok(hole, `missing ${side} side channel ${ch} ${direction}`);
        assert.equal(
          midiToName(hole.midi),
          expected[ch - 1],
          `${side} side channel ${ch} ${direction}`,
        );
      }
    }
  }
});

test('the harp offers exactly eight pitch classes: C D E F F# G A B', () => {
  const names = [...PLAYABLE_PITCH_CLASSES].sort((a, b) => a - b).map((pc) => midiToName(60 + pc).replace('4', '').replace('5', ''));
  assert.deepEqual(names, ['C', 'D', 'E', 'F', 'F#', 'G', 'A', 'B']);
});

test('C#, D#, G# and A# exist nowhere on the instrument', () => {
  for (const absent of [1, 3, 8, 10]) {
    assert.ok(!PLAYABLE_PITCH_CLASSES.has(absent), `pitch class ${absent} should be unplayable`);
  }
});

test('range runs E3 to D7', () => {
  assert.equal(LOWEST_MIDI, nameToMidi('E3'));
  assert.equal(HIGHEST_MIDI, nameToMidi('D7'));
});

test('layout scales to a larger instrument without losing the datasheet channels', () => {
  const big = buildLayout(24);
  assert.equal(big.length, 24 * 2 * 2);
  for (let ch = 1; ch <= 12; ch++) {
    const hole = big.find((h) => h.side === 'C' && h.channel === ch && h.direction === 'blow');
    assert.equal(midiToName(hole!.midi), DATASHEET.C.blow[ch - 1]);
  }
});
