import { describe, it, expect } from 'vitest';
import { ByteWriter, ByteReader } from '@dagsocial/wire';

describe('ByteWriter', () => {
  it('writes bytes and produces output', () => {
    const w = new ByteWriter();
    w.writeU8(0xab);
    w.writeU8(0xcd);
    expect(w.length).toBe(2);
    expect(w.toBytes()).toEqual(new Uint8Array([0xab, 0xcd]));
  });

  it('writeBool', () => {
    const w = new ByteWriter();
    w.writeBool(true);
    w.writeBool(false);
    expect(w.toBytes()).toEqual(new Uint8Array([1, 0]));
  });

  it('writeVlqU round-trips through ByteReader', () => {
    const w = new ByteWriter();
    w.writeVlqU(0);
    w.writeVlqU(127);
    w.writeVlqU(128);
    w.writeVlqU(16383);
    w.writeVlqU(1_000_000);

    const r = new ByteReader(w.toBytes());
    expect(r.readVlqU()).toBe(0);
    expect(r.readVlqU()).toBe(127);
    expect(r.readVlqU()).toBe(128);
    expect(r.readVlqU()).toBe(16383);
    expect(r.readVlqU()).toBe(1_000_000);
    expect(r.isExhausted).toBe(true);
  });

  it('writeVlqS round-trips through ByteReader', () => {
    const w = new ByteWriter();
    w.writeVlqS(0);
    w.writeVlqS(-1);
    w.writeVlqS(1);
    w.writeVlqS(-1000);

    const r = new ByteReader(w.toBytes());
    expect(r.readVlqS()).toBe(0);
    expect(r.readVlqS()).toBe(-1);
    expect(r.readVlqS()).toBe(1);
    expect(r.readVlqS()).toBe(-1000);
  });

  it('writeArray', () => {
    const w = new ByteWriter();
    w.writeArray([10, 20, 30], (wr, v) => wr.writeU8(v));

    const r = new ByteReader(w.toBytes());
    const arr = r.readArray((rr) => rr.readU8());
    expect(arr).toEqual([10, 20, 30]);
  });

  it('writeOption null', () => {
    const w = new ByteWriter();
    w.writeOption<number>(null, (wr, v) => wr.writeVlqU(v));
    expect(w.toBytes()).toEqual(new Uint8Array([0]));
  });

  it('writeOption some', () => {
    const w = new ByteWriter();
    w.writeOption(42, (wr, v) => wr.writeVlqU(v));

    const r = new ByteReader(w.toBytes());
    const opt = r.readOption((rr) => rr.readVlqU());
    expect(opt).toBe(42);
  });

  it('rejects out-of-range byte', () => {
    const w = new ByteWriter();
    expect(() => w.writeU8(256)).toThrow();
    expect(() => w.writeU8(-1)).toThrow();
  });
});
