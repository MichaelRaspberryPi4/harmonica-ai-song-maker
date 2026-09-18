/**
 * Deciding what to sound, and exactly when.
 *
 * Pulled out of the Player so it can be tested without a browser, because the edge cases
 * here are the ones a learner actually notices: the very first note of a song, the note
 * under the playhead after a seek, and the downbeat each time an A-B loop wraps.
 *
 * The hazard is scheduling into the past. A timer cannot fire the instant playback starts,
 * and `media.play()` takes around a tenth of a second to get going, so by the time the
 * first tick runs the clock has already moved past a note sitting at t=0. Handing Web Audio
 * a start time that has already been and gone does not fail loudly -- the oscillator starts
 * anyway, but its attack envelope is behind the clock, so the note arrives clipped, quiet
 * and late. It sounds like the app missed the opening of the tune.
 */

export interface TimedNote {
  start: number;
  end: number;
}

export interface ScheduledEvent {
  index: number;
  /** Wall-clock seconds from now. Never negative. */
  offset: number;
  /** Wall-clock duration, shortened if the onset had to be pulled forward. */
  duration: number;
  /** True when the onset was already past and got clamped to now. */
  clamped: boolean;
}

export interface WindowOptions {
  /** Song time already scheduled; notes before this are not replayed. */
  from: number;
  /** Song time up to which to schedule. */
  to: number;
  /** Current song time, the reference point for offsets. */
  now: number;
  /** Playback rate; song seconds divide by this to give wall-clock seconds. */
  rate: number;
  loop?: { start: number; end: number } | null;
  /** Events left shorter than this after clamping are dropped as inaudible. */
  minDuration?: number;
  /** Events whose onset is further in the past than this are dropped as genuinely missed. */
  maxLateness?: number;
}

const DEFAULT_MIN_DURATION = 0.04;
const DEFAULT_MAX_LATENESS = 0.35;
/**
 * Small lead given to an onset that had to be pulled forward. Building the oscillator and
 * gain nodes takes a few milliseconds, so anchoring a clamped note at exactly "now" leaves
 * its attack a whisker in the past by the time it is applied. Ten milliseconds is inaudible
 * and guarantees the whole envelope is still ahead of the clock.
 */
const CLAMP_LEAD = 0.01;

/**
 * Picks the notes falling in a scheduling window and converts them to wall-clock offsets.
 *
 * A note whose onset has just passed is pulled forward to now and shortened to match,
 * rather than dropped: at the start of a song, being a few milliseconds late is far better
 * than silence. One that is *badly* late is dropped instead, so a stalled tab that wakes up
 * seconds later does not vomit a chord of everything it missed.
 */
export function eventsInWindow(notes: TimedNote[], options: WindowOptions): ScheduledEvent[] {
  const {
    from, to, now, rate, loop = null,
    minDuration = DEFAULT_MIN_DURATION,
    maxLateness = DEFAULT_MAX_LATENESS,
  } = options;

  const events: ScheduledEvent[] = [];

  for (let index = 0; index < notes.length; index++) {
    const note = notes[index]!;
    if (note.start < from || note.start >= to) continue;
    if (loop && (note.start < loop.start || note.start >= loop.end)) continue;

    let offset = (note.start - now) / rate;
    let duration = (note.end - note.start) / rate;
    let clamped = false;

    if (offset < 0) {
      if (-offset > maxLateness) continue; // too far gone to be worth sounding
      duration += offset; // the part that already elapsed is gone
      offset = CLAMP_LEAD;
      clamped = true;
    }

    if (duration < minDuration) continue;
    events.push({ index, offset, duration, clamped });
  }

  return events;
}

/**
 * Metronome clicks in a window. A click has no duration, so a late one is simply dropped:
 * a click fired after its beat is worse than no click, because it actively misleads.
 */
export function clicksInWindow(
  beats: number[],
  options: Omit<WindowOptions, 'minDuration'>,
): Array<{ index: number; offset: number }> {
  const { from, to, now, rate, loop = null, maxLateness = 0.02 } = options;
  const clicks: Array<{ index: number; offset: number }> = [];

  for (let index = 0; index < beats.length; index++) {
    const beat = beats[index]!;
    if (beat < from || beat >= to) continue;
    if (loop && (beat < loop.start || beat >= loop.end)) continue;

    const offset = (beat - now) / rate;
    if (offset < 0) {
      if (-offset > maxLateness) continue;
      clicks.push({ index, offset: 0 });
    } else {
      clicks.push({ index, offset });
    }
  }

  return clicks;
}
