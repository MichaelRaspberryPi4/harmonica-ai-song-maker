/**
 * Pulling the lead vocal forward, in the browser, with no server.
 *
 * Almost every commercial mix puts the lead vocal dead centre and spreads guitars, keys
 * and reverb out to the sides. That asymmetry is the handle: in any frequency bin where
 * the left and right channels agree, the sound is centred; where they disagree, it is not.
 * Building a soft mask from that agreement and applying it to the mid signal leaves the
 * centred material and pushes the rest down.
 *
 * This is not source separation and it will not match Demucs. It cannot: bass and kick
 * are centred too, so they survive the mask and have to be filtered out by frequency
 * instead, and a mix with the vocal panned off-centre defeats it completely. What it does
 * do is run in about a second with nothing to install, which for the purpose here --
 * giving the transcriber a cleaner melody to follow -- is usually enough.
 *
 * A mono recording carries no stereo information at all, so there is nothing to separate
 * and only the band limiting applies.
 */

import { fft, ifft, hannWindow } from './fft.ts';

const FRAME = 2048;
/** 75% overlap: with a Hann window this reconstructs without amplitude ripple. */
const HOP = FRAME / 4;

export interface IsolateOptions {
  /** Below this, centred bass and kick are attenuated rather than kept. Hz. */
  lowCutHz?: number;
  /** Above this, cymbals and air are attenuated. Hz. */
  highCutHz?: number;
  /**
   * Sharpness of the centre mask. 1 is gentle; higher values discard anything not almost
   * perfectly centred, which isolates better but chews holes in the vocal.
   */
  sharpness?: number;
}

const DEFAULTS: Required<IsolateOptions> = {
  lowCutHz: 120,
  highCutHz: 5000,
  sharpness: 2,
};

/**
 * How centred a bin is, from 0 (hard panned or out of phase) to 1 (identical in both
 * channels). Normalising by the channel magnitudes keeps this independent of how loud
 * the moment is, so quiet verses mask the same way as loud choruses.
 */
function centredness(lRe: number, lIm: number, rRe: number, rIm: number): number {
  const lMag = Math.hypot(lRe, lIm);
  const rMag = Math.hypot(rRe, rIm);
  const diff = Math.hypot(lRe - rRe, lIm - rIm);
  const sum = lMag + rMag;
  if (sum < 1e-9) return 0;
  return Math.max(0, 1 - diff / sum);
}

/**
 * Roll-off outside the vocal band, applied in the frequency domain.
 *
 * Squared rather than first-order on purpose. Bass and kick are centred, so the stereo
 * mask keeps them entirely and only frequency can remove them; a single-pole slope leaves
 * 60Hz at about a third of its level, which is still loud enough to pull the transcriber
 * down onto the bassline instead of the tune. Squaring drops it to a tenth, at the cost of
 * thinning low male vocals -- acceptable, since their harmonics carry the pitch anyway.
 */
function bandGain(frequency: number, lowCut: number, highCut: number): number {
  if (frequency <= 0) return 0;
  const low = frequency / (frequency + lowCut);
  const high = highCut / (highCut + Math.max(0, frequency - highCut));
  return low * low * high * high;
}

/**
 * Returns a mono signal with centred, vocal-range content emphasised.
 * `left` and `right` must be the same length; pass the same array twice for mono input.
 */
export function isolateCentre(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
  options: IsolateOptions = {},
): Float32Array {
  const { lowCutHz, highCutHz, sharpness } = { ...DEFAULTS, ...options };
  const length = Math.min(left.length, right.length);
  if (length < FRAME) return left.slice(0, length);

  const output = new Float32Array(length);
  const normalisation = new Float32Array(length);
  const window = hannWindow(FRAME);

  const lRe = new Float32Array(FRAME);
  const lIm = new Float32Array(FRAME);
  const rRe = new Float32Array(FRAME);
  const rIm = new Float32Array(FRAME);

  const binHz = sampleRate / FRAME;
  const gains = new Float32Array(FRAME / 2 + 1);
  for (let b = 0; b <= FRAME / 2; b++) gains[b] = bandGain(b * binHz, lowCutHz, highCutHz);

  for (let start = 0; start + FRAME <= length; start += HOP) {
    for (let i = 0; i < FRAME; i++) {
      const w = window[i]!;
      lRe[i] = left[start + i]! * w; lIm[i] = 0;
      rRe[i] = right[start + i]! * w; rIm[i] = 0;
    }
    fft(lRe, lIm);
    fft(rRe, rIm);

    // Mask the mid signal in place, keeping the spectrum conjugate-symmetric so the
    // inverse transform comes back real.
    for (let b = 0; b <= FRAME / 2; b++) {
      const mask = Math.pow(centredness(lRe[b]!, lIm[b]!, rRe[b]!, rIm[b]!), sharpness) * gains[b]!;
      const midRe = ((lRe[b]! + rRe[b]!) / 2) * mask;
      const midIm = ((lIm[b]! + rIm[b]!) / 2) * mask;
      lRe[b] = midRe; lIm[b] = midIm;
      if (b > 0 && b < FRAME / 2) {
        const mirror = FRAME - b;
        lRe[mirror] = midRe; lIm[mirror] = -midIm;
      }
    }

    ifft(lRe, lIm);

    for (let i = 0; i < FRAME; i++) {
      const w = window[i]!;
      output[start + i] = output[start + i]! + lRe[i]! * w;
      normalisation[start + i] = normalisation[start + i]! + w * w;
    }
  }

  for (let i = 0; i < length; i++) {
    const n = normalisation[i]!;
    if (n > 1e-6) output[i] = output[i]! / n;
  }
  return output;
}

/** True when the two channels differ enough for centre extraction to mean anything. */
export function hasUsableStereo(left: Float32Array, right: Float32Array): boolean {
  const step = Math.max(1, Math.floor(left.length / 20000));
  let difference = 0;
  let energy = 0;
  for (let i = 0; i < left.length && i < right.length; i += step) {
    difference += Math.abs(left[i]! - right[i]!);
    energy += Math.abs(left[i]!) + Math.abs(right[i]!);
  }
  if (energy < 1e-6) return false;
  // Below about a percent of difference the file is mono, or a mono source in a
  // stereo container, and masking would only remove signal for no gain.
  return difference / energy > 0.01;
}
