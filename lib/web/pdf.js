'use strict';
const { sha } = require('../fsutil');
const { simhash } = require('../ml/simhash');

// PDF → the same page shape scrape.extract() returns, so reports, decks and filings flow through the
// parser like HTML. Text only: no scripts, forms or embedded files are touched. Capped at 40 pages.

const MAX_PAGES = 40;

async function extractPdf(buffer, url) {
  const { PDFParse } = require('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  let text = '';
  let title = '';
  try {
    const info = await parser.getInfo().catch(() => null);
    title = info && info.info && typeof info.info.Title === 'string' ? info.info.Title.trim() : '';
    const res = await parser.getText({ first: 1, last: MAX_PAGES });
    text = String(res && res.text ? res.text : '');
  } finally {
    await parser.destroy().catch(() => {});
  }
  // Re-flow: PDFs break lines mid-sentence; keep blank lines as paragraph breaks.
  text = text.replace(/\r/g, '').replace(/-- \d+ of \d+ --/g, '').replace(/([^\n])\n(?=[^\n])/g, '$1 ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 200000);
  if (!title) title = (text.split('\n').find((l) => l.trim().length > 8) || '').slice(0, 160);
  return {
    url, title: title.slice(0, 300), description: '', siteName: '', ogType: 'pdf', lang: '', published: '', noindex: false, nofollow: true,
    markdown: text, text, links: [], mailtos: [], jsonld: [], scriptCount: 0,
    visibleChars: text.length, bodyChars: text.length, contentHash: sha(text, 'sha1'), simhash: simhash(text), isPdf: true,
  };
}

module.exports = { extractPdf, MAX_PAGES };
