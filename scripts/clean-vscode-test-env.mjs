import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolatedDir = path.join(rootDir, '.vscode-test', 'isolated');

fs.rmSync(isolatedDir, { recursive: true, force: true });
fs.mkdirSync(isolatedDir, { recursive: true });
