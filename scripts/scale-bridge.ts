/**
 * BlendGuard scale bridge. Runs on a STATION PC whose METTLER TOLEDO scale is
 * plugged into that PC (USB → COM port), and streams the scale's readings to the
 * BlendGuard server over the plant network.
 *
 *   npx tsx scripts/scale-bridge.ts --server http://192.168.1.20:4300 --station ST-01 --key <bridge key>
 *   npx tsx scripts/scale-bridge.ts --list        (shows the COM ports on this PC)
 *
 * The COM port, baud rate and data format are set on the server (Setup → Station setup
 * → Scale), so nothing else needs configuring here. START-SCALE-BRIDGE.bat holds
 * these three values and restarts the bridge if it ever stops.
 */
import { io } from 'socket.io-client';
import { SerialPort } from 'serialport';
import { SicsScale, type DriverReading } from '../server/scale/sics-driver.js';

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : process.env[`BRIDGE_${name.toUpperCase()}`];
}

const log = (msg: string) => console.log(`${new Date().toLocaleTimeString()}  ${msg}`);

async function listPorts() {
  const ports = await SerialPort.list();
  if (!ports.length) return console.log('\n  No COM ports found. Is the scale plugged in and its USB driver installed?\n');
  console.log('\n  COM ports on this PC:\n');
  for (const p of ports) console.log(`    ${p.path.padEnd(7)} ${(p as { friendlyName?: string }).friendlyName ?? p.manufacturer ?? ''}`);
  console.log('\n  Enter the scale\'s port in BlendGuard: Setup → Station setup → Scale.\n');
}

async function main() {
  if (process.argv.includes('--list')) return listPorts();
  const server = arg('server');
  const station = arg('station');
  const key = arg('key');
  if (!server || !station || !key) {
    console.error('\n  Missing settings. Usage:\n    scale-bridge --server http://<server-ip>:4300 --station ST-01 --key <bridge key>\n');
    process.exitCode = 1;
    return;
  }

  let driver: SicsScale | null = null;
  let current = '';
  let lastFault: string | null = 'start';
  const socket = io(`${server.replace(/\/+$/, '')}/bridge`, { auth: { station, key }, reconnectionDelay: 2000, reconnectionDelayMax: 10_000 });

  const send = (r: DriverReading) => {
    if (r.fault !== lastFault) {
      log(r.fault ? `Scale: ${r.fault.replace('_', ' ').toLowerCase()}` : 'Scale answering');
      lastFault = r.fault;
    }
    if (socket.connected) socket.emit('reading', { connected: r.connected, stable: r.stable, grossMg: r.grossMg, fault: r.fault });
  };

  socket.on('connect', () => log(`Connected to BlendGuard at ${server} as ${station}`));
  socket.on('disconnect', (why) => log(`Lost the BlendGuard server (${why}). Reconnecting…`));
  let lastErr = '';
  socket.on('connect_error', (err) => {
    if (err.message !== lastErr) log(`Cannot connect: ${err.message}`);
    lastErr = err.message;
  });
  socket.on('config', async (c: { station: string; name: string; port: string | null; baudRate: number; framing: string }) => {
    const next = `${c.port}|${c.baudRate}|${c.framing}`;
    if (next === current) return;
    current = next;
    await driver?.stop();
    driver = null;
    if (!c.port) return log(`${c.name}: no COM port set yet. Set it in Setup → Station setup → Scale.`);
    log(`${c.name}: reading the scale on ${c.port} at ${c.baudRate} baud (${c.framing})`);
    lastFault = 'start';
    driver = new SicsScale({ path: c.port, baudRate: c.baudRate, framing: c.framing });
    let lastPortErr = '';
    driver.on('reading', send);
    driver.on('port-error', (err: Error) => {
      if (err.message !== lastPortErr) log(`${c.port}: ${err.message}`);
      lastPortErr = err.message;
    });
    driver.on('no-tare', () => log('The scale does not report its tare. Lock the TARE key on the scale.'));
    driver.start();
  });

  const stop = async () => {
    log('Stopping…');
    socket.close();
    await driver?.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

void main();
