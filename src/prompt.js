import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { stdin, stdout } from 'node:process';

export async function promptPassword({ input = stdin, output = stdout } = {}) {
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Password entry requires an interactive terminal.');
  }
  const muted = new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  });
  const terminal = createInterface({ input, output: muted, terminal: true, historySize: 0 });
  output.write('Password (hidden): ');
  try {
    return await new Promise((resolve, reject) => {
      terminal.once('SIGINT', () => reject(new Error('Credential entry cancelled.')));
      terminal.once('close', () => reject(new Error('Credential entry ended before completion.')));
      terminal.question('').then(resolve, reject);
    });
  } finally {
    terminal.close();
    muted.end();
    output.write('\n');
  }
}
