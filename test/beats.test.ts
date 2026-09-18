import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectBeats, onsetEnvelope, barLines } from '../src/audio/beats.ts';

const SAMPLE_RATE = 22050;

/** Deterministic noise, so a rerun cannot pass or fail by luck. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** A click track: short percussive bursts at a fixed tempo. */
function clickTrack(bpm: number, seconds: number, sampleRate = SAMPLE_RATE): Float32Array {
  const random = seededRandom(42);
  const samples = new Float32Array(Math.floor(seconds * sampleRate));
  const period = (60 / bpm) * sampleRate;
  for (let click = 0; click * period < samples.length; click++) {
    const start = Math.floor(click * period);
    const length = Math.floor(0.02 * sampleRate);
    for (let i = 0; i < length && start + i < samples.length; i++) {
      // Exponentially decaying noise burst: broadband, like a drum hit.
      samples[start + i] = (random() * 2 - 1) * Math.exp(-i / (length / 4));
    }
  }
  return samples;
}

test('onset envelope spikes at note attacks', () => {
  const { envelope, frameRate } = onsetEnvelope(clickTrack(120, 4), SAMPLE_RATE);
  assert.ok(envelope.length > 0);
  assert.ok(frameRate > 0);

  const peak = Math.max(...envelope);
  const mean = envelope.reduce((a, b) => a + b, 0) / envelope.length;
  assert.ok(peak > mean * 3, `attacks should stand out from the floor (peak ${peak}, mean ${mean})`);
});

test('tempo is recovered from a click track', () => {
  for (const bpm of [90, 120, 140]) {
    const result = detectBeats(clickTrack(bpm, 12), SAMPLE_RATE);
    assert.ok(
      Math.abs(result.bpm - bpm) < 3,
      `expected about ${bpm}bpm, detected ${result.bpm}`,
    );
  }
});

test('detected beats line up with the actual clicks', () => {
  const bpm = 120;
  const result = detectBeats(clickTrack(bpm, 12), SAMPLE_RATE);
  const expectedPeriod = 60 / bpm;

  assert.ok(result.beats.length > 10, 'should produce a beat per click');
  for (const beat of result.beats.slice(0, 10)) {
    const offBy = Math.abs(beat - Math.round(beat / expectedPeriod) * expectedPeriod);
    assert.ok(offBy < 0.06, `beat at ${beat}s drifts ${offBy.toFixed(3)}s from the grid`);
  }
});

test('confidence is low for material with no pulse', () => {
  const random = seededRandom(7);
  const noise = new Float32Array(SAMPLE_RATE * 8);
  for (let i = 0; i < noise.length; i++) noise[i] = random() * 2 - 1;
  const result = detectBeats(noise, SAMPLE_RATE);
  assert.ok(result.confidence < 0.5, `white noise should not read as a strong pulse (${result.confidence})`);
});

test('very short input does not blow up', () => {
  const result = detectBeats(new Float32Array(100), SAMPLE_RATE);
  assert.deepEqual(result.beats, []);
  assert.equal(result.confidence, 0);
});

test('bar lines take every fourth beat', () => {
  assert.deepEqual(barLines([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]), [0, 2]);
  assert.deepEqual(barLines([0, 0.5, 1, 1.5, 2, 2.5], 3), [0, 1.5]);
});
