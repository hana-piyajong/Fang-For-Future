import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const appDirectory = join(root, 'app');
const iconDirectory = join(appDirectory, 'icons');
const outputDirectory = join(root, 'dist');
const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

async function inlineIcons(html) {
  const iconNames = new Set([...html.matchAll(/(?:src|href)="icons\/([^"]+)"/g)].map((match) => match[1]));
  const replacements = new Map();
  for (const name of iconNames) {
    const extension = extname(name).toLowerCase();
    const mimeType = mimeTypes[extension];
    if (!mimeType) throw new Error(`Unsupported icon format: ${name}`);
    const bytes = await readFile(join(iconDirectory, name));
    replacements.set(`icons/${name}`, `data:${mimeType};base64,${bytes.toString('base64')}`);
  }
  return [...replacements].reduce((page, [from, to]) => page.replaceAll(from, to), html);
}

const [html, workerTemplate, manifest] = await Promise.all([
  readFile(join(appDirectory, 'index.html'), 'utf8'),
  readFile(join(root, 'worker', 'template.js'), 'utf8'),
  readFile(join(root, '.openai', 'hosting.json'), 'utf8'),
]);
const inlinedPage = await inlineIcons(html);
const worker = workerTemplate.replace('__PAGE__', JSON.stringify(inlinedPage));
const hosting = JSON.parse(manifest);
delete hosting.static;

await mkdir(join(outputDirectory, 'server'), { recursive: true });
await mkdir(join(outputDirectory, '.openai'), { recursive: true });
await writeFile(join(outputDirectory, 'server', 'index.js'), worker);
await writeFile(join(outputDirectory, '.openai', 'hosting.json'), `${JSON.stringify(hosting, null, 2)}\n`);
