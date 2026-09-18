/**
 * Playback: a synthesised tremolo harmonica, the original recording, and a metronome,
 * all locked to one clock.
 *
 * The original recording is the master clock rather than the AudioContext, because the
 * browser owns its decoding and seeking. Everything else schedules against it. Note times
 * are always in "song seconds" and only converted to wall-clock at the moment of
 * scheduling, so changing the tempo mid-playback needs no rewriting of the arrangement.
 */

import type { ArrangedNote } from '../core/arrange.ts';

/**
 * Cents of detune between the two reeds of a pair. A tremolo harmonica's shimmer is two
 * reeds sounding the same note slightly apart; at around 16 cents that beats about four
 * times a second in the middle of the range, which is what the instrument actually does.
 */
const TREMOLO_DETUNE_CENTS = 16;
const SCHEDULE_AHEAD = 0.18;
const SCHEDULER_INTERVAL_MS = 40;

export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** A pair of detuned reeds through a formant-ish filter: close enough to read as a harp. */
export class HarmonicaSynth {
  private readonly context: AudioContext;
  private readonly output: GainNode;

  constructor(context: AudioContext, destination: AudioNode) {
    this.context = context;
    this.output = context.createGain();
    this.output.gain.value = 0.8;
    this.output.connect(destination);
  }

  set volume(value: number) {
    this.output.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
  }

  /** Schedules one note. `when` and `duration` are in AudioContext time. */
  play(midi: number, when: number, duration: number, gain = 0.25): void {
    const frequency = midiToFrequency(midi);
    const noteGain = this.context.createGain();

    const filter = this.context.createBiquadFilter();
    filter.type = 'lowpass';
    // Track the note so high notes stay bright without the low ones turning to buzz.
    filter.frequency.value = Math.min(6000, frequency * 6);
    filter.Q.value = 1.2;

    for (const detune of [-TREMOLO_DETUNE_CENTS / 2, TREMOLO_DETUNE_CENTS / 2]) {
      const osc = this.context.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = frequency;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start(when);
      osc.stop(when + duration + 0.08);
    }

    filter.connect(noteGain);
    noteGain.connect(this.output);

    // A reed speaks quickly but not instantly, and decays rather than cutting dead.
    const attack = 0.012;
    const release = 0.06;
    noteGain.gain.setValueAtTime(0, when);
    noteGain.gain.linearRampToValueAtTime(gain, when + attack);
    noteGain.gain.setValueAtTime(gain, when + Math.max(attack, duration - release));
    noteGain.gain.linearRampToValueAtTime(0, when + duration + release);
  }

  click(when: number, accent = false): void {
    const osc = this.context.createOscillator();
    const gain = this.context.createGain();
    osc.type = 'square';
    osc.frequency.value = accent ? 1800 : 1200;
    gain.gain.setValueAtTime(accent ? 0.3 : 0.16, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain);
    gain.connect(this.output);
    osc.start(when);
    osc.stop(when + 0.06);
  }
}

export interface PlayerCallbacks {
  onTime?: (songSeconds: number) => void;
  onEnded?: () => void;
}

export interface LoopRegion {
  start: number;
  end: number;
}

export class Player {
  readonly context: AudioContext;
  private readonly synth: HarmonicaSynth;
  private readonly trackGain: GainNode;
  private media: HTMLAudioElement | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;

  private notes: ArrangedNote[] = [];
  private beats: number[] = [];
  private scheduledThrough = 0;
  private timer: number | null = null;
  private frame: number | null = null;

  /** Fallback clock for when there is no original recording loaded. */
  private silentStartedAt = 0;
  private silentOffset = 0;
  private running = false;

  loop: LoopRegion | null = null;
  metronomeOn = false;
  countInBeats = 0;
  private countInUntil = 0;

  constructor(private readonly callbacks: PlayerCallbacks = {}) {
    this.context = new AudioContext();
    this.trackGain = this.context.createGain();
    this.trackGain.gain.value = 0.7;
    this.trackGain.connect(this.context.destination);
    this.synth = new HarmonicaSynth(this.context, this.context.destination);
  }

  /** Volume of the original recording, 0-1. */
  set trackVolume(value: number) {
    this.trackGain.gain.setTargetAtTime(value, this.context.currentTime, 0.02);
  }

  /** Volume of the synthesised harmonica, 0-1. */
  set harmonicaVolume(value: number) {
    this.synth.volume = value;
  }

  /**
   * Slows playback without dropping the pitch. `preservesPitch` is the browser's own
   * time-stretcher, which is good enough here and avoids shipping a phase vocoder.
   */
  set rate(value: number) {
    if (this.media) {
      this.media.playbackRate = value;
      this.media.preservesPitch = true;
    }
    this.playbackRate = value;
  }
  private playbackRate = 1;

  get duration(): number {
    return this.media?.duration ?? (this.notes.at(-1)?.end ?? 0);
  }

  attachTrack(url: string): void {
    this.detachTrack();
    const audio = new Audio(url);
    audio.crossOrigin = 'anonymous';
    audio.preservesPitch = true;
    audio.addEventListener('ended', () => {
      this.running = false;
      this.callbacks.onEnded?.();
    });
    this.mediaSource = this.context.createMediaElementSource(audio);
    this.mediaSource.connect(this.trackGain);
    this.media = audio;
  }

  detachTrack(): void {
    this.media?.pause();
    this.mediaSource?.disconnect();
    this.media = null;
    this.mediaSource = null;
  }

  setArrangement(notes: ArrangedNote[], beats: number[] = []): void {
    this.notes = [...notes].sort((a, b) => a.start - b.start);
    this.beats = beats;
    this.scheduledThrough = this.currentTime;
  }

  /** Position in song seconds, independent of playback rate. */
  get currentTime(): number {
    if (this.media) return this.media.currentTime;
    if (!this.running) return this.silentOffset;
    return this.silentOffset + (this.context.currentTime - this.silentStartedAt) * this.playbackRate;
  }

  seek(songSeconds: number): void {
    const clamped = Math.max(0, Math.min(songSeconds, this.duration || songSeconds));
    if (this.media) {
      this.media.currentTime = clamped;
    } else {
      this.silentOffset = clamped;
      this.silentStartedAt = this.context.currentTime;
    }
    this.scheduledThrough = clamped;
    this.callbacks.onTime?.(clamped);
  }

  async play(): Promise<void> {
    if (this.context.state === 'suspended') await this.context.resume();

    if (this.countInBeats > 0 && this.beats.length > 1) {
      const beatPeriod = (this.beats[1]! - this.beats[0]!) / this.playbackRate;
      const startAt = this.context.currentTime + 0.08;
      for (let i = 0; i < this.countInBeats; i++) {
        this.synth.click(startAt + i * beatPeriod, i === 0);
      }
      this.countInUntil = startAt + this.countInBeats * beatPeriod;
      const waitMs = (this.countInUntil - this.context.currentTime) * 1000;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    this.running = true;
    this.scheduledThrough = this.currentTime;
    if (this.media) {
      this.media.playbackRate = this.playbackRate;
      await this.media.play();
    } else {
      this.silentStartedAt = this.context.currentTime;
    }
    this.startScheduler();
  }

  pause(): void {
    this.running = false;
    if (this.media) {
      this.media.pause();
    } else {
      this.silentOffset = this.currentTime;
    }
    this.stopScheduler();
  }

  private startScheduler(): void {
    this.stopScheduler();
    this.timer = setInterval(() => this.tick(), SCHEDULER_INTERVAL_MS) as unknown as number;
    const paint = () => {
      this.callbacks.onTime?.(this.currentTime);
      if (this.running) this.frame = requestAnimationFrame(paint);
    };
    this.frame = requestAnimationFrame(paint);
  }

  private stopScheduler(): void {
    if (this.timer !== null) clearInterval(this.timer);
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.timer = null;
    this.frame = null;
  }

  /**
   * Schedules everything falling in the next lookahead window. Runs on a timer rather
   * than per-frame so that a dropped frame cannot drop a note.
   */
  private tick(): void {
    if (!this.running) return;
    const now = this.currentTime;

    if (this.loop && now >= this.loop.end) {
      this.seek(this.loop.start);
      return;
    }

    // The window is in song time; at half speed, the same wall-clock lookahead covers
    // half as much of the song.
    const windowEnd = now + SCHEDULE_AHEAD * this.playbackRate;
    const toWallClock = (songTime: number): number =>
      this.context.currentTime + (songTime - now) / this.playbackRate;

    for (const note of this.notes) {
      if (note.start < this.scheduledThrough || note.start >= windowEnd) continue;
      if (this.loop && (note.start < this.loop.start || note.start >= this.loop.end)) continue;
      const duration = Math.max(0.05, (note.end - note.start) / this.playbackRate);
      // Chord tones sit under the melody rather than beside it.
      note.holes.forEach((hole, index) => {
        this.synth.play(hole.midi, toWallClock(note.start), duration, index === 0 ? 0.26 : 0.13);
      });
    }

    if (this.metronomeOn) {
      for (const beat of this.beats) {
        if (beat < this.scheduledThrough || beat >= windowEnd) continue;
        if (this.loop && (beat < this.loop.start || beat >= this.loop.end)) continue;
        const index = this.beats.indexOf(beat);
        this.synth.click(toWallClock(beat), index % 4 === 0);
      }
    }

    this.scheduledThrough = windowEnd;
  }

  dispose(): void {
    this.stopScheduler();
    this.detachTrack();
    void this.context.close();
  }
}
