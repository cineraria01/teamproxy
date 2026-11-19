// A stand-in for schtasks.exe (src/win32.js runs it with node when TEAMPROXY_WIN_SCHTASKS points here, under
// node --test only). Tasks are files <FAKE_SCHTASKS_DIR>/tasks/<name>.xml; every call is appended to calls.log.
// FAKE_SCHTASKS_DENY=1 makes /Create fail like a missing right does.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_SCHTASKS_DIR;
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.log'), `${JSON.stringify(args)}\n`);
const name = args[args.indexOf('/TN') + 1];
const file = join(dir, 'tasks', `${name}.xml`);
const verb = args[0];
if (verb === '/Query') {
  if (!existsSync(file)) { console.error(`ERROR: The system cannot find the file specified.`); process.exit(1); }
  if (args.includes('/XML')) process.stdout.write(readFileSync(file));
} else if (verb === '/Create') {
  if (process.env.FAKE_SCHTASKS_DENY === '1') { console.error('ERROR: Access is denied.'); process.exit(1); }
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  copyFileSync(args[args.indexOf('/XML') + 1], file);
  console.log(`SUCCESS: The scheduled task "${name}" has successfully been created.`);
} else if (verb === '/Run' || verb === '/End') {
  if (!existsSync(file)) process.exit(1);
} else {
  process.exit(1);
}
