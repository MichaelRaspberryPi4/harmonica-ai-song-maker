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
import { editorLayout, stepSeconds, type EditorRow, type Project } from '../core/project.ts';
import { midiToName } from '../core/pitch.ts';
import { holesForMidi, type Side } from '../core/harmonica.ts';

const ROW_HEIGHT = 19;
const STEP_WIDTH = 22;
/** Must match .editor-labels in the stylesheet. */
const LABEL_WIDTH = 96;

export interface EditorCallbacks {
  onAdd: (midi: number, start: number, duration: number, position?: number) => void;
  onRemove: (midi: number, time: number) => void;
}

export class Editor {
  /** Rebuilt whenever the locked side changes, since that changes the rows entirely. */
  private rows: EditorRow[] = editorLayout('C');
  private readonly grid: HTMLElement;
  private readonly labels: HTMLElement;
  private readonly notesLayer: HTMLElement;
  private readonly playhead: HTMLElement;
  private project: Project | null = null;

  /** Steps per beat: 4 is sixteenths. */
  subdivision = 4;
  /** Length of a newly placed note, in steps. */
  noteLengthSteps = 2;

  constructor(private readonly container: HTMLElement, private readonly callbacks: EditorCallbacks) {
    this.container.classList.add('editor');

    this.labels = document.createElement('div');
    this.labels.className = 'editor-labels';

    this.grid = document.createElement('div');
    this.grid.className = 'editor-grid';

    this.notesLayer = document.createElement('div');
    this.notesLayer.className = 'editor-notes';

    this.playhead = document.createElement('div');
    this.playhead.className = 'editor-playhead';

    this.grid.appendChild(this.notesLayer);
    this.grid.appendChild(this.playhead);

    // Labels and grid share one scroll container, with the label column stuck to the left
    // edge. Keeping them in separate scrollers and syncing by hand does not work: the
    // label column is exactly as tall as its content, so it has nothing to scroll and
    // assigning scrollTop silently does nothing. The grid then slides under labels that
    // cannot follow, rows drift out of line, and clicks land on the wrong pitch.
    const body = document.createElement('div');
    body.className = 'editor-body';
    body.appendChild(this.labels);
    body.appendChild(this.grid);
    this.container.appendChild(body);

    this.grid.addEventListener('click', (event) => this.handleClick(event));
    this.buildLabels('C');
  }

  private buildLabels(lockedSide?: Side): void {
    this.labels.replaceChildren();
    for (const row of this.rows) {
      const label = document.createElement('div');
      label.className = 'row-label';
      label.style.height = `${ROW_HEIGHT}px`;

      // With a side locked the row *is* a hole, so the label is exact. Otherwise fall
      // back to whichever hole the C side offers for the pitch.
      const hole = row.position !== undefined
        ? holesForMidi(row.midi).find((h) => h.side === lockedSide && h.position === row.position)
        : holesForMidi(row.midi).find((h) => h.side === 'C') ?? holesForMidi(row.midi)[0];

      label.classList.add(`side-${hole?.side ?? 'C'}`, `dir-${hole?.direction ?? 'blow'}`);
      if (midiToName(row.midi).startsWith('C')) label.classList.add('octave-start');

      const name = document.createElement('span');
      name.className = 'row-note';
      name.textContent = midiToName(row.midi);
      label.appendChild(name);

      if (hole) {
        const tab = document.createElement('span');
        tab.className = 'row-hole';
        // Hole number first: with rows in hole order this column now reads 24 down to 1,
        // which is how the instrument is laid out in front of you.
        tab.textContent = `${hole.position}${hole.direction === 'blow' ? '↑' : '↓'}`;
        tab.title = `${hole.side} side, hole ${hole.position}, ${hole.direction} ${midiToName(hole.midi)}`;
        label.appendChild(tab);
      }
      this.labels.appendChild(label);
    }
  }

  render(project: Project, totalSeconds: number): void {
    const nextRows = editorLayout(project.lockedSide);
    const changed = nextRows.length !== this.rows.length
      || nextRows.some((r, i) => r.midi !== this.rows[i]?.midi || r.position !== this.rows[i]?.position);
    if (changed) {
      this.rows = nextRows;
      this.buildLabels(project.lockedSide);
    }
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
      const rowIndex = this.rowIndexFor(note);
      if (rowIndex < 0) continue; // a pitch the harp cannot sound; the arranger will move it
      this.notesLayer.appendChild(this.buildNote(note, rowIndex, step));
    }
  }

  /** Where a note belongs: its own hole if it has one, otherwise the first row of its pitch. */
  private rowIndexFor(note: NoteEvent): number {
    if (note.position !== undefined) {
      const exact = this.rows.findIndex((r) => r.position === note.position && r.midi === note.midi);
      if (exact >= 0) return exact;
    }
    return this.rows.findIndex((r) => r.midi === note.midi);
  }

  private buildNote(note: NoteEvent, rowIndex: number, step: number): HTMLElement {
    const element = document.createElement('div');
    element.className = 'editor-note';
    const row = this.rows[rowIndex]!;
    const holes = holesForMidi(note.midi);
    const hole = (row.position !== undefined
      ? holes.find((h) => h.position === row.position && h.side === this.project?.lockedSide)
      : undefined)
      ?? holes.find((h) => h.side === (this.project?.lockedSide ?? 'C'))
      ?? holes[0];
    element.classList.add(`side-${hole?.side ?? 'C'}`, `dir-${hole?.direction ?? 'blow'}`);
    element.style.left = `${(note.start / step) * STEP_WIDTH}px`;
    element.style.width = `${Math.max(STEP_WIDTH - 2, ((note.end - note.start) / step) * STEP_WIDTH - 2)}px`;
    element.style.top = `${rowIndex * ROW_HEIGHT + 1}px`;
    element.style.height = `${ROW_HEIGHT - 2}px`;
    element.title = `${midiToName(note.midi)} — click to delete`;
    element.textContent = hole ? `${hole.position}${hole.direction === 'blow' ? '↑' : '↓'}` : midiToName(note.midi);
    return element;
  }

  private handleClick(event: MouseEvent): void {
    if (!this.project) return;
    const rect = this.grid.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const rowIndex = Math.floor(y / ROW_HEIGHT);
    const row = this.rows[rowIndex];
    if (row === undefined) return;
    const midi = row.midi;

    const step = stepSeconds(this.project.bpm, this.subdivision);
    const stepIndex = Math.floor(x / STEP_WIDTH);
    const time = stepIndex * step;

    if ((event.target as HTMLElement).classList.contains('editor-note')) {
      this.callbacks.onRemove(midi, time);
    } else {
      this.callbacks.onAdd(midi, time, step * this.noteLengthSteps, row.position);
    }
  }

  /** Moves the playhead and keeps it in view; called on every frame while playing. */
  update(seconds: number): void {
    if (!this.project) return;
    const step = stepSeconds(this.project.bpm, this.subdivision);
    const x = (seconds / step) * STEP_WIDTH;
    this.playhead.style.transform = `translateX(${x}px)`;

    // The label column is sticky, so the first LABEL_WIDTH pixels of the viewport are
    // covered by it and do not count as visible grid.
    const scroller = this.container;
    const visible = scroller.clientWidth - LABEL_WIDTH;
    if (visible <= 0) return;
    // Scroll only when the playhead is about to leave, and then jump a good way ahead,
    // so a long tab does not judder sideways on every frame.
    const margin = visible * 0.15;
    if (x < scroller.scrollLeft + margin || x > scroller.scrollLeft + visible - margin) {
      scroller.scrollLeft = Math.max(0, x - visible * 0.3);
    }
  }
}
