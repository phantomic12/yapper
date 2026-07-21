/**
 * Tiny typed event emitter. Used by `TTSEngine` to publish job and engine
 * lifecycle events without exposing the implementation detail of a mutable
 * callbacks bag (which the old `subscribe()` in `DocumentReaderSession`
 * monkey-patched directly, causing leaks when multiple sessions overlapped).
 *
 * Consumers receive an `unsubscribe` function from `on()` and are expected
 * to call it on cleanup. Throwing from a listener does not affect other
 * listeners or the emitter itself.
 */

export type EventName = string;
export type Listener = (...args: unknown[]) => void;

// Each event name maps to a Listener. Use `keyof Events` to require that
// every property of the event map is itself a Listener.
export type EventMap = Record<string, Listener>;

export class EventEmitter<Events extends Record<string, Listener>> {
  private listeners = new Map<keyof Events, Set<Listener>>();

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(fn as Listener);
    // Return an unsubscribe function bound to THIS specific registration.
    // Using a closure rather than `off(event, fn)` guards against the
    // consumer calling unsubscribe after the engine has already torn down.
    return () => {
      const s = this.listeners.get(event);
      if (s) {
        s.delete(fn as Listener);
        if (s.size === 0) this.listeners.delete(event);
      }
    };
  }

  off<K extends keyof Events>(event: K, fn: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(fn as Listener);
    if (set.size === 0) this.listeners.delete(event);
  }

  removeAllListeners(): void {
    this.listeners.clear();
  }

  protected emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    const set = this.listeners.get(event);
    if (!set) return;
    // Copy to a snapshot so listeners added/removed during iteration don't
    // affect this emission.
    for (const fn of [...set]) {
      try {
        (fn as Listener)(...args);
      } catch (err) {
        // Don't let one bad listener take down the whole engine. We log
        // to console rather than swallow silently — if a listener throws
        // it's almost always a bug worth surfacing.
        console.error(`[EventEmitter] listener for "${String(event)}" threw:`, err);
      }
    }
  }
}