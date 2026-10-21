/** Stops the built-in database if it was left running (e.g. after a crash). */
import { stopDatabase } from '../server/db/postgres.js';

await stopDatabase();
console.log('  Database stopped.');
