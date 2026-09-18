import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrange, assignSides, chooseTransposition, foldIntoRange, substitute,
  type NoteEvent, type ArrangedNote,
} from '../src/core/arrange.ts';
import { PLAYABLE_PITCH_CLASSES, PLAYABLE_MIDI, LOWEST_MIDI, HIGHEST_MIDI } from '../src/core/harmonica.ts';
import { nameToMidi, pitchClass } from '../src/core/pitch.ts';

/** Builds a melody from note names at a steady eighth-note pace. */
function melody(names: string[], step = 0.5, sustain = 0.45): NoteEvent[] {
  return names.map((name, i) => ({
    midi: nameToMidi(name),
    start: i * step,
    end: i * step + sustain,
  }));
}

test('an in-scale melody is left in its original key', () => {
  const happyBirthday = melody(['C4', 'C4', 'D4', 'C4', 'F4', 'E4', 'C4', 'C4', 'D4', 'C4', 'G4', 'F4']);
  const result = arrange(happyBirthday);
  assert.equal(result.chosen.semitones, 0);
  assert.equal(result.chosen.outOfScale, 0);
  assert.ok(result.chosen.score > 95, `expected a high score, got ${result.chosen.score}`);
});

test('a melody in an unplayable key is transposed until it fits', () => {
  // Eb major: Eb, Bb and Ab do not exist anywhere on the instrument.
  const inEb = melody(['Eb4', 'F4', 'G4', 'Ab4', 'Bb4', 'C5', 'D5', 'Eb5']);
  const before = chooseTransposition(inEb).find((o) => o.semitones === 0)!;
  assert.ok(before.outOfScale > 0, 'the untransposed melody should be unplayable');

  const result = arrange(inEb);
  assert.equal(result.chosen.outOfScale, 0, 'the chosen transposition should need no substitutions');
  assert.notEqual(result.chosen.semitones, 0);
});

test('side assignment keeps a phrase on one side rather than flipping around an ambiguous note', () => {
  // C5 exists on both sides. A greedy note-by-note choice can flip out and back for it;
  // the whole-phrase solve should not.
  const phrase = melody(['F#4', 'C5', 'F#4', 'C5', 'F#4']);
  const sides = assignSides(phrase.map((n) => ({ midi: n.midi, start: n.start, end: n.end })));
  assert.deepEqual(sides, ['G', 'G', 'G', 'G', 'G']);
});

test('a genuine F-natural to F-sharp move does flip, exactly once', () => {
  // F natural exists only on the C side, F# only on the G side. There is no way around this.
  const forced = melody(['F4', 'F4', 'F#4', 'F#4']);
  const sides = assignSides(forced.map((n) => ({ midi: n.midi, start: n.start, end: n.end })));
  assert.deepEqual(sides, ['C', 'C', 'G', 'G']);
});

test('notes outside E3-D7 are folded into range by whole octaves', () => {
  const tooLow = foldIntoRange(nameToMidi('C2'));
  assert.ok(tooLow.shifted);
  assert.ok(tooLow.midi >= LOWEST_MIDI && tooLow.midi <= HIGHEST_MIDI);
  assert.equal(pitchClass(tooLow.midi), pitchClass(nameToMidi('C2')), 'folding must preserve pitch class');

  const tooHigh = foldIntoRange(nameToMidi('A8'));
  assert.ok(tooHigh.shifted);
  assert.ok(tooHigh.midi >= LOWEST_MIDI && tooHigh.midi <= HIGHEST_MIDI);

  assert.equal(foldIntoRange(nameToMidi('C5')).shifted, false);
});

test('unplayable pitches are substituted rather than dropped', () => {
  const cSharp = nameToMidi('C#5');
  const replaced = substitute(cSharp, new Set([0, 2, 4, 5, 7, 9, 11]));
  assert.notEqual(replaced, cSharp);
  assert.ok(PLAYABLE_PITCH_CLASSES.has(pitchClass(replaced)));
  assert.ok(Math.abs(replaced - cSharp) <= 2, 'substitution should stay close to the original pitch');
});

test('every arranged note is physically playable as written', () => {
  const chromatic = Array.from({ length: 40 }, (_, i) => ({
    midi: 50 + i,
    start: i * 0.3,
    end: i * 0.3 + 0.28,
  }));
  const result = arrange(chromatic);

  for (const layer of Object.values(result.layers)) {
    for (const note of layer.notes) {
      const lead = note.holes[0]!;
      assert.equal(lead.midi, note.midi, 'the lead hole must sound the stated pitch');
      assert.equal(lead.side, note.side);
      assert.equal(lead.direction, note.direction);
      // You cannot blow and draw at once, nor play both sides at once.
      for (const h of note.holes) {
        assert.equal(h.side, note.side, 'all holes in a chord must be on one side');
        assert.equal(h.direction, note.direction, 'all holes in a chord must share a breath direction');
      }
      const channels = note.holes.map((h) => h.channel);
      assert.equal(new Set(channels).size, channels.length, 'a chord must not repeat a channel');
    }
  }
});

test('difficulty layers add harmony without changing the melody or its timing', () => {
  const tune = melody(['C4', 'E4', 'G4', 'C5', 'G4', 'E4'], 0.6, 0.55);
  const { layers } = arrange(tune);

  for (const note of layers.easy.notes) {
    assert.equal(note.holes.length, 1, 'easy is strictly single-note');
  }

  const holeCount = (notes: ArrangedNote[]) => notes.reduce((a, n) => a + n.holes.length, 0);
  assert.ok(holeCount(layers.medium.notes) > holeCount(layers.easy.notes), 'medium should thicken the line');
  assert.ok(holeCount(layers.full.notes) >= holeCount(layers.medium.notes), 'full should be at least as thick');

  // The tune itself must be identical across layers.
  for (const level of ['medium', 'full'] as const) {
    assert.equal(layers[level].notes.length, layers.easy.notes.length);
    layers[level].notes.forEach((note, i) => {
      const easy = layers.easy.notes[i]!;
      assert.equal(note.midi, easy.midi);
      assert.equal(note.start, easy.start);
      assert.equal(note.end, easy.end);
      assert.equal(note.holes[0]!.channel, easy.holes[0]!.channel);
    });
  }
});

test('fast passages are not thickened into something unplayable', () => {
  const run = melody(['C5', 'D5', 'E5', 'F5', 'G5', 'A5', 'B5', 'C6'], 0.08, 0.07);
  const { layers } = arrange(run);
  for (const note of layers.medium.notes) {
    assert.equal(note.holes.length, 1, 'sixteenth-note runs should stay single-note at medium');
  }
});

test('alternatives are offered and never duplicate the chosen transposition', () => {
  const result = arrange(melody(['C#4', 'D#4', 'F4', 'G#4', 'A#4']));
  assert.ok(result.alternatives.length > 0);
  for (const alt of result.alternatives) {
    assert.notEqual(alt.semitones, result.chosen.semitones);
    assert.ok(alt.score <= result.chosen.score);
  }
});

test('an empty input does not blow up', () => {
  const result = arrange([]);
  assert.equal(result.layers.easy.notes.length, 0);
  assert.equal(result.layers.easy.sideFlips, 0);
});

test('no note is ever silently dropped, across the full chromatic range', () => {
  // Every semitone from well below the harp to well above it, including the F3/F#3
  // gap that sits inside the range but corresponds to no hole.
  const sweep = Array.from({ length: 72 }, (_, i) => ({
    midi: 36 + i,
    start: i * 0.4,
    end: i * 0.4 + 0.38,
  }));
  const result = arrange(sweep);
  for (const [level, layer] of Object.entries(result.layers)) {
    assert.equal(layer.notes.length, sweep.length, `${level} lost notes`);
  }
});

test('every arranged pitch corresponds to a hole that exists', () => {
  const sweep = Array.from({ length: 72 }, (_, i) => ({
    midi: 36 + i, start: i * 0.4, end: i * 0.4 + 0.38,
  }));
  for (const note of arrange(sweep).layers.full.notes) {
    for (const hole of note.holes) {
      assert.ok(PLAYABLE_MIDI.has(hole.midi), `${hole.midi} is not on the instrument`);
    }
    assert.ok(PLAYABLE_MIDI.has(note.midi), `${note.midi} is not on the instrument`);
  }
});

test('the F3/F#3 gap is bridged rather than dropped', () => {
  // Both sit inside E3-D7 and both are otherwise valid pitch classes, yet neither side
  // has a hole for them. A plain range check calls them playable and loses them.
  for (const name of ['F3', 'F#3']) {
    const midi = nameToMidi(name);
    assert.ok(!PLAYABLE_MIDI.has(midi), `${name} should genuinely be missing from the layout`);

    const result = arrange([{ midi, start: 0, end: 0.5 }], { forceSemitones: 0 });
    const notes = result.layers.easy.notes;
    assert.equal(notes.length, 1, `${name} was dropped`);
    assert.ok(PLAYABLE_MIDI.has(notes[0]!.midi), `${name} was mapped to another missing pitch`);
    assert.equal(pitchClass(notes[0]!.midi), pitchClass(midi), `${name} should keep its letter`);
    assert.equal(notes[0]!.altered, 'octave');
  }
});

test('a pitch the harp lacks entirely is swapped, keeping it close', () => {
  const midi = nameToMidi('D#5');
  const notes = arrange([{ midi, start: 0, end: 0.5 }], { forceSemitones: 0 }).layers.easy.notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0]!.altered, 'substituted');
  assert.ok(PLAYABLE_MIDI.has(notes[0]!.midi));
  assert.ok(Math.abs(notes[0]!.midi - midi) <= 2);
});

test('notes far outside the range are brought in, keeping their letter where possible', () => {
  for (const name of ['C1', 'G8']) {
    const midi = nameToMidi(name);
    const notes = arrange([{ midi, start: 0, end: 0.5 }], { forceSemitones: 0 }).layers.easy.notes;
    assert.equal(notes.length, 1, `${name} was dropped`);
    assert.ok(PLAYABLE_MIDI.has(notes[0]!.midi));
    assert.equal(pitchClass(notes[0]!.midi), pitchClass(midi), `${name} should keep its letter`);
  }
});
