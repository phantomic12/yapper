import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from './events';

describe('EventEmitter', () => {
  it('calls registered listeners with the emitted args', () => {
    type Ev = { ping: (n: number) => void };
    const e = new EventEmitter<Ev>();
    const fn = vi.fn();
    e.on('ping', fn);
    e.emit('ping', 42);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it('returns an unsubscribe function from on()', () => {
    type Ev = { ping: () => void };
    const e = new EventEmitter<Ev>();
    const fn = vi.fn();
    const off = e.on('ping', fn);
    e.emit('ping');
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    e.emit('ping');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('supports multiple listeners on the same event', () => {
    type Ev = { tick: () => void };
    const e = new EventEmitter<Ev>();
    const a = vi.fn();
    const b = vi.fn();
    e.on('tick', a);
    e.on('tick', b);
    e.emit('tick');
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('off() removes a single listener', () => {
    type Ev = { tick: () => void };
    const e = new EventEmitter<Ev>();
    const a = vi.fn();
    const b = vi.fn();
    e.on('tick', a);
    e.on('tick', b);
    e.off('tick', a);
    e.emit('tick');
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing listener from others', () => {
    type Ev = { tick: () => void };
    const e = new EventEmitter<Ev>();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const good = vi.fn();
    e.on('tick', () => { throw new Error('boom'); });
    e.on('tick', good);
    e.emit('tick');
    expect(good).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it('does not call listeners added during an emit (snapshot iteration)', () => {
    type Ev = { tick: () => void };
    const e = new EventEmitter<Ev>();
    const sneaky = vi.fn();
    e.on('tick', () => e.on('tick', sneaky));
    e.emit('tick');
    expect(sneaky).not.toHaveBeenCalled();
  });

  it('removeAllListeners clears every registration', () => {
    type Ev = { a: () => void; b: () => void };
    const e = new EventEmitter<Ev>();
    const a = vi.fn();
    const b = vi.fn();
    e.on('a', a);
    e.on('b', b);
    e.removeAllListeners();
    e.emit('a');
    e.emit('b');
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('emitting an event with no listeners is a no-op', () => {
    type Ev = { ping: () => void };
    const e = new EventEmitter<Ev>();
    expect(() => e.emit('ping')).not.toThrow();
  });
});