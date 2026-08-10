import { readFileSync, readdirSync } from 'node:fs';

const dir = 'src/content/digests';
let ok = true;
for (const f of readdirSync(dir)) {
  if (!f.endsWith('.md')) continue;
  const text = readFileSync(`${dir}/${f}`, 'utf8');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    console.error(`${f}: no frontmatter found`);
    ok = false;
    continue;
  }
  try {
    JSON.parse(match[1]);
    console.log(`${f}: OK`);
  } catch (e) {
    console.error(`${f}: INVALID JSON - ${e.message}`);
    ok = false;
  }
}
process.exit(ok ? 0 : 1);
