import { readFile } from 'node:fs/promises';

const worker = await readFile(new URL('../dist/server/index.js', import.meta.url), 'utf8');
if (!worker.includes('GEE_SERVICE_ACCOUNT_JSON')) throw new Error('Worker is missing the GEE secret binding.');
if (!worker.includes("url.pathname === '/api/ndvi'")) throw new Error('Worker is missing the NDVI endpoint.');
if (!worker.includes('OPENAI_API_KEY')) throw new Error('Worker is missing the OpenAI secret binding.');
if (!worker.includes("url.pathname === '/api/expert-chat'")) throw new Error('Worker is missing the expert chat endpoint.');
if (!worker.includes('data:image/png;base64')) throw new Error('Worker did not inline the app icons.');
console.log('Worker artifact is ready.');
