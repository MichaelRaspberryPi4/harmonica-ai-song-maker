/**
 * Audio in, note events out.
 *
 * Transcription runs in the browser via Spotify's Basic Pitch, a small convolutional
 * model that emits onsets, frames and pitch contours. It wants 22.05kHz mono, which is
 * also what the beat tracker wants, so everything downstream shares one decode.
 */

import type { NoteEvent } from '../core/arrange.ts';

/** Basic Pitch is trained at this rate and behaves badly at any other. */
export const TARGET_SAMPLE_RATE = 22050;

const DEFAULT_MODEL_URL = 'https://cdn.jsdelivr.net/npm/@spotify/basic-pitch@1.0.1/model/model.json';

export interface TranscribeOptions {
  /** 0-1. Higher means fewer, more certain note starts. */
  onsetThreshold?: number;
  /** 0-1. Higher means notes are released sooner. */
  frameThreshold?: number;
  /** Discard notes shorter than this many frames. */
  minNoteLengthFrames?: number;
  modelUrl?: string;
  onProgress?: (fraction: number) => void;
}

const DEFAULTS = {
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteLengthFrames: 5,
  modelUrl: DEFAULT_MODEL_URL,
};

export interface DecodedAudio {
  /** Mono downmix: what beat tracking and plain transcription use. */
  mono: Float32Array;
  left: Float32Array;
  right: Float32Array;
  sampleRate: number;
  /** False when both channels are identical, so there is no stereo to exploit. */
  stereo: boolean;
}

/**
 * Decodes to both channels at 22.05kHz, keeping them separate.
 *
 * Downmixing during decode is the obvious thing and it destroys the one cue centre-channel
 * vocal isolation depends on, so the split has to survive this far.
 */
export async function decodeStereo(data: ArrayBuffer): Promise<DecodedAudio> {
  const decodeContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeContext.decodeAudioData(data.slice(0));
  } finally {
    void decodeContext.close();
  }

  const frames = Math.ceil(decoded.duration * TARGET_SAMPLE_RATE);
  const channels = Math.min(2, decoded.numberOfChannels);
  const offline = new OfflineAudioContext(channels, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  const left = rendered.getChannelData(0);
  const right = rendered.numberOfChannels > 1 ? rendered.getChannelData(1) : left;
  const mono = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i]! + right[i]!) / 2;

  return {
    mono, left, right,
    sampleRate: rendered.sampleRate,
    stereo: rendered.numberOfChannels > 1,
  };
}

/** Wraps raw samples back into an AudioBuffer for the transcriber. */
export function bufferFromSamples(samples: Float32Array, sampleRate: number): AudioBuffer {
  const buffer = new AudioBuffer({ length: samples.length, sampleRate, numberOfChannels: 1 });
  // copyToChannel's type insists on a plain ArrayBuffer backing; ours always is.
  buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buffer;
}

/** Decodes any browser-supported audio file and resamples it to mono at 22.05kHz. */
export async function decodeToMono(data: ArrayBuffer): Promise<AudioBuffer> {
  // Decode at the file's own rate first; resampling during decode loses quality on
  // some browsers, and OfflineAudioContext gives a consistent resampler across all of them.
  const decodeContext = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeContext.decodeAudioData(data.slice(0));
  } finally {
    void decodeContext.close();
  }

  const frames = Math.ceil((decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

interface BasicPitchNote {
  startTimeSeconds: number;
  durationSeconds: number;
  pitchMidi: number;
  amplitude: number;
}

/**
 * Runs Basic Pitch over a decoded buffer. The model is fetched from a CDN on first use
 * and cached by the browser; it is a few megabytes, so this is slow once and fast after.
 */
export async function transcribe(buffer: AudioBuffer, options: TranscribeOptions = {}): Promise<NoteEvent[]> {
  const opts = { ...DEFAULTS, ...options };
  const {
    BasicPitch, noteFramesToTime, addPitchBendsToNoteEvents, outputToNotesPoly,
  } = await import('@spotify/basic-pitch');

  const model = new BasicPitch(opts.modelUrl);
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  await model.evaluateModel(
    buffer,
    (f: number[][], o: number[][], c: number[][]) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (fraction: number) => opts.onProgress?.(fraction),
  );

  const notes = noteFramesToTime(
    addPitchBendsToNoteEvents(
      contours,
      outputToNotesPoly(frames, onsets, opts.onsetThreshold, opts.frameThreshold, opts.minNoteLengthFrames),
    ),
  ) as BasicPitchNote[];

  return notes.map((n) => ({
    midi: Math.round(n.pitchMidi),
    start: n.startTimeSeconds,
    end: n.startTimeSeconds + n.durationSeconds,
    confidence: Math.max(0, Math.min(1, n.amplitude)),
  }));
}

/** Flattens an AudioBuffer's first channel for the beat tracker. */
export function channelData(buffer: AudioBuffer): Float32Array {
  return buffer.getChannelData(0);
}
