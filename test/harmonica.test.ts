import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLayout, PLAYABLE_PITCH_CLASSES, LOWEST_MIDI, HIGHEST_MIDI,
  holesInPositionOrder, holesForMidi, POSITIONS_PER_SIDE,
} from '../src/core/harmonica.ts';
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

/**
 * The C side read straight off the datasheet in physical order, left to right, taking the
 * Blow and Draw rows as the offset columns they are drawn as. Position 1 is the leftmost
 * hole. Note positions 2 and 3: draw G3 then blow G3, the same pitch in adjacent holes.
 */
const C_SIDE_IN_ORDER = [
  'E3↑', 'G3↓', 'G3↑', 'B3↓', 'C4↑', 'D4↓', 'E4↑', 'F4↓',
  'G4↑', 'A4↓', 'C5↑', 'B4↓', 'E5↑', 'D5↓', 'G5↑', 'F5↓',
  'C6↑', 'A5↓', 'E6↑', 'B5↓', 'G6↑', 'D6↓', 'C7↑', 'F6↓',
];

const G_SIDE_IN_ORDER = [
  'G3↑', 'A3↓', 'B3↑', 'D4↓', 'D4↑', 'F#4↓', 'G4↑', 'A4↓',
  'B4↑', 'C5↓', 'D5↑', 'E5↓', 'G5↑', 'F#5↓', 'B5↑', 'A5↓',
  'D6↑', 'C6↓', 'G6↑', 'E6↓', 'B6↑', 'F#6↓', 'D7↑', 'A6↓',
];

test('the physical hole order matches the datasheet read left to right', () => {
  for (const [side, expected] of [['C', C_SIDE_IN_ORDER], ['G', G_SIDE_IN_ORDER]] as const) {
    const actual = holesInPositionOrder(side).map(
      (h) => `${midiToName(h.midi)}${h.direction === 'blow' ? '↑' : '↓'}`,
    );
    assert.deepEqual(actual, [...expected], `${side} side hole order`);
  }
});

test('positions run 1-24 with blow on odd holes and draw on even', () => {
  for (const side of ['C', 'G'] as const) {
    const holes = holesInPositionOrder(side);
    assert.equal(holes.length, POSITIONS_PER_SIDE);
    holes.forEach((h, i) => {
      assert.equal(h.position, i + 1, 'positions must be contiguous from 1');
      assert.equal(h.direction, h.position % 2 === 1 ? 'blow' : 'draw');
      assert.equal(h.channel, Math.ceil(h.position / 2), 'two positions per channel');
    });
  }
});

test('middle C is the fifth hole of the C side, not the third', () => {
  // The bug this whole model exists to prevent: channel 3 is hole position 5.
  const middleC = holesForMidi(nameToMidi('C4')).find((h) => h.side === 'C' && h.direction === 'blow');
  assert.ok(middleC);
  assert.equal(middleC.channel, 3);
  assert.equal(middleC.position, 5);
});

test('the same pitch really does appear in two adjacent holes', () => {
  // Position 2 draws G3 and position 3 blows G3. The player needs to know these differ.
  const order = holesInPositionOrder('C');
  const second = order[1]!;
  const third = order[2]!;
  assert.equal(second.midi, third.midi, 'positions 2 and 3 are the same pitch');
  assert.notEqual(second.direction, third.direction, 'but reached with opposite breath');
});
