import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventsInWindow, clicksInWindow } from '../src/audio/scheduling.ts';

const TUNE = [
  { start: 0.0, end: 0.48 },
  { start: 0.5, end: 0.98 },
  { start: 1.0, end: 1.48 },
];

test('the opening note is still sounded when the clock has already passed it', () => {
  // Exactly the real failure: play() is called, the media element takes ~100ms to start,
  // and the first timer tick lands at 0.098 with a note sitting at 0.0.
  const events = eventsInWindow(TUNE, { from: 0, to: 0.28, now: 0.098, rate: 1 });
  assert.equal(events[0]?.index, 0, 'the opening note must not be skipped');
  assert.ok(events[0]!.offset > 0, 'and must never be scheduled into the past');
  assert.ok(events[0]!.offset < 0.02, 'but only just ahead, so it is not audibly late');
  assert.ok(events[0]!.clamped);
  // Shortened by however much already elapsed, so it still ends when it should.
  assert.ok(Math.abs(events[0]!.duration - (0.48 - 0.098)) < 1e-9);
});

test('nothing is ever scheduled before now', () => {
  for (const now of [0, 0.05, 0.098, 0.2, 0.3]) {
    for (const event of eventsInWindow(TUNE, { from: 0, to: now + 0.2, now, rate: 1 })) {
      assert.ok(event.offset >= 0, `offset ${event.offset} is in the past`);
      assert.ok(event.duration > 0, 'duration must stay positive');
    }
  }
});

test('a note missed by a long way is dropped rather than fired in a heap', () => {
  // A backgrounded tab that wakes up two seconds later must not dump everything at once.
  const events = eventsInWindow(TUNE, { from: 0, to: 2.2, now: 2.0, rate: 1 });
  assert.equal(events.length, 0);
});

test('a note clamped down to nothing is dropped instead of clicking', () => {
  const events = eventsInWindow([{ start: 0, end: 0.1 }], { from: 0, to: 0.3, now: 0.09, rate: 1 });
  assert.equal(events.length, 0, 'only 10ms would remain, which is a click, not a note');
});

test('slowing down stretches wall-clock timing but not song positions', () => {
  const full = eventsInWindow(TUNE, { from: 0, to: 1.2, now: 0, rate: 1 });
  const half = eventsInWindow(TUNE, { from: 0, to: 1.2, now: 0, rate: 0.5 });
  assert.equal(full.length, half.length);
  for (let i = 0; i < full.length; i++) {
    assert.ok(Math.abs(half[i]!.offset - full[i]!.offset * 2) < 1e-9, 'offsets should double');
    assert.ok(Math.abs(half[i]!.duration - full[i]!.duration * 2) < 1e-9, 'durations should double');
  }
});

test('a loop region excludes everything outside it', () => {
  const events = eventsInWindow(TUNE, {
    from: 0, to: 2, now: 0, rate: 1, loop: { start: 0.5, end: 1.0 },
  });
  assert.deepEqual(events.map((e) => e.index), [1]);
});

test('the downbeat is sounded on every loop wrap, not just the first pass', () => {
  // Wrapping seeks back to the loop start, so the same "note is slightly late" case
  // recurs on every repetition. This is the bar a learner loops hardest.
  const events = eventsInWindow(TUNE, {
    from: 0.5, to: 0.75, now: 0.56, rate: 1, loop: { start: 0.5, end: 1.0 },
  });
  assert.equal(events[0]?.index, 1, 'the note at the loop start must sound again');
  assert.ok(events[0]!.offset >= 0);
});

test('already-scheduled notes are not sounded twice', () => {
  const events = eventsInWindow(TUNE, { from: 0.5, to: 1.2, now: 0.5, rate: 1 });
  assert.deepEqual(events.map((e) => e.index), [1, 2]);
});

test('a late metronome click is dropped, because a late click misleads', () => {
  const beats = [0, 0.5, 1.0];
  const late = clicksInWindow(beats, { from: 0, to: 0.3, now: 0.15, rate: 1 });
  assert.equal(late.length, 0, '150ms after the beat, a click is worse than silence');

  const onTime = clicksInWindow(beats, { from: 0, to: 0.3, now: 0.005, rate: 1 });
  assert.equal(onTime[0]?.index, 0);
  assert.equal(onTime[0]?.offset, 0);
});

test('empty inputs are handled', () => {
  assert.deepEqual(eventsInWindow([], { from: 0, to: 1, now: 0, rate: 1 }), []);
  assert.deepEqual(clicksInWindow([], { from: 0, to: 1, now: 0, rate: 1 }), []);
});
