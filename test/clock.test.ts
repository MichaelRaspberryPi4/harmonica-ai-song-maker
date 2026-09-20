import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TransportClock } from '../src/audio/clock.ts';

/** A hand-cranked stand-in for AudioContext.currentTime. */
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (by: number) => { t += by; } };
}

test('a fresh clock sits at zero and does not move until started', () => {
  const c = fakeClock();
  const clock = new TransportClock(c.now);
  c.advance(5);
  assert.equal(clock.position, 0);
});

test('starting on a long-lived context begins at zero, not at the context time', () => {
  // The real bug: the AudioContext had been running for 30 seconds because placing a note
  // previewed it. Position must be measured from the moment playback starts.
  const c = fakeClock(30);
  const clock = new TransportClock(c.now);
  clock.start();
  assert.equal(clock.position, 0, 'playback starts at the beginning, not at 30s');
  c.advance(1.5);
  assert.equal(clock.position, 1.5);
});

test('position is never observed running from an unanchored start', () => {
  for (const contextAge of [0, 0.4, 12, 900]) {
    const c = fakeClock(contextAge);
    const clock = new TransportClock(c.now);
    clock.start();
    assert.equal(clock.position, 0, `context age ${contextAge} leaked into the position`);
  }
});

test('pause holds the position and resume carries on from it', () => {
  const c = fakeClock(7);
  const clock = new TransportClock(c.now);
  clock.start();
  c.advance(2);
  clock.pause();
  assert.equal(clock.position, 2);
  c.advance(10);                       // time passes while paused
  assert.equal(clock.position, 2, 'a paused clock must not drift');
  clock.start();
  c.advance(1);
  assert.equal(clock.position, 3);
});

test('starting twice does not re-anchor and lose elapsed time', () => {
  const c = fakeClock();
  const clock = new TransportClock(c.now);
  clock.start();
  c.advance(2);
  clock.start();
  assert.equal(clock.position, 2);
});

test('seeking works both while running and while paused', () => {
  const c = fakeClock(3);
  const clock = new TransportClock(c.now);
  clock.seek(10);
  assert.equal(clock.position, 10);
  clock.start();
  c.advance(0.5);
  assert.equal(clock.position, 10.5);
  clock.seek(0);
  c.advance(0.25);
  assert.equal(clock.position, 0.25);
});

test('seeking before zero clamps', () => {
  const clock = new TransportClock(fakeClock().now);
  clock.seek(-5);
  assert.equal(clock.position, 0);
});

test('changing rate does not rescale what has already played', () => {
  const c = fakeClock();
  const clock = new TransportClock(c.now);
  clock.start();
  c.advance(4);                 // four seconds of song at full speed
  clock.rate = 0.5;
  assert.equal(clock.position, 4, 'already-played time stays put');
  c.advance(4);                 // four more wall-clock seconds at half speed
  assert.equal(clock.position, 6, 'which is two more song seconds');
});
