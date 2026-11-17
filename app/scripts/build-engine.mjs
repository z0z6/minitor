// Buduje www/engine.js (silnik z ../src dla przeglądarki), www/capacitor.js (wtyczki Androida) i kopiuje font Inter.
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const www = path.join(root, 'www');
const common = {
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['chrome110'],
  nodePaths: [path.join(root, 'node_modules')],
  logLevel: 'warning',
  legalComments: 'none',
};

await build({
  ...common,
  entryPoints: [path.join(root, 'engine', 'entry.js')],
  outfile: path.join(www, 'engine.js'),
  globalName: 'Engine',
  banner: { js: '/* Monitor prawa: silnik (wygenerowano z ../src, nie edytuj ręcznie) */' },
  minifySyntax: true,
});

await build({
  ...common,
  entryPoints: [path.join(root, 'engine', 'capacitor-entry.js')],
  outfile: path.join(www, 'capacitor.js'),
  globalName: 'Cap',
  minify: true,
  banner: { js: '/* Monitor prawa: wtyczki Capacitor (wygenerowano, nie edytuj ręcznie) */' },
});

mkdirSync(path.join(www, 'fonts'), { recursive: true });
for (const f of ['inter-latin-ext-wght-normal.woff2', 'inter-latin-wght-normal.woff2']) {
  copyFileSync(path.join(root, 'node_modules', '@fontsource-variable', 'inter', 'files', f), path.join(www, 'fonts', f));
}
console.log('Zbudowano www/engine.js i www/capacitor.js');
