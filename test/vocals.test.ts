import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isolateCentre, hasUsableStereo } from '../src/audio/vocals.ts';
import { fft, ifft } from '../src/audio/fft.ts';

const SAMPLE_RATE = 22050;
const SECONDS = 2;

function tone(frequency: number, amplitude = 1): Float32Array {
  const out = new Float32Array(SAMPLE_RATE * SECONDS);
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE);
  return out;
}

function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts[0]!.length);
  for (const p of parts) for (let i = 0; i < out.length; i++) out[i] = out[i]! + p[i]!;
  return out;
}

/** Energy at one frequency, via a direct Goertzel-style projection. */
function energyAt(signal: Float32Array, frequency: number): number {
  let re = 0, im = 0;
  // Skip the first and last frame: overlap-add ramps in and out at the edges.
  const from = 4096, to = Math.max(from, signal.length - 4096);
  for (let i = from; i < to; i++) {
    const phase = (2 * Math.PI * frequency * i) / SAMPLE_RATE;
    re += signal[i]! * Math.cos(phase);
    im += signal[i]! * Math.sin(phase);
  }
  const n = Math.max(1, to - from);
  return Math.hypot(re, im) / n;
}

test('inverse FFT reconstructs the original signal', () => {
  const re = Float32Array.from({ length: 256 }, (_, i) => Math.sin(i / 3) + 0.5 * Math.cos(i / 7));
  const original = re.slice();
  const im = new Float32Array(256);
  fft(re, im);
  ifft(re, im);
  for (let i = 0; i < 256; i++) {
    assert.ok(Math.abs(re[i]! - original[i]!) < 1e-4, `sample ${i} drifted: ${re[i]} vs ${original[i]}`);
  }
});

test('a centred voice survives while a hard-panned instrument is suppressed', () => {
  // 600Hz sung down the middle; 1200Hz guitar hard left. Both inside the vocal band,
  // so only the stereo placement distinguishes them.
  const voice = tone(600, 0.5);
  const guitar = tone(1200, 0.5);
  const left = mix(voice, guitar);
  const right = voice;

  const isolated = isolateCentre(left, right, SAMPLE_RATE);

  const voiceBefore = energyAt(left, 600);
  const guitarBefore = energyAt(left, 1200);
  const voiceAfter = energyAt(isolated, 600);
  const guitarAfter = energyAt(isolated, 1200);

  const ratioBefore = voiceBefore / guitarBefore;
  const ratioAfter = voiceAfter / guitarAfter;

  assert.ok(ratioAfter > ratioBefore * 4,
    `centre should be favoured far more after isolation (before ${ratioBefore.toFixed(2)}, after ${ratioAfter.toFixed(2)})`);
  assert.ok(voiceAfter > voiceBefore * 0.25, 'the voice itself must survive, not just be quieter overall');
});

test('centred bass is attenuated, because it is centred but not the tune', () => {
  const bass = tone(60, 0.5);
  const voice = tone(800, 0.5);
  const both = mix(bass, voice);
  const isolated = isolateCentre(both, both, SAMPLE_RATE);

  const bassRatio = energyAt(isolated, 60) / energyAt(both, 60);
  const voiceRatio = energyAt(isolated, 800) / energyAt(both, 800);
  assert.ok(voiceRatio > bassRatio * 3,
    `the vocal band should pass far better than 60Hz (voice ${voiceRatio.toFixed(3)}, bass ${bassRatio.toFixed(3)})`);
});

test('a mono source passes through without being gutted', () => {
  // Identical channels means everything is "centred", so the mask must not remove the tune.
  const voice = tone(700, 0.5);
  const isolated = isolateCentre(voice, voice, SAMPLE_RATE);
  const ratio = energyAt(isolated, 700) / energyAt(voice, 700);
  assert.ok(ratio > 0.5, `in-band mono content should largely survive, kept ${ratio.toFixed(2)}`);
});

test('output length and finiteness are preserved', () => {
  const left = tone(440, 0.4);
  const right = tone(445, 0.4);
  const isolated = isolateCentre(left, right, SAMPLE_RATE);
  assert.equal(isolated.length, left.length);
  for (let i = 0; i < isolated.length; i += 97) {
    assert.ok(Number.isFinite(isolated[i]!), `sample ${i} is not finite`);
  }
});

test('input shorter than one frame is returned unchanged rather than crashing', () => {
  const tiny = new Float32Array(500).fill(0.1);
  const out = isolateCentre(tiny, tiny, SAMPLE_RATE);
  assert.equal(out.length, 500);
});

test('genuinely mono files are detected so the work can be skipped', () => {
  const voice = tone(500, 0.5);
  assert.equal(hasUsableStereo(voice, voice), false);

  const wide = mix(voice, tone(900, 0.5));
  assert.equal(hasUsableStereo(wide, voice), true);
});
