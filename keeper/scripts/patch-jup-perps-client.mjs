import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const generatedDir = join(process.cwd(), 'node_modules', 'jup-perps-client', 'dist', 'generated');
const barrelFiles = [
  join(generatedDir, 'index.js'),
  join(generatedDir, 'accounts', 'index.js'),
  join(generatedDir, 'errors', 'index.js'),
  join(generatedDir, 'instructions', 'index.js'),
  join(generatedDir, 'programs', 'index.js'),
  join(generatedDir, 'types', 'index.js'),
];

function patchBarrel(file) {
  if (!existsSync(file)) return;

  const original = readFileSync(file, 'utf8');
  const patched = original.replace(/from '(\.|\.\.|\.\/[^']+|\.\.\/[^']+)'/g, (match, specifier) => {
    if (specifier.endsWith('.js') || specifier.endsWith('.json') || specifier.endsWith('.node')) {
      return match;
    }

    if (specifier === '.' || specifier === '..') {
      return `from '${specifier}/index.js'`;
    }

    const targetDir = join(file, '..', specifier);
    const targetFile = join(file, '..', `${specifier}.js`);

    if (existsSync(targetDir)) {
      return `from '${specifier}/index.js'`;
    }

    if (existsSync(targetFile)) {
      return `from '${specifier}.js'`;
    }

    return match;
  });

  if (patched !== original) {
    writeFileSync(file, patched);
  }
}

for (const file of barrelFiles) {
  patchBarrel(file);
}

if (existsSync(generatedDir)) {
  for (const folder of ['accounts', 'errors', 'instructions', 'programs', 'types']) {
    const folderPath = join(generatedDir, folder);
    if (!existsSync(folderPath)) continue;
    for (const entry of readdirSync(folderPath)) {
      if (entry.endsWith('.js')) {
        patchBarrel(join(folderPath, entry));
      }
    }
  }
}

console.log('patched jup-perps-client ESM imports');
