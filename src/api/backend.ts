/**
 * Client for the optional companion backend.
 *
 * Every call here degrades gracefully. The app's core path -- upload a file, transcribe,
 * arrange, play -- never touches this module, so a sleeping or missing Space costs you
 * link input and vocal isolation and nothing else.
 */

export interface BackendHealth {
  ok: boolean;
  ytdlp: boolean;
  demucs: boolean;
  maxDurationSeconds: number;
}

const STORAGE_KEY = 'harmonica.backendUrl';

export function getBackendUrl(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setBackendUrl(url: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, url.replace(/\/+$/, ''));
  } catch {
    /* private browsing: the URL just will not persist between visits */
  }
}

/** Free Spaces sleep, and the first request after a nap takes about half a minute. */
const WAKE_TIMEOUT_MS = 45_000;
const WORK_TIMEOUT_MS = 30 * 60_000;

async function request(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const base = getBackendUrl();
  if (!base) throw new Error('No backend configured. Set one in Settings, or upload a file instead.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, { ...init, signal: controller.signal });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail.slice(0, 300) || `${response.status} ${response.statusText}`);
    }
    return response;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('The backend did not respond in time. A sleeping Space can take ~30s to wake.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkHealth(): Promise<BackendHealth | null> {
  if (!getBackendUrl()) return null;
  try {
    const response = await request('/health', { method: 'GET' }, WAKE_TIMEOUT_MS);
    const data = await response.json();
    return {
      ok: Boolean(data.ok),
      ytdlp: Boolean(data.ytdlp),
      demucs: Boolean(data.demucs),
      maxDurationSeconds: Number(data.max_duration_seconds ?? 600),
    };
  } catch {
    return null;
  }
}

export async function extractFromLink(url: string): Promise<ArrayBuffer> {
  const response = await request(
    '/extract',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) },
    WAKE_TIMEOUT_MS + WORK_TIMEOUT_MS,
  );
  return response.arrayBuffer();
}

export async function isolateVocals(audio: Blob): Promise<ArrayBuffer> {
  const form = new FormData();
  form.append('file', audio, 'input.wav');
  const response = await request('/separate', { method: 'POST', body: form }, WORK_TIMEOUT_MS);
  return response.arrayBuffer();
}
