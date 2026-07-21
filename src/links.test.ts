/**
 * Link-regression test: every model in MODELS must point to a real HuggingFace
 * asset. The app 404s at runtime if a model file is missing, and the UI can't
 * tell the difference between a slow download and a dead URL until minutes
 * in — so we catch this at build/test time.
 *
 * Skipped automatically when the test environment has no network (CI sandboxes,
 * offline devs). To force a run even offline, set YAPPER_LINK_CHECK=1.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { MODELS } from './engine';

const NETWORK_TIMEOUT_MS = 15_000;

interface Probe { ok: boolean; status: number; reason: string; url: string; }

async function probe(url: string): Promise<Probe> {
  // Use a tiny range request so we don't have to download the full file
  // just to check it exists.
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    return { ok: res.ok, status: res.status, reason: res.statusText, url };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, reason: msg, url };
  }
}

describe('MODELS registry link health', () => {
  let networkAvailable = true;
  let skipReason = '';

  beforeAll(async () => {
    if (process.env.YAPPER_LINK_CHECK === '1') return;
    // Probe HuggingFace once — if this fails we mark the suite as skipped.
    try {
      const res = await fetch('https://huggingface.co/api/models/Xenova/mms-tts-eng', {
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok && res.status !== 401) {
        networkAvailable = false;
        skipReason = `HF probe returned ${res.status}`;
      }
    } catch (e) {
      networkAvailable = false;
      skipReason = e instanceof Error ? e.message : String(e);
    }
  });

  it.skipIf(!networkAvailable)('every model in the registry has a live HF endpoint', async () => {
    if (!networkAvailable) {
      // unreachable: it.skipIf already handled this
      return;
    }
    if (skipReason) {
      console.warn(`[links] network probe inconclusive: ${skipReason}`);
    }

    const probes: Probe[] = [];
    for (const m of MODELS) {
      // For custom models (Kokoro/Kitten/MMS/SpeechT5) the registry's
      // modelId is the repo, and the actual asset is one of several known
      // files inside the repo. Check the repo root resolves; for models
      // with a modelFile we can also confirm the specific asset path.
      probes.push(await probe(`https://huggingface.co/${m.modelId}`));
      if (m.modelFile) {
        probes.push(await probe(`https://huggingface.co/${m.modelId}/resolve/main/${m.modelFile}`));
      }
    }

    const failures = probes.filter(p => !p.ok);
    if (failures.length) {
      const summary = failures
        .map(f => `  ${f.status} ${f.url} — ${f.reason}`)
        .join('\n');
      throw new Error(
        `${failures.length} model link(s) broken:\n${summary}\n` +
        `If a model was renamed or removed upstream, either update the ` +
        `MODELS entry in src/engine.ts or remove it from the registry.`
      );
    }
    expect(probes.length).toBeGreaterThan(0);
  }, NETWORK_TIMEOUT_MS * MODELS.length + 5_000);
});

describe('UI language filter matches registry', () => {
  // The static <option> list in src/main.ts must only contain languages for
  // which a model exists in MODELS. If you add a model with a new language,
  // add the option to main.ts; if you remove one, remove the option too.
  it('contains only languages present in the registry', () => {
    const registryLangs = new Set(
      MODELS.map(m => m.language).filter((l): l is string => !!l),
    );
    // Static option values extracted from src/main.ts. If you change the UI,
    // update this list to match. (Duplicated here to avoid spinning up the
    // full DOM tree just for an assertion.)
    const uiOptions = ['en', 'es', 'fr', 'de', 'pt', 'ru', 'ko', 'hi', 'ar'];
    const orphans = uiOptions.filter(l => !registryLangs.has(l));
    expect(orphans, `UI lists languages not in MODELS registry: ${orphans.join(', ')}`).toEqual([]);
    const missing = [...registryLangs].filter(l => !uiOptions.includes(l));
    if (missing.length) {
      // Not a hard failure — the UI could simply hide the filter — but flag it.
      console.warn(`[registry] models exist for languages not in the UI filter: ${missing.join(', ')}`);
    }
  });
});