// ─── Engine shims for pdfjs ──────────────────────────────────────
//
// pdfjs-dist 6.3 uses several built-ins without a feature check, all of
// which landed *after* the engine floor this app advertises
// (src/pdf-capability.ts: Chrome 128+). On an engine between 128 and the
// release that shipped them, PDF import — the reader's headline format —
// dies with an error that names nothing the user can act on:
//
//   "hashOriginal.toHex is not a function"      (Uint8Array hex)
//   "this[#methodPromises].getOrInsertComputed" (Map/Set upsert)
//
// Promise.try is deliberately *not* shimmed: that one is the documented
// engine gate, and it is the reason MIN_PDF_ENGINE_CHROME exists.
//
// One implementation, two consumers:
//   • the main thread imports it from src/document-reader.ts;
//   • scripts/copy-pdf-worker.mjs copies it to public/ and prepends an
//     import to the pdfjs worker bundle, because a worker has its own
//     global scope and cannot inherit anything patched here.
//
// Every definition is conditional: on a current engine this file is a
// no-op and the native (spec-compliant, faster) methods stay in charge.

const mapUpsert = function (key, value) {
  if (this.has(key)) return this.get(key);
  this.set(key, value);
  return value;
};

const mapUpsertComputed = function (key, callback) {
  if (this.has(key)) return this.get(key);
  // Computed before the insert, and a throwing callback must leave the map
  // untouched — both per spec.
  const computed = callback(key);
  this.set(key, computed);
  return computed;
};

const setUpsert = function (value) {
  if (this.has(value)) return this;
  this.add(value);
  return this;
};

const setUpsertComputed = function (callback) {
  if (this.has(callback)) return this;
  this.add(callback);
  return this;
};

const HEX_DIGITS = '0123456789abcdef';

for (const [Ctor, plain, computed] of [
  [globalThis.Map, mapUpsert, mapUpsertComputed],
  [globalThis.Set, setUpsert, setUpsertComputed],
]) {
  const proto = Ctor.prototype;
  if (typeof proto.getOrInsert !== 'function') {
    Object.defineProperty(proto, 'getOrInsert', {
      value: plain, writable: true, configurable: true,
    });
  }
  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      value: computed, writable: true, configurable: true,
    });
  }
}

if (typeof globalThis.Uint8Array !== 'undefined') {
  const bytes = globalThis.Uint8Array;
  const proto = bytes.prototype;

  if (typeof proto.toHex !== 'function') {
    Object.defineProperty(proto, 'toHex', {
      // Built from a digit table and appended per byte: no argument-count
      // limit to worry about, and no chance of a two-character hex pair
      // being truncated to one character on the way through.
      value: function toHex() {
        const parts = [];
        for (let start = 0; start < this.length; start += 0x8000) {
          const end = Math.min(start + 0x8000, this.length);
          let hex = '';
          for (let i = start; i < end; i++) {
            const byte = this[i];
            hex += HEX_DIGITS[byte >> 4] + HEX_DIGITS[byte & 0xf];
          }
          parts.push(hex);
        }
        return parts.join('');
      },
      writable: true, configurable: true,
    });
  }

  if (typeof bytes.fromHex !== 'function') {
    Object.defineProperty(bytes, 'fromHex', {
      value: function fromHex(string) {
        if (string.length % 2 !== 0) {
          throw new SyntaxError('String is an odd length');
        }
        if (/[^0-9a-fA-F]/.test(string)) {
          throw new SyntaxError('String contains non-hexadecimal characters');
        }
        const out = new Uint8Array(string.length / 2);
        for (let i = 0; i < out.length; i++) {
          out[i] = parseInt(string.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
      },
      writable: true, configurable: true,
    });
  }

  if (typeof proto.toBase64 !== 'function') {
    Object.defineProperty(proto, 'toBase64', {
      value: function toBase64() {
        let binary = '';
        for (let i = 0; i < this.length; i += 0x8000) {
          binary += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      },
      writable: true, configurable: true,
    });
  }

  if (typeof bytes.fromBase64 !== 'function') {
    Object.defineProperty(bytes, 'fromBase64', {
      value: function fromBase64(string) {
        const binary = atob(string);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          out[i] = binary.charCodeAt(i);
        }
        return out;
      },
      writable: true, configurable: true,
    });
  }
}
