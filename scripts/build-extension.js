import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const target = join(root, 'browser-extension', 'shared');
await mkdir(target, { recursive: true });
await copyFile(join(root, 'src', 'extract.js'), join(target, 'extract.js'));
await copyFile(join(root, 'src', 'login-dom.js'), join(target, 'login-dom.js'));
console.log('Edge collector built in browser-extension.');
