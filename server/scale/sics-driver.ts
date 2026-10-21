/**
 * Reads a METTLER TOLEDO scale over a serial (COM) port with MT-SICS.
 * RS-485 and RS-232 scales both appear as a COM port through their USB adapter.
 *
 * One request at a time (RS-485 is half duplex): SI about six times a second,
 * TA about once a second. Every reply is passed on as a reading; if the scale
 * stops answering, the reading turns "not connected" and weighing is blocked
 * until it answers again. The port is reopened by itself after a fault.
 */
import { EventEmitter } from 'node:events';
import { SerialPort } from 'serialport';
import { SerialPortStream } from '@serialport/stream';
import { ReadlineParser } from '@serialport/parser-readline';
import { parseSics } from './mtsics.js';
import type { ScaleFault } from '../../shared/types.js';

export interface SicsOptions {
  path: string;
  baudRate: number;
  /** "8N1" (default), "7E1", "7O1", "8E1" … */
  framing?: string;
  /** Tests only: a mock serial binding instead of the real COM port. */
  binding?: ConstructorParameters<typeof SerialPortStream>[0]['binding'];
}

export interface DriverReading {
  connected: boolean;
  stable: boolean;
  /** Gross weight in mg (net shown on the scale + the scale's own tare), or null if unknown. */
  grossMg: number | null;
  at: number;
  fault: ScaleFault | null;
}

const POLL_MS = 150;
const REPLY_TIMEOUT_MS = 800;
const TARE_EVERY = 6;
const REOPEN_MS = 3000;
/** Consecutive missing replies before the scale counts as disconnected. */
const MISSES_ALLOWED = 2;

export function parseFraming(f = '8N1') {
  const m = /^([78])([NEO])([12])$/i.exec(f.trim());
  if (!m) return { dataBits: 8 as const, parity: 'none' as const, stopBits: 1 as const };
  return {
    dataBits: Number(m[1]) as 7 | 8,
    parity: ({ N: 'none', E: 'even', O: 'odd' } as const)[m[2].toUpperCase() as 'N' | 'E' | 'O'],
    stopBits: Number(m[3]) as 1 | 2,
  };
}

/** Emits 'reading' (DriverReading) after every poll. */
export class SicsScale extends EventEmitter {
  private port: SerialPortStream | null = null;
  private pending: { resolve: (line: string | null) => void; timer: NodeJS.Timeout } | null = null;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private tareMg = 0;
  /** False once the scale answers TA with an error: it has no tare to read. */
  private tareSupported = true;
  private misses = 0;
  private last: DriverReading = { connected: false, stable: false, grossMg: null, at: Date.now(), fault: 'NO_PORT' };

  constructor(private opts: SicsOptions) {
    super();
  }

  get reading() {
    return this.last;
  }

  start() {
    this.stopped = false;
    this.loop ??= this.run().finally(() => (this.loop = null));
  }

  async stop() {
    this.stopped = true;
    this.answer(null);
    await this.close();
    await this.loop;
  }

  private publish(r: Omit<DriverReading, 'at'>) {
    this.last = { ...r, at: Date.now() };
    this.emit('reading', this.last);
  }

  private async run() {
    while (!this.stopped) {
      try {
        await this.open();
        this.misses = 0;
        let n = 0;
        while (!this.stopped && this.port?.isOpen) {
          if (this.tareSupported && n % TARE_EVERY === 0) await this.readTare();
          await this.readWeight();
          n++;
          await sleep(POLL_MS);
        }
      } catch (err) {
        this.publish({ connected: false, stable: false, grossMg: null, fault: 'NO_PORT' });
        this.emit('port-error', err);
      }
      await this.close();
      if (!this.stopped) await sleep(REOPEN_MS);
    }
  }

  private async readTare() {
    const line = await this.ask('TA');
    if (line == null) return;
    const r = parseSics(line);
    if (r.kind === 'tare') this.tareMg = r.mg;
    else if (r.kind === 'error') {
      // Scale cannot report its tare: weigh on net only (the scale's TARE key must be locked).
      this.tareSupported = false;
      this.tareMg = 0;
      this.emit('no-tare', line);
    }
  }

  private async readWeight() {
    const line = await this.ask('SI');
    if (line == null) {
      if (++this.misses > MISSES_ALLOWED) this.publish({ connected: false, stable: false, grossMg: null, fault: 'NO_REPLY' });
      return;
    }
    this.misses = 0;
    const r = parseSics(line);
    switch (r.kind) {
      case 'weight':
        return this.publish({ connected: true, stable: r.stable, grossMg: r.mg + this.tareMg, fault: null });
      case 'overload':
        return this.publish({ connected: true, stable: false, grossMg: null, fault: 'OVERLOAD' });
      case 'underload':
        return this.publish({ connected: true, stable: false, grossMg: null, fault: 'UNDERLOAD' });
      case 'busy':
        return this.publish({ connected: true, stable: false, grossMg: null, fault: 'BUSY' });
      default:
        return this.publish({ connected: true, stable: false, grossMg: null, fault: 'BAD_REPLY' });
    }
  }

  private open() {
    return new Promise<void>((resolve, reject) => {
      const settings = { path: this.opts.path, baudRate: this.opts.baudRate, ...parseFraming(this.opts.framing), autoOpen: false };
      const port = this.opts.binding ? new SerialPortStream({ ...settings, binding: this.opts.binding }) : new SerialPort(settings);
      const parser = port.pipe(new ReadlineParser({ delimiter: '\n' }));
      parser.on('data', (line: string) => this.answer(line.replace(/\r$/, '')));
      port.on('close', () => this.answer(null));
      port.on('error', (err) => this.emit('port-error', err));
      port.open((err) => {
        if (err) return reject(err);
        this.port = port;
        resolve();
      });
    });
  }

  private close() {
    const port = this.port;
    this.port = null;
    if (!port?.isOpen) return Promise.resolve();
    return new Promise<void>((resolve) => port.close(() => resolve()));
  }

  /** Sends one command and waits for one reply line (null on timeout or port loss). */
  private ask(cmd: string) {
    return new Promise<string | null>((resolve) => {
      if (!this.port?.isOpen) return resolve(null);
      const timer = setTimeout(() => this.answer(null), REPLY_TIMEOUT_MS);
      this.pending = { resolve, timer };
      this.port.write(`${cmd}\r\n`, (err) => err && this.answer(null));
    });
  }

  private answer(line: string | null) {
    const p = this.pending;
    if (!p) return; // unrequested line (e.g. a print key press): ignore
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(line);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
