import { cpSync, mkdirSync } from 'node:fs';

const from = new URL('../src/cloud/ui/public/', import.meta.url);
const to = new URL('../dist/cloud/ui/public/', import.meta.url);

mkdirSync(to, { recursive: true });
cpSync(from, to, { recursive: true });
console.log('Copied UI assets to dist/cloud/ui/public');
