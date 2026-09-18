import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMelody, quantise, repairOctaveErrors } from '../src/core/melody.ts';
import type { NoteEvent } from '../src/core/arrange.ts';
import { nameToMidi } from '../src/core/pitch.ts';

const n = (name: string, start: number, end: number, confidence = 0.9): NoteEvent => ({
  midi: nameToMidi(name), start, end, confidence,
});

test('a chord collapses to its top note', () => {
  // A C major triad held together: the melody is the G on top.
  const chord = [n('C4', 0, 1), n('E4', 0, 1), n('G4', 0, 1)];
  const line = extractMelody(chord);
  assert.equal(line.length, 1);
  assert.equal(line[0]!.midi, nameToMidi('G4'));
});

test('the result is strictly sequential with no overlaps', () => {
  const messy = [
    n('C4', 0, 2), n('E4', 0.5, 2.5), n('G4', 1.0, 3.0), n('B4', 1.2, 1.9),
  ];
  const line = extractMelody(messy);
  for (let i = 1; i < line.length; i++) {
    assert.ok(
      line[i]!.start >= line[i - 1]!.end - 1e-9,
      `note ${i} starts at ${line[i]!.start} before note ${i - 1} ends at ${line[i - 1]!.end}`,
    );
  }
});

test('transcription noise is discarded', () => {
  const withNoise = [
    n('C5', 0, 0.5),
    n('F#2', 0.1, 0.115, 0.95),  // too short to be real
    n('A5', 0.2, 0.6, 0.05),      // too uncertain to trust
    n('D5', 0.5, 1.0),
  ];
  const line = extractMelody(withNoise);
  const pitches = line.map((x) => x.midi);
  assert.ok(!pitches.includes(nameToMidi('F#2')), 'a 15ms note is not a melody note');
  assert.ok(!pitches.includes(nameToMidi('A5')), 'a 5%-confidence note is not a melody note');
});

test('continuity stops the line leaping an octave for one note and back', () => {
  // A stepwise line with a single loud high harmonic sitting over the middle note.
  const line = extractMelody([
    n('C5', 0.0, 0.4), n('D5', 0.4, 0.8),
    n('E5', 0.8, 1.2), n('E6', 0.8, 1.2, 0.55),
    n('F5', 1.2, 1.6), n('G5', 1.6, 2.0),
  ]);
  const pitches = line.map((x) => x.midi);
  assert.ok(!pitches.includes(nameToMidi('E6')), `melody jumped to the harmonic: ${pitches}`);
});

test('a repeated pitch split by a hairline gap is rejoined', () => {
  const line = extractMelody([n('C5', 0, 0.5), n('C5', 0.52, 1.0)]);
  assert.equal(line.length, 1);
  assert.equal(line[0]!.start, 0);
  assert.equal(line[0]!.end, 1.0);
});

test('a genuinely rearticulated pitch is kept as two notes', () => {
  const line = extractMelody([n('C5', 0, 0.5), n('C5', 0.9, 1.4)]);
  assert.equal(line.length, 2);
});

test('quantisation snaps near misses and leaves genuine syncopation alone', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0];        // 120bpm, so sixteenths every 0.125s
  const notes = [
    n('C5', 0.012, 0.49),   // 12ms late: a timing error, should snap to 0
    n('D5', 0.56, 0.99),    // 60ms past the beat: further than tolerance, leave it
  ];
  const q = quantise(notes, beats);
  assert.equal(q[0]!.start, 0);
  assert.equal(q[1]!.start, 0.56);
});

test('quantisation never produces a zero-length or inverted note', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0];
  const q = quantise([n('C5', 0.01, 0.02)], beats);
  assert.ok(q[0]!.end > q[0]!.start, 'note must keep positive duration');
});

test('empty and single-note inputs are handled', () => {
  assert.deepEqual(extractMelody([]), []);
  assert.equal(extractMelody([n('C5', 0, 1)]).length, 1);
  assert.deepEqual(quantise([], []), []);
});

test('a single note flung an octave out is pulled back', () => {
  // The classic transcriber failure: one note reported as its second harmonic.
  const line = extractMelody([
    n('C5', 0.0, 0.4), n('D5', 0.4, 0.8), n('E5', 0.8, 1.2),
    n('F6', 1.2, 1.6),                    // should be F5
    n('G5', 1.6, 2.0), n('A5', 2.0, 2.4),
  ]);
  const octaveOut = line.find((x) => x.midi === nameToMidi('F6'));
  assert.equal(octaveOut, undefined, `F6 should have been corrected: ${line.map((x) => x.midi)}`);
  assert.ok(line.some((x) => x.midi === nameToMidi('F5')), 'it should land on F5');
});

test('a genuine sustained register change is left alone', () => {
  // The melody really does go up an octave and stay there. Nothing here is an error.
  const line = extractMelody([
    n('C4', 0.0, 0.4), n('D4', 0.4, 0.8), n('E4', 0.8, 1.2), n('F4', 1.2, 1.6),
    n('C5', 1.6, 2.0), n('D5', 2.0, 2.4), n('E5', 2.4, 2.8), n('F5', 2.8, 3.2),
  ]);
  const pitches = line.map((x) => x.midi);
  assert.ok(pitches.includes(nameToMidi('C5')), 'the upper register must survive');
  assert.ok(pitches.includes(nameToMidi('C4')), 'the lower register must survive');
  assert.equal(Math.max(...pitches) - Math.min(...pitches), 17, 'the full span should be preserved');
});

test('repairOctaveErrors leaves short inputs untouched', () => {
  const two = [n('C4', 0, 0.5), n('C6', 0.5, 1)];
  assert.deepEqual(repairOctaveErrors(two), two);
});

test('a repeated note played on the beat survives, however small the gap', () => {
  // Basic Pitch sustains each note up to the next onset, so the opening "C C" of a tune
  // arrives as two notes a few milliseconds apart. Rhythm is what marks it as deliberate.
  const beats = [0, 0.5, 1.0, 1.5, 2.0];
  const line = extractMelody([n('C5', 0, 0.48), n('C5', 0.5, 0.98)], { beats });
  assert.equal(line.length, 2, 'the repeat is on the beat and must be kept');
});

test('a note torn in half off the beat is still rejoined', () => {
  const beats = [0, 0.5, 1.0, 1.5, 2.0];
  const line = extractMelody([n('C5', 0, 0.31), n('C5', 0.33, 0.95)], { beats });
  assert.equal(line.length, 1, 'the split is nowhere near a beat, so it is an artefact');
});
