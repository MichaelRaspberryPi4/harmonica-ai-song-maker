import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyProject, addNote, removeNote, noteAt, clearRange, transposeNotes,
  beatsForTempo, barCount, stepSeconds, editorRows, serialize, deserialize,
} from '../src/core/project.ts';
import { PLAYABLE_MIDI } from '../src/core/harmonica.ts';
import { nameToMidi } from '../src/core/pitch.ts';

const C4 = nameToMidi('C4');
const D4 = nameToMidi('D4');

test('a new project is empty and playable', () => {
  const p = emptyProject();
  assert.equal(p.notes.length, 0);
  assert.equal(p.origin, 'composed');
  assert.ok(p.bpm > 0);
});

test('editor rows cover every pitch the harp can sound, highest first', () => {
  const rows = editorRows();
  assert.equal(rows.length, PLAYABLE_MIDI.size);
  for (const midi of rows) assert.ok(PLAYABLE_MIDI.has(midi));
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i]! < rows[i - 1]!, 'must descend');
});

test('adding and removing a note', () => {
  let notes = addNote([], C4, 0, 0.5);
  assert.equal(notes.length, 1);
  assert.ok(noteAt(notes, C4, 0.25));
  assert.equal(noteAt(notes, C4, 0.75), undefined, 'outside the note');
  assert.equal(noteAt(notes, D4, 0.25), undefined, 'different pitch');

  notes = removeNote(notes, C4, 0.25);
  assert.equal(notes.length, 0);
});

test('removing where there is no note changes nothing', () => {
  const notes = addNote([], C4, 0, 0.5);
  assert.equal(removeNote(notes, C4, 2).length, 1);
  assert.equal(removeNote(notes, D4, 0.25).length, 1);
});

test('a note dropped on top of another trims it instead of overlapping', () => {
  // Two notes of one pitch sounding at once is meaningless on a harmonica.
  let notes = addNote([], C4, 0, 1.0);
  notes = addNote(notes, C4, 0.5, 1.0);

  const atPitch = notes.filter((n) => n.midi === C4).sort((a, b) => a.start - b.start);
  assert.equal(atPitch.length, 2);
  assert.ok(Math.abs(atPitch[0]!.end - 0.5) < 1e-6, 'the first note is trimmed to the new onset');
  assert.ok(atPitch[0]!.end <= atPitch[1]!.start + 1e-6, 'and they no longer overlap');
});

test('a note dropped inside a longer one splits it', () => {
  let notes = addNote([], C4, 0, 2.0);
  notes = addNote(notes, C4, 0.5, 0.5);
  const atPitch = notes.filter((n) => n.midi === C4).sort((a, b) => a.start - b.start);
  assert.equal(atPitch.length, 3, 'head, new note, tail');
  assert.ok(Math.abs(atPitch[0]!.end - 0.5) < 1e-6);
  assert.ok(Math.abs(atPitch[2]!.start - 1.0) < 1e-6);
});

test('notes at different pitches never interfere', () => {
  let notes = addNote([], C4, 0, 1);
  notes = addNote(notes, D4, 0, 1);
  assert.equal(notes.length, 2);
  assert.ok(noteAt(notes, C4, 0.5));
  assert.ok(noteAt(notes, D4, 0.5));
});

test('clearing a range removes only what lies inside it', () => {
  let notes = addNote([], C4, 0, 0.5);
  notes = addNote(notes, D4, 1.0, 0.5);
  notes = addNote(notes, C4, 2.0, 0.5);
  const kept = clearRange(notes, 0.9, 1.6);
  assert.equal(kept.length, 2);
  assert.ok(!kept.some((n) => n.midi === D4));
});

test('transposing shifts every note equally', () => {
  const notes = transposeNotes(addNote(addNote([], C4, 0, 1), D4, 1, 1), 2);
  assert.deepEqual(notes.map((n) => n.midi), [C4 + 2, D4 + 2]);
});

test('tempo grid and step length', () => {
  const beats = beatsForTempo(120, 2, 4);
  assert.equal(beats.length, 8);
  assert.equal(beats[0], 0);
  assert.ok(Math.abs(beats[1]! - 0.5) < 1e-6);
  assert.ok(Math.abs(stepSeconds(120, 4) - 0.125) < 1e-9, 'sixteenths at 120bpm');
});

test('the grid grows to hold the music, with a spare bar', () => {
  const p = emptyProject();
  p.bpm = 120;                       // a bar is 2 seconds
  assert.equal(barCount(p), 8, 'a minimum of eight bars to write into');
  p.notes = addNote([], C4, 0, 21);  // 10.5 bars of music
  assert.ok(barCount(p) >= 12, `should grow past the music, got ${barCount(p)}`);
});

test('a project survives a save and load round trip', () => {
  const original = emptyProject('My tune');
  original.bpm = 132;
  original.forceSemitones = -2;
  original.notes = addNote(addNote([], C4, 0, 0.5), D4, 0.5, 0.25);

  const restored = deserialize(serialize(original));
  assert.ok(restored);
  assert.equal(restored.name, 'My tune');
  assert.equal(restored.bpm, 132);
  assert.equal(restored.forceSemitones, -2);
  assert.deepEqual(
    restored.notes.map((n) => [n.midi, n.start, n.end]),
    original.notes.map((n) => [n.midi, n.start, n.end]),
  );
});

test('corrupt or hostile saved data is rejected without throwing', () => {
  assert.equal(deserialize('not json'), null);
  assert.equal(deserialize('{}'), null);
  assert.equal(deserialize('{"project":{}}'), null);
  assert.equal(deserialize('null'), null);
});

test('individually broken notes are dropped, not the whole file', () => {
  const restored = deserialize(JSON.stringify({
    version: 1,
    project: {
      name: 'Partly broken', bpm: 90, beatsPerBar: 4, origin: 'composed',
      notes: [
        { midi: 60, start: 0, end: 0.5 },
        { midi: NaN, start: 0, end: 1 },       // unusable
        { midi: 62, start: 1, end: 0.5 },      // ends before it starts
        { midi: 64, start: 2, end: 2.5 },
      ],
    },
  }));
  assert.ok(restored);
  assert.deepEqual(restored.notes.map((n) => n.midi), [60, 64]);
});

test('an absurd tempo falls back to the default rather than breaking the grid', () => {
  const restored = deserialize(JSON.stringify({
    version: 1, project: { name: 'x', bpm: 100000, notes: [], origin: 'composed' },
  }));
  assert.ok(restored);
  assert.ok(restored.bpm >= 20 && restored.bpm <= 300);
});

test('a null midi from a round-tripped NaN does not become a bass C', () => {
  // JSON has no NaN, so it is written as null, and Number(null) is a perfectly finite 0.
  const restored = deserialize(JSON.stringify({
    version: 1,
    project: { name: 'x', bpm: 100, origin: 'composed', notes: [{ midi: null, start: 0, end: 1 }] },
  }));
  assert.ok(restored);
  assert.equal(restored.notes.length, 0);
});

test('notes outside the MIDI range are rejected', () => {
  const restored = deserialize(JSON.stringify({
    version: 1,
    project: { name: 'x', bpm: 100, origin: 'composed', notes: [
      { midi: -5, start: 0, end: 1 }, { midi: 999, start: 0, end: 1 }, { midi: 60, start: -3, end: 1 },
    ] },
  }));
  assert.ok(restored);
  assert.equal(restored.notes.length, 0);
});
