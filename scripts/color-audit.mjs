#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOKEN_FILES = new Set(['src/styles/cu-tokens.css']);

const COLOR = /(?<![\w-])#[0-9a-fA-F]{3,8}(?![\w-])|\b(?:rgba?|hsla?)\(/g;

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function styleRanges(vue) {
  const out = [];
  const re = /<style\b[^>]*>([\s\S]*?)<\/style>/g;
  let m;
  while ((m = re.exec(vue))) out.push({ start: m.index + m[0].indexOf('>') + 1, text: m[1] });
  return out;
}

export function auditCss(css, lineOffset = 0) {
  const hits = [];
  const lines = stripComments(css).split('\n');
  lines.forEach((line, i) => {
    if (/^\s*[^:{}]*\{\s*$/.test(line)) return;
    COLOR.lastIndex = 0;
    if (COLOR.test(line)) hits.push({ line: lineOffset + i + 1, text: line.trim() });
  });
  return hits;
}

export function auditVue(vue) {
  const hits = [];
  for (const { start, text } of styleRanges(vue)) {
    const offset = vue.slice(0, start).split('\n').length - 1;
    hits.push(...auditCss(text, offset));
  }
  return hits;
}

function walk(target, out) {
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const name of readdirSync(target)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      walk(path.join(target, name), out);
    }
  } else if (/\.(vue|css)$/.test(target)) {
    out.push(target);
  }
  return out;
}

export function auditPaths(targets, root = process.cwd()) {
  const report = [];
  for (const target of targets) {
    for (const file of walk(path.resolve(root, target), [])) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (TOKEN_FILES.has(rel)) continue;
      const text = readFileSync(file, 'utf8');
      const hits = file.endsWith('.vue') ? auditVue(text) : auditCss(text);
      if (hits.length) report.push({ file: rel, hits });
    }
  }
  return report;
}

function main(argv) {
  const targets = argv.length ? argv : ['src'];
  const report = auditPaths(targets);
  let total = 0;
  for (const { file, hits } of report) {
    total += hits.length;
    for (const h of hits) console.log(`${file}:${h.line}: ${h.text}`);
  }
  for (const { file, hits } of report) console.log(`${String(hits.length).padStart(5)}  ${file}`);
  console.log(`total: ${total} line(s) with literal colors in ${report.length} file(s)`);
  return total === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
