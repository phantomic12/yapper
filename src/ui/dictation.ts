// ─── Dictation UI ────────────────────────────────────────────────
// Press the button, speak, press it again. The recording is decoded,
// converted to what Whisper expects, transcribed locally, and inserted at
// the caret in the main text box.
//
// Push-to-talk rather than always-listening, on purpose: a mic that is
// only open while the button says so is the honest default for a tool
// whose whole pitch is that nothing leaves the browser. It also means no
// voice-activity tuning, which is where always-listening dictation
// usually goes wrong.
//
// The model is imported lazily so the 41 MB download only starts when
// someone actually dictates.

import type { AppState } from '../app-state';
import {
  ASR_SAMPLE_RATE,
  canRecord,
  conflate,
  downmix,
  insertAtCaret,
  isSilent,
  looksLikeSpeech,
  pickAsrModel,
  resample,
  splitForWhisper,
  trimSilence,
} from '../asr';

type Phase = 'idle' | 'loading' | 'recording' | 'transcribing' | 'error';

let phase: Phase = 'idle';
let recorder: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let blobChunks: Blob[] = [];

function node<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setPhase(button: HTMLButtonElement, status: HTMLElement | null, next: Phase, message = ''): void {
  phase = next;
  button.disabled = next === 'loading' || next === 'transcribing';
  button.setAttribute('aria-pressed', String(next === 'recording'));
  button.textContent =
    next === 'recording' ? 'Stop dictation'
    : next === 'loading' ? 'Loading model…'
    : next === 'transcribing' ? 'Transcribing…'
    : 'Dictate';
  if (status) status.textContent = message;
}

async function decodeToSamples(blob: Blob): Promise<{ samples: Float32Array; rate: number }> {
  const context = new AudioContext();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const channels: Float32Array[] = [];
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
    return { samples: downmix(channels), rate: buffer.sampleRate };
  } finally {
    void context.close().catch(() => undefined);
  }
}

/** Insert into the text box the way a keyboard would, so the rest of the app notices. */
function insertIntoTextarea(transcript: string): boolean {
  const textarea = node<HTMLTextAreaElement>('text-input');
  if (!textarea) return false;
  const caret = textarea.selectionStart ?? textarea.value.length;
  const { text, caret: nextCaret } = insertAtCaret(textarea.value, transcript, caret);
  textarea.value = text;
  textarea.selectionStart = textarea.selectionEnd = nextCaret;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.focus();
  return true;
}

async function transcribe(blob: Blob, state: AppState): Promise<string> {
  const { samples, rate } = await decodeToSamples(blob);
  const mono16k = resample(samples, rate, ASR_SAMPLE_RATE);
  // Strip the dead air at both ends before checking the level: a silent
  // room plus a cough is not speech, and Whisper invents words for it.
  const trimmed = trimSilence(mono16k, ASR_SAMPLE_RATE);
  if (!trimmed.length || isSilent(trimmed)) return '';
  // A steady hum is not silence by level, but Whisper answers "you" when
  // handed one. Reject a flat envelope before spending seconds on it.
  if (!looksLikeSpeech(trimmed, ASR_SAMPLE_RATE)) return '';

  const model = pickAsrModel(state.currentLanguageFilter);
  const { loadAsrModel, transcribeAudio } = await import('../engines/whisper-asr');
  await loadAsrModel(model);

  const parts: string[] = [];
  for (const window of splitForWhisper(trimmed, ASR_SAMPLE_RATE)) {
    const text = await transcribeAudio(window, { language: state.currentLanguageFilter });
    if (text) parts.push(text);
  }
  return conflate(parts);
}

/** Wire the dictate button. Safe on a page without the markup. */
export function bindDictation(state: AppState): void {
  const button = node<HTMLButtonElement>('dictate-btn');
  const status = node<HTMLElement>('dictate-status');
  if (!button) return;

  if (!canRecord()) {
    button.disabled = true;
    button.title = 'This browser cannot record audio';
    if (status) status.textContent = 'Dictation needs microphone access (not available here)';
    return;
  }

  const stopTracks = (): void => {
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };

  const startRecording = async (): Promise<void> => {
    try {
      setPhase(button, status, 'loading', 'Requesting microphone…');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      blobChunks = [];
      const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorder.addEventListener('dataavailable', (event) => {
        if (event.data.size) blobChunks.push(event.data);
      });
      recorder.start();
      setPhase(button, status, 'recording', 'Listening — press again to finish');
    } catch (error) {
      stopTracks();
      setPhase(
        button,
        status,
        'error',
        error instanceof Error && error.name === 'NotAllowedError'
          ? 'Microphone permission was refused'
          : 'Could not start recording',
      );
    }
  };

  const finishRecording = async (): Promise<void> => {
    const active = recorder;
    if (!active) return;
    const done = new Promise<Blob>((resolve) => {
      active.addEventListener('stop', () => resolve(new Blob(blobChunks, { type: active.mimeType })), {
        once: true,
      });
    });
    active.stop();
    stopTracks();
    recorder = null;

    try {
      setPhase(button, status, 'transcribing', 'Transcribing on device…');
      const text = await transcribe(await done, state);
      if (!text) {
        setPhase(button, status, 'idle', 'Nothing heard — try again');
        return;
      }
      insertIntoTextarea(text);
      setPhase(button, status, 'idle', `Inserted ${text.split(/\s+/).length} words`);
    } catch (error) {
      setPhase(button, status, 'error', error instanceof Error ? error.message : 'Transcription failed');
    }
  };

  button.addEventListener('click', () => {
    if (phase === 'recording') {
      void finishRecording();
      return;
    }
    if (phase === 'loading' || phase === 'transcribing') return;
    void startRecording();
  });
}
