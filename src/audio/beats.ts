/**
 * Tempo and beat tracking from raw audio.
 *
 * Three stages: a spectral-flux onset envelope (energy appearing in each frequency bin,
 * which tracks note attacks far better than raw loudness), autocorrelation of that
 * envelope to find the period that best explains the attacks, then a phase search to
 * decide where the downbeats actually land.
 */

import { fft, hannWindow } from './fft.ts';

export interface BeatGrid {
  /** Beat onsets in seconds. */
  beats: number[];
  bpm: number;
  /** 0-1. Low values mean the track has no clear pulse and the grid should not be trusted. */
  confidence: number;
}

const FFT_SIZE = 1024;
const HOP = 512;
const MIN_BPM = 60;
const MAX_BPM = 200;

/**
 * Spectral flux: the sum of positive changes in magnitude across bins, frame to frame.
 * Only increases count, because a note starting is an onset and a note stopping is not.
 */
export function onsetEnvelope(samples: Float32Array, sampleRate: number): { envelope: Float32Array; frameRate: number } {
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const envelope = new Float32Array(Math.max(0, frames));
  const window = hannWindow(FFT_SIZE);

  let previous = new Float32Array(FFT_SIZE / 2);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);

  for (let f = 0; f < frames; f++) {
    const offset = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (samples[offset + i] ?? 0) * window[i]!;
      im[i] = 0;
    }
    fft(re, im);

    let flux = 0;
    const magnitude = new Float32Array(FFT_SIZE / 2);
    for (let b = 0; b < FFT_SIZE / 2; b++) {
      const m = Math.sqrt(re[b]! * re[b]! + im[b]! * im[b]!);
      // Log compression keeps loud passages from swamping quiet ones.
      magnitude[b] = Math.log1p(m);
      const delta = magnitude[b]! - previous[b]!;
      if (delta > 0) flux += delta;
    }
    envelope[f] = flux;
    previous = magnitude;
  }

  return { envelope, frameRate: sampleRate / HOP };
}

function normalise(signal: Float32Array): Float32Array {
  const mean = signal.reduce((a, b) => a + b, 0) / Math.max(1, signal.length);
  const out = new Float32Array(signal.length);
  let peak = 0;
  for (let i = 0; i < signal.length; i++) {
    out[i] = signal[i]! - mean;
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = out[i]! / peak;
  return out;
}

/**
 * Finds the beat period by asking which lag best correlates the onset envelope with itself.
 *
 * The correlation is normalised by the energy of both overlapping windows, giving a true
 * coefficient in [-1, 1]. Comparing the winning lag against the *mean* correlation instead
 * is tempting and badly broken: for unpitched material the mean sits near zero, so the
 * ratio explodes and white noise reports as a rock-solid pulse.
 */
function estimatePeriod(envelope: Float32Array, frameRate: number): { lag: number; strength: number } {
  const minLag = Math.max(1, Math.floor((60 / MAX_BPM) * frameRate));
  const maxLag = Math.min(envelope.length - 1, Math.ceil((60 / MIN_BPM) * frameRate));

  let bestLag = minLag;
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let dot = 0;
    let energyA = 0;
    let energyB = 0;
    for (let i = 0; i + lag < envelope.length; i++) {
      const a = envelope[i]!;
      const b = envelope[i + lag]!;
      dot += a * b;
      energyA += a * a;
      energyB += b * b;
    }
    const denominator = Math.sqrt(energyA * energyB);
    const score = denominator > 0 ? dot / denominator : 0;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  return { lag: bestLag, strength: Math.max(0, Math.min(1, bestScore)) };
}

/** Slides a pulse train across the envelope to find which offset the beats sit on. */
function estimatePhase(envelope: Float32Array, lag: number): number {
  let bestPhase = 0;
  let bestSum = -Infinity;
  for (let phase = 0; phase < lag; phase++) {
    let sum = 0;
    for (let i = phase; i < envelope.length; i += lag) sum += envelope[i]!;
    if (sum > bestSum) {
      bestSum = sum;
      bestPhase = phase;
    }
  }
  return bestPhase;
}

export function detectBeats(samples: Float32Array, sampleRate: number): BeatGrid {
  const { envelope, frameRate } = onsetEnvelope(samples, sampleRate);
  if (envelope.length < 8) return { beats: [], bpm: 0, confidence: 0 };

  const normalised = normalise(envelope);
  const { lag, strength } = estimatePeriod(normalised, frameRate);
  const phase = estimatePhase(normalised, lag);

  const period = lag / frameRate;
  let bpm = 60 / period;
  // Autocorrelation happily locks onto half or double time; nudge into a musical range.
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  const beatPeriod = 60 / bpm;
  const duration = samples.length / sampleRate;
  const beats: number[] = [];
  for (let t = phase / frameRate; t < duration; t += beatPeriod) beats.push(Number(t.toFixed(4)));

  return { beats, bpm: Number(bpm.toFixed(2)), confidence: Number(strength.toFixed(3)) };
}

/** Groups beats into bars for the tab's bar lines. */
export function barLines(beats: number[], beatsPerBar = 4): number[] {
  return beats.filter((_, i) => i % beatsPerBar === 0);
}
