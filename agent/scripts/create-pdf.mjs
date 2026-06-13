#!/usr/bin/env node

/**
 * create-pdf — Convert Markdown, HTML files, or URLs to PDF using Playwright + Chromium.
 *
 * Usage:
 *   create-pdf --input <file>    [--output <path>]   Convert a .md or .html file to PDF
 *   create-pdf --url <url>       [--output <path>]   Render a URL to PDF
 *   create-pdf --format markdown [--output <path>]   Read Markdown from stdin
 *
 * Output defaults to input filename with .pdf extension, or /workspace/data/project/output.pdf for stdin/URL.
 */

import { readFileSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import { chromium } from 'playwright';

const DEFAULT_OUTPUT_DIR = '/workspace/data/project';

const STYLESHEET = `
  :root {
    --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    --font-mono: "JetBrains Mono", "Fira Code", "SF Mono", Menlo, Consolas, monospace;
    --color-text: #1a1a1a;
    --color-muted: #555;
    --color-border: #e0e0e0;
    --color-bg-code: #f5f5f5;
  }

  * { box-sizing: border-box; }

  body {
    font-family: var(--font-sans);
    font-size: 11pt;
    line-height: 1.6;
    color: var(--color-text);
    max-width: 100%;
    margin: 0;
    padding: 40px 50px;
  }

  h1, h2, h3, h4, h5, h6 {
    margin-top: 1.5em;
    margin-bottom: 0.5em;
    line-height: 1.3;
    page-break-after: avoid;
  }

  h1 { font-size: 1.8em; border-bottom: 2px solid var(--color-border); padding-bottom: 0.3em; }
  h2 { font-size: 1.4em; border-bottom: 1px solid var(--color-border); padding-bottom: 0.2em; }
  h3 { font-size: 1.2em; }

  p { margin: 0.8em 0; }

  a { color: #0066cc; text-decoration: none; }

  blockquote {
    border-left: 3px solid var(--color-border);
    margin: 1em 0;
    padding: 0.5em 1em;
    color: var(--color-muted);
    background: #fafafa;
  }

  code {
    font-family: var(--font-mono);
    font-size: 0.9em;
    background: var(--color-bg-code);
    padding: 0.15em 0.4em;
    border-radius: 3px;
  }

  pre {
    background: var(--color-bg-code);
    padding: 1em;
    border-radius: 5px;
    overflow-x: auto;
    font-size: 0.85em;
    line-height: 1.5;
    page-break-inside: avoid;
  }

  pre code {
    background: none;
    padding: 0;
    border-radius: 0;
  }

  table {
    border-collapse: collapse;
    width: 100%;
    margin: 1em 0;
    font-size: 0.9em;
    page-break-inside: avoid;
  }

  th, td {
    border: 1px solid var(--color-border);
    padding: 0.5em 0.75em;
    text-align: left;
  }

  th { background: #f8f8f8; font-weight: 600; }
  tr:nth-child(even) { background: #fafafa; }

  img { max-width: 100%; height: auto; }

  hr {
    border: none;
    border-top: 1px solid var(--color-border);
    margin: 2em 0;
  }

  ul, ol { margin: 0.5em 0; padding-left: 1.5em; }
  li { margin: 0.3em 0; }

  @media print {
    body { padding: 0; }
    h1, h2, h3 { page-break-after: avoid; }
    pre, table, blockquote { page-break-inside: avoid; }
  }
`;

const HIGHLIGHT_CSS = `
  .hljs { color: #383a42; }
  .hljs-comment, .hljs-quote { color: #a0a1a7; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag { color: #a626a4; }
  .hljs-string, .hljs-addition { color: #50a14f; }
  .hljs-number { color: #986801; }
  .hljs-built_in { color: #c18401; }
  .hljs-function .hljs-title, .hljs-title.function_ { color: #4078f2; }
  .hljs-variable, .hljs-attr { color: #986801; }
  .hljs-deletion { color: #e45649; }
  .hljs-type, .hljs-class .hljs-title { color: #c18401; }
`;

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string', short: 'i' },
      url: { type: 'string', short: 'u' },
      output: { type: 'string', short: 'o' },
      format: { type: 'string', short: 'f' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });

  if (values.help) {
    console.log(`Usage:
  create-pdf --input <file.md|file.html> [--output <path.pdf>]
  create-pdf --url <https://...>         [--output <path.pdf>]
  echo "# Hello" | create-pdf --format markdown [--output <path.pdf>]

Options:
  -i, --input   Path to a Markdown (.md) or HTML (.html) file
  -u, --url     URL to render as PDF
  -f, --format  Input format from stdin: "markdown" or "html"
  -o, --output  Output PDF path (default: derived from input name)
  -h, --help    Show this help`);
    process.exit(0);
  }

  return values;
}

function detectFormat(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  throw new Error(`Cannot detect format for extension "${ext}". Use --format to specify.`);
}

function deriveOutputPath(inputPath, url) {
  if (inputPath) {
    const base = basename(inputPath, extname(inputPath));
    return resolve(DEFAULT_OUTPUT_DIR, `${base}.pdf`);
  }
  if (url) {
    const urlObj = new URL(url);
    const slug = urlObj.hostname.replace(/[^a-z0-9]/gi, '-');
    return resolve(DEFAULT_OUTPUT_DIR, `${slug}.pdf`);
  }
  return resolve(DEFAULT_OUTPUT_DIR, 'output.pdf');
}

function renderMarkdownToHtml(markdown) {
  const marked = new Marked(
    markedHighlight({
      langPrefix: 'hljs language-',
      highlight(code, lang) {
        if (lang && hljs.getLanguage(lang)) {
          return hljs.highlight(code, { language: lang }).value;
        }
        return hljs.highlightAuto(code).value;
      },
    })
  );

  const body = marked.parse(markdown);
  return wrapHtml(body);
}

function wrapHtml(body) {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>${STYLESHEET}</style>
  <style>${HIGHLIGHT_CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);

    // Timeout after 5s if no data
    setTimeout(() => {
      if (!data) reject(new Error('No input received on stdin within 5 seconds'));
    }, 5000);
  });
}

async function generatePdfFromHtml(htmlContent, outputPath) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

async function generatePdfFromUrl(url, outputPath) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseCliArgs();
  let outputPath = args.output;

  if (args.url) {
    // URL mode
    if (!outputPath) outputPath = deriveOutputPath(null, args.url);
    outputPath = resolve(outputPath);
    await generatePdfFromUrl(args.url, outputPath);
  } else if (args.input) {
    // File mode
    const inputPath = resolve(args.input);
    if (!outputPath) outputPath = deriveOutputPath(inputPath, null);
    outputPath = resolve(outputPath);

    const format = args.format || detectFormat(inputPath);
    const content = readFileSync(inputPath, 'utf8');

    if (format === 'markdown') {
      const html = renderMarkdownToHtml(content);
      await generatePdfFromHtml(html, outputPath);
    } else {
      // HTML — inject stylesheet if it's a fragment
      const html = content.includes('<html') ? content : wrapHtml(content);
      await generatePdfFromHtml(html, outputPath);
    }
  } else {
    // Stdin mode
    const format = args.format || 'markdown';
    if (!outputPath) outputPath = deriveOutputPath(null, null);
    outputPath = resolve(outputPath);

    const content = await readStdin();

    if (format === 'markdown') {
      const html = renderMarkdownToHtml(content);
      await generatePdfFromHtml(html, outputPath);
    } else {
      const html = content.includes('<html') ? content : wrapHtml(content);
      await generatePdfFromHtml(html, outputPath);
    }
  }

  console.log(outputPath);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
