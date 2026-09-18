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
