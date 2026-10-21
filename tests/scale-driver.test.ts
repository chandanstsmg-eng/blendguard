/**
 * METTLER TOLEDO MT-SICS: the reply parser, and the serial driver talking to a
 * pretend scale on a mock COM port (so it is proven before the hardware arrives).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { MockBinding, type MockPortBinding } from '@serialport/binding-mock';
import { parseSics, toMg } from '../server/scale/mtsics.js';
import { SicsScale, type DriverReading } from '../server/scale/sics-driver.js';

describe('MT-SICS replies', () => {
  it('converts weights to whole milligrams without floating point', () => {
    expect(toMg('123.45', 'g')).toBe(123_450);
    expect(toMg('0.001', 'g')).toBe(1);
    expect(toMg('-0.02', 'g')).toBe(-20);
    expect(toMg('1.25', 'kg')).toBe(1_250_000);
    expect(toMg('412.6', 'g')).toBe(412_600);
    expect(toMg('5', 'mg')).toBe(5);
    // 0.1 mg cannot be stored in whole mg, and pounds are not accepted.
    expect(toMg('0.0001', 'g')).toBeNull();
    expect(toMg('0.0010', 'g')).toBe(1);
    expect(toMg('1.00', 'lb')).toBeNull();
  });

  it('reads stable, moving, tare and fault replies', () => {
    expect(parseSics('S S      123.45 g')).toEqual({ kind: 'weight', stable: true, mg: 123_450 });
    expect(parseSics('S D      100.07 g')).toEqual({ kind: 'weight', stable: false, mg: 100_070 });
    expect(parseSics('S S     -  0.03 g')).toEqual({ kind: 'weight', stable: true, mg: -30 });
    expect(parseSics('SI S      12.00 g')).toEqual({ kind: 'weight', stable: true, mg: 12_000 });
    expect(parseSics('TA A      50.00 g')).toEqual({ kind: 'tare', mg: 50_000 });
    expect(parseSics('S +')).toEqual({ kind: 'overload' });
    expect(parseSics('S -')).toEqual({ kind: 'underload' });
    expect(parseSics('S I')).toEqual({ kind: 'busy' });
    expect(parseSics('ES').kind).toBe('error');
    expect(parseSics('S S      1.00 lb').kind).toBe('error');
    expect(parseSics('').kind).toBe('ignored');
  });
});

/** A pretend scale: answers each command with `reply(cmd)` (null = stay silent). */
function mockScale(reply: (cmd: string) => string | null) {
  MockBinding.reset();
  MockBinding.createPort('COM99', { echo: false });
  return {
    ...MockBinding,
    async open(opts: Parameters<typeof MockBinding.open>[0]) {
      const port: MockPortBinding = await MockBinding.open(opts);
      const write = port.write.bind(port);
      port.write = async (buf: Buffer) => {
        await write(buf);
        const answer = reply(buf.toString().trim());
        if (answer != null) setTimeout(() => port.emitData(Buffer.from(`${answer}\r\n`)), 2);
      };
      return port;
    },
  } as typeof MockBinding;
}

let driver: SicsScale | null = null;
afterEach(async () => {
  await driver?.stop();
  driver = null;
});

function start(reply: (cmd: string) => string | null) {
  driver = new SicsScale({ path: 'COM99', baudRate: 9600, binding: mockScale(reply) });
  const readings: DriverReading[] = [];
  driver.on('reading', (r: DriverReading) => readings.push(r));
  driver.start();
  return readings;
}

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('MT-SICS serial driver', () => {
  it('reports a stable gross weight', async () => {
    const r = start((cmd) => (cmd === 'SI' ? 'S S      123.45 g' : cmd === 'TA' ? 'TA A       0.00 g' : 'ES'));
    await until(() => r.length > 0);
    expect(r.at(-1)).toMatchObject({ connected: true, stable: true, grossMg: 123_450, fault: null });
  });

  it('reports a moving weight as not stable', async () => {
    const r = start((cmd) => (cmd === 'SI' ? 'S D      100.07 g' : 'TA A 0.00 g'));
    await until(() => r.length > 0);
    expect(r.at(-1)).toMatchObject({ connected: true, stable: false, grossMg: 100_070 });
  });

  it('adds back a tare taken on the scale itself, so pressing TARE cannot hide weight', async () => {
    const r = start((cmd) => (cmd === 'SI' ? 'S S       10.00 g' : 'TA A      50.00 g'));
    await until(() => r.length > 0);
    expect(r.at(-1)?.grossMg).toBe(60_000);
  });

  it('weighs on net weight when the scale cannot report its tare', async () => {
    const r = start((cmd) => (cmd === 'SI' ? 'S S       10.00 g' : 'ES'));
    await until(() => r.length > 1);
    expect(r.at(-1)?.grossMg).toBe(10_000);
  });

  it('gives no weight when the scale is over its range', async () => {
    const r = start((cmd) => (cmd === 'SI' ? 'S +' : 'TA A 0.00 g'));
    await until(() => r.length > 0);
    expect(r.at(-1)).toMatchObject({ connected: true, stable: false, grossMg: null, fault: 'OVERLOAD' });
  });

  it('turns "not connected" when the scale stops answering', async () => {
    let silent = false;
    const r = start((cmd) => (silent ? null : cmd === 'SI' ? 'S S 5.00 g' : 'TA A 0.00 g'));
    await until(() => r.some((x) => x.connected));
    silent = true;
    await until(() => r.at(-1)?.connected === false, 6000);
    expect(r.at(-1)).toMatchObject({ connected: false, grossMg: null, fault: 'NO_REPLY' });
  }, 10_000);
});
