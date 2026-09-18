/**
 * The two things you look at while playing: a scrolling strip of what to do next, and a
 * diagram of the harp showing where your mouth should be right now.
 *
 * The strip scrolls so the current note sits at a fixed point near the left edge, leaving
 * most of the width showing what is coming. Reading ahead is the whole point -- a display
 * centred on "now" is useless at tempo.
 */

import type { ArrangedNote, Difficulty } from '../core/arrange.ts';
import { midiToName } from '../core/pitch.ts';
import { CHANNELS_PER_SIDE, type Side } from '../core/harmonica.ts';

const PIXELS_PER_SECOND = 170;
const PLAYHEAD_OFFSET = 0.22; // fraction of the viewport width

export interface TabViewCallbacks {
  onSeek?: (songSeconds: number) => void;
  onSelectNote?: (index: number) => void;
}

export class TabView {
  private readonly strip: HTMLElement;
  private readonly harp: HTMLElement;
  private notes: ArrangedNote[] = [];
  private elements: HTMLElement[] = [];
  private activeIndex = -1;

  constructor(
    private readonly container: HTMLElement,
    private readonly harpContainer: HTMLElement,
    private readonly callbacks: TabViewCallbacks = {},
  ) {
    this.strip = document.createElement('div');
    this.strip.className = 'tab-strip';
    this.container.appendChild(this.strip);

    this.harp = document.createElement('div');
    this.harp.className = 'harp-map';
    this.harpContainer.appendChild(this.harp);

    this.container.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('.tab-note')) return;
      const rect = this.container.getBoundingClientRect();
      const x = event.clientX - rect.left - rect.width * PLAYHEAD_OFFSET + this.scrollOffset;
      this.callbacks.onSeek?.(Math.max(0, x / PIXELS_PER_SECOND));
    });

    this.renderHarp('C', []);
  }

  private scrollOffset = 0;

  render(notes: ArrangedNote[], beats: number[], difficulty: Difficulty): void {
    this.notes = notes;
    this.strip.replaceChildren();
    this.elements = [];
    this.activeIndex = -1;

    const totalSeconds = Math.max(notes.at(-1)?.end ?? 0, beats.at(-1) ?? 0) + 4;
    this.strip.style.width = `${totalSeconds * PIXELS_PER_SECOND}px`;

    // Bar lines go down first so notes sit on top of them.
    beats.forEach((beat, index) => {
      const line = document.createElement('div');
      line.className = index % 4 === 0 ? 'bar-line downbeat' : 'bar-line';
      line.style.left = `${beat * PIXELS_PER_SECOND}px`;
      this.strip.appendChild(line);
    });

    notes.forEach((note, index) => {
      const previous = notes[index - 1];
      if (previous && previous.side !== note.side) {
        this.strip.appendChild(this.buildFlipMarker(note, previous));
      }
      const element = this.buildNote(note, index, difficulty);
      this.strip.appendChild(element);
      this.elements.push(element);
    });
  }

  private buildNote(note: ArrangedNote, index: number, difficulty: Difficulty): HTMLElement {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = `tab-note side-${note.side} dir-${note.direction} altered-${note.altered}`;
    element.style.left = `${note.start * PIXELS_PER_SECOND}px`;
    element.style.width = `${Math.max(34, (note.end - note.start) * PIXELS_PER_SECOND - 4)}px`;

    const lead = note.holes[0]!;
    const arrow = note.direction === 'blow' ? '↑' : '↓';

    const channel = document.createElement('span');
    channel.className = 'channel';
    channel.textContent = `${arrow}${lead.channel}`;
    element.appendChild(channel);

    const name = document.createElement('span');
    name.className = 'note-name';
    name.textContent = midiToName(note.midi);
    element.appendChild(name);

    if (difficulty !== 'easy' && note.holes.length > 1) {
      const extra = document.createElement('span');
      extra.className = 'chord-tones';
      extra.textContent = note.holes.slice(1).map((h) => h.channel).join('+');
      element.appendChild(extra);
    }

    if (note.altered === 'substituted') {
      element.title = `Substituted: the original ${midiToName(note.sourceMidi)} does not exist on this harp`;
    } else if (note.altered === 'octave') {
      element.title = `Moved by an octave to fit the harp's range (originally ${midiToName(note.sourceMidi)})`;
    }

    element.addEventListener('click', (event) => {
      event.stopPropagation();
      this.callbacks.onSelectNote?.(index);
    });

    return element;
  }

  private buildFlipMarker(note: ArrangedNote, previous: ArrangedNote): HTMLElement {
    const marker = document.createElement('div');
    marker.className = `flip-marker to-${note.side}`;
    marker.style.left = `${note.start * PIXELS_PER_SECOND}px`;
    const gap = note.start - previous.end;
    // Warn louder when there is no time to do it comfortably.
    if (gap < 0.35) marker.classList.add('tight');
    marker.textContent = `FLIP TO ${note.side}`;
    marker.title = gap < 0.35
      ? `Only ${Math.round(gap * 1000)}ms to turn the harp over -- this one is tight`
      : `${gap.toFixed(1)}s to turn the harp over`;
    return marker;
  }

  /** Called every animation frame while playing. */
  update(songSeconds: number): void {
    const viewport = this.container.clientWidth;
    this.scrollOffset = songSeconds * PIXELS_PER_SECOND - viewport * PLAYHEAD_OFFSET;
    this.strip.style.transform = `translateX(${-this.scrollOffset}px)`;

    const index = this.findActive(songSeconds);
    if (index !== this.activeIndex) {
      this.elements[this.activeIndex]?.classList.remove('active');
      this.elements[index]?.classList.add('active');
      this.activeIndex = index;
      const note = this.notes[index];
      this.renderHarp(note?.side ?? 'C', note ? note.holes.map((h) => h.channel) : [], note?.direction);
    }
  }

  private findActive(songSeconds: number): number {
    // Notes are sorted and non-overlapping, so a scan from the last position would be
    // cheaper -- but seeking makes that fiddly and a few hundred notes is nothing.
    return this.notes.findIndex((n) => songSeconds >= n.start && songSeconds < n.end);
  }

  /** A picture of the harp with the holes you need lit up. */
  private renderHarp(side: Side, channels: number[], direction?: 'blow' | 'draw'): void {
    this.harp.replaceChildren();
    this.harp.className = `harp-map side-${side}`;

    const label = document.createElement('div');
    label.className = 'harp-label';
    label.textContent = `${side} side`;
    this.harp.appendChild(label);

    const row = document.createElement('div');
    row.className = 'harp-holes';
    for (let channel = 1; channel <= CHANNELS_PER_SIDE; channel++) {
      const hole = document.createElement('div');
      hole.className = 'harp-hole';
      if (channels.includes(channel)) {
        hole.classList.add('lit', direction === 'blow' ? 'blow' : 'draw');
      }
      hole.textContent = String(channel);
      row.appendChild(hole);
    }
    this.harp.appendChild(row);

    const breath = document.createElement('div');
    breath.className = 'harp-breath';
    breath.textContent = channels.length === 0 ? '—' : direction === 'blow' ? '↑ blow' : '↓ draw';
    this.harp.appendChild(breath);
  }
}
