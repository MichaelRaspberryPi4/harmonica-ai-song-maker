/**
 * The tab editor: a grid of pitch against time that you click notes into.
 *
 * Rows are pitches rather than holes, which sounds like the wrong choice for a harmonica
 * editor and is not. Which hole a note lands on depends on its neighbours -- the side solve
 * looks at the whole phrase -- so a hole-per-row grid would either have to freeze that
 * decision at the moment of clicking or renumber itself underneath the cursor. Rows of
 * pitch stay put, and every row label carries the hole it currently maps to.
 *
 * Notes are drawn as absolutely positioned blocks over a background of row stripes rather
 * than as a cell per position. Thirty rows of sixteenths across sixteen bars is over four
 * thousand cells, and rebuilding that on every click is visibly slow; there are only ever
 * as many note elements as there are notes.
 */

import type { NoteEvent } from '../core/arrange.ts';
import { editorRows, stepSeconds, type Project } from '../core/project.ts';
import { midiToName } from '../core/pitch.ts';
import { holesForMidi } from '../core/harmonica.ts';

const ROW_HEIGHT = 19;
const STEP_WIDTH = 22;

export interface EditorCallbacks {
  onAdd: (midi: number, start: number, duration: number) => void;
  onRemove: (midi: number, time: number) => void;
}

export class Editor {
  private readonly rows = editorRows();
  private readonly grid: HTMLElement;
  private readonly labels: HTMLElement;
  private readonly notesLayer: HTMLElement;
  private readonly playhead: HTMLElement;
  private project: Project | null = null;
  private scroller: HTMLElement | null;

  /** Steps per beat: 4 is sixteenths. */
  subdivision = 4;
  /** Length of a newly placed note, in steps. */
  noteLengthSteps = 2;

  constructor(private readonly container: HTMLElement, private readonly callbacks: EditorCallbacks) {
    this.container.classList.add('editor');

    this.labels = document.createElement('div');
    this.labels.className = 'editor-labels';
    this.scroller = null;

    this.grid = document.createElement('div');
    this.grid.className = 'editor-grid';

    this.notesLayer = document.createElement('div');
    this.notesLayer.className = 'editor-notes';

    this.playhead = document.createElement('div');
    this.playhead.className = 'editor-playhead';

    const scroller = document.createElement('div');
    scroller.className = 'editor-scroll';
    this.grid.appendChild(this.notesLayer);
    this.grid.appendChild(this.playhead);
    scroller.appendChild(this.grid);

    // The pitch column is outside the scroller so it stays put horizontally; it has to be
    // moved by hand to follow vertical scrolling, or the labels drift off their rows.
    scroller.addEventListener('scroll', () => {
      this.labels.scrollTop = scroller.scrollTop;
    });

    this.scroller = scroller;
    this.container.appendChild(this.labels);
    this.container.appendChild(scroller);

    this.grid.addEventListener('click', (event) => this.handleClick(event));
    this.buildLabels();
  }

  private buildLabels(): void {
    this.labels.replaceChildren();
    for (const midi of this.rows) {
      const label = document.createElement('div');
      label.className = 'row-label';
      label.style.height = `${ROW_HEIGHT}px`;

      // Prefer the C side when a pitch exists on both; the tab may still choose otherwise,
      // and the strip below always shows what was actually picked.
      const holes = holesForMidi(midi);
      const hole = holes.find((h) => h.side === 'C') ?? holes[0];
      label.classList.add(`side-${hole?.side ?? 'C'}`);
      if (midiToName(midi).startsWith('C')) label.classList.add('octave-start');

      const name = document.createElement('span');
      name.className = 'row-note';
      name.textContent = midiToName(midi);
      label.appendChild(name);

      if (hole) {
        const tab = document.createElement('span');
        tab.className = 'row-hole';
        // Name the side in text, not only in colour: hole 23 exists on both sides and
        // means a different note on each, so the number alone is ambiguous.
        tab.textContent = `${hole.side}${hole.position}${hole.direction === 'blow' ? '↑' : '↓'}`;
        tab.title = `${hole.side} side, hole ${hole.position}, ${hole.direction}`;
        label.appendChild(tab);
      }
      this.labels.appendChild(label);
    }
  }

  render(project: Project, totalSeconds: number): void {
    this.project = project;
    const step = stepSeconds(project.bpm, this.subdivision);
    const steps = Math.ceil(totalSeconds / step);

    this.grid.style.width = `${steps * STEP_WIDTH}px`;
    this.grid.style.height = `${this.rows.length * ROW_HEIGHT}px`;

    // Bar and beat lines are painted rather than built from elements: one background
    // declaration instead of thousands of nodes.
    const beatWidth = STEP_WIDTH * this.subdivision;
    const barWidth = beatWidth * project.beatsPerBar;
    this.grid.style.backgroundSize =
      `${STEP_WIDTH}px ${ROW_HEIGHT}px, ${beatWidth}px ${ROW_HEIGHT}px, ${barWidth}px ${ROW_HEIGHT}px, 100% ${ROW_HEIGHT * 2}px`;

    this.notesLayer.replaceChildren();
    for (const note of project.notes) {
      const rowIndex = this.rows.indexOf(note.midi);
      if (rowIndex < 0) continue; // a pitch the harp cannot sound; the arranger will move it
      this.notesLayer.appendChild(this.buildNote(note, rowIndex, step));
    }
  }

  private buildNote(note: NoteEvent, rowIndex: number, step: number): HTMLElement {
    const element = document.createElement('div');
    element.className = 'editor-note';
    const holes = holesForMidi(note.midi);
    const hole = holes.find((h) => h.side === 'C') ?? holes[0];
    element.classList.add(`side-${hole?.side ?? 'C'}`, `dir-${hole?.direction ?? 'blow'}`);
    element.style.left = `${(note.start / step) * STEP_WIDTH}px`;
    element.style.width = `${Math.max(STEP_WIDTH - 2, ((note.end - note.start) / step) * STEP_WIDTH - 2)}px`;
    element.style.top = `${rowIndex * ROW_HEIGHT + 1}px`;
    element.style.height = `${ROW_HEIGHT - 2}px`;
    element.title = `${midiToName(note.midi)} — click to delete`;
    element.textContent = hole ? `${hole.direction === 'blow' ? '↑' : '↓'}${hole.position}` : midiToName(note.midi);
    return element;
  }

  private handleClick(event: MouseEvent): void {
    if (!this.project) return;
    const rect = this.grid.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const rowIndex = Math.floor(y / ROW_HEIGHT);
    const midi = this.rows[rowIndex];
    if (midi === undefined) return;

    const step = stepSeconds(this.project.bpm, this.subdivision);
    const stepIndex = Math.floor(x / STEP_WIDTH);
    const time = stepIndex * step;

    if ((event.target as HTMLElement).classList.contains('editor-note')) {
      this.callbacks.onRemove(midi, time);
    } else {
      this.callbacks.onAdd(midi, time, step * this.noteLengthSteps);
    }
  }

  /** Moves the playhead and keeps it in view; called on every frame while playing. */
  update(seconds: number): void {
    if (!this.project) return;
    const step = stepSeconds(this.project.bpm, this.subdivision);
    const x = (seconds / step) * STEP_WIDTH;
    this.playhead.style.transform = `translateX(${x}px)`;

    const scroller = this.scroller;
    if (!scroller) return;
    // Scroll only when the playhead is about to leave, and then jump a good way ahead,
    // so a long tab does not judder sideways on every frame.
    const margin = scroller.clientWidth * 0.15;
    if (x < scroller.scrollLeft + margin || x > scroller.scrollLeft + scroller.clientWidth - margin) {
      scroller.scrollLeft = Math.max(0, x - scroller.clientWidth * 0.3);
    }
  }
}
