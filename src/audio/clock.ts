/**
 * The transport clock for material with no recording to follow.
 *
 * A song transcribed from audio takes its position from the media element. A tab written
 * by hand has no such thing, so position has to be derived from the AudioContext clock,
 * and the arithmetic is worth isolating because getting it subtly wrong is silent rather
 * than loud.
 *
 * The failure it exists to prevent: reading the position after marking the clock running
 * but before anchoring its start, so elapsed time is measured from a stale anchor. The
 * position then reads as however long the AudioContext has been alive -- which is zero on
 * a page that has made no sound, and tens of seconds on one that has. Playback appears to
 * work, the readout advances, and not a single note ever sounds, because the scheduler
 * believes it has already covered the whole piece.
 *
 * Here `start()` anchors before it can be observed as running, so that ordering is not
 * something a caller can get wrong.
 */
export class TransportClock {
  private offset = 0;
  private anchor = 0;
  private active = false;
  private readonly now: () => number;
  private playbackRate: number;

  /** `now` is the underlying monotonic clock, in seconds -- normally AudioContext.currentTime. */
  constructor(now: () => number, playbackRate = 1) {
    this.now = now;
    this.playbackRate = playbackRate;
  }

  get running(): boolean {
    return this.active;
  }

  /** Position in song seconds, unaffected by playback rate. */
  get position(): number {
    if (!this.active) return this.offset;
    return this.offset + (this.now() - this.anchor) * this.playbackRate;
  }

  start(): void {
    if (this.active) return;
    this.anchor = this.now();
    this.active = true;
  }

  pause(): void {
    if (!this.active) return;
    this.offset = this.position;
    this.active = false;
  }

  seek(seconds: number): void {
    this.offset = Math.max(0, seconds);
    this.anchor = this.now();
  }

  /** Changing rate re-anchors, so elapsed time already played is not rescaled retroactively. */
  set rate(value: number) {
    this.offset = this.position;
    this.anchor = this.now();
    this.playbackRate = value;
  }

  get rate(): number {
    return this.playbackRate;
  }
}
