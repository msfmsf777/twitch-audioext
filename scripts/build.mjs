import { build } from 'esbuild';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const srcDir = path.join(rootDir, 'src');
const outDir = path.join(rootDir, 'dist');

async function clean() {
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(outDir, { recursive: true });
}

async function bundle() {
  await build({
    entryPoints: {
      'background': path.join(srcDir, 'background/index.ts'),
      'content': path.join(srcDir, 'content/index.ts'),
      'popup/index': path.join(srcDir, 'popup/index.ts')
    },
    outdir: outDir,
    bundle: true,
    minify: false,
    sourcemap: true,
    target: ['chrome116'],
    format: 'esm',
    logLevel: 'info',
    loader: {
      '.json': 'json'
    }
  });
}

async function copyStatic() {
  const filesToCopy = [
    ['manifest.json', 'manifest.json']
  ];

  for (const [from, to] of filesToCopy) {
    const srcPath = path.join(srcDir, from);
    const destPath = path.join(outDir, to);
    await fs.copyFile(srcPath, destPath);
  }

  await fs.mkdir(path.join(outDir, 'popup'), { recursive: true });
  await fs.copyFile(path.join(srcDir, 'popup/index.html'), path.join(outDir, 'popup/index.html'));
  await fs.copyFile(path.join(srcDir, 'popup/styles/main.css'), path.join(outDir, 'popup/styles.css'));
}

async function copyLocales() {
  const localesSrc = path.join(srcDir, 'locales');
  const localesDest = path.join(outDir, 'locales');
  await fs.mkdir(localesDest, { recursive: true });
  const files = await fs.readdir(localesSrc);
  const manifest = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const srcPath = path.join(localesSrc, file);
    const destPath = path.join(localesDest, file);
    const raw = await fs.readFile(srcPath, 'utf8');
    await fs.writeFile(destPath, raw);
    try {
      const parsed = JSON.parse(raw);
      manifest.push({
        code: path.basename(file, '.json'),
        name: parsed?._meta?.name ?? path.basename(file, '.json')
      });
    } catch (error) {
      console.warn(`Failed to parse locale ${file}:`, error);
    }
  }

  await fs.writeFile(path.join(localesDest, 'index.json'), JSON.stringify(manifest, null, 2));
}

async function run() {
  await clean();
  await Promise.all([bundle(), copyStatic(), copyLocales()]);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
