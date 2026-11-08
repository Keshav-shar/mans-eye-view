'use strict';

// Decides what a response means for the crawler. A block (rate limit, bot wall, challenge page) trips a
// per-domain circuit breaker and is recorded as Deferred for you to open by hand. There is no CAPTCHA
// solving, proxy rotation, header spoofing or any other evasion: blocked means stop.
//
// Verdicts: ok | not_modified | blocked | gone | soft404 | js_required | empty | error

const CHALLENGE = /\b(?:re)?captcha\b|g-recaptcha|h-captcha|hcaptcha|cf-chl-|challenge-platform|cf-turnstile|turnstile\.js|verify (that )?you are (a )?human|are you a robot|unusual traffic|access denied|attention required|ddos protection by|px-captcha|perimeterx|datadome|bot detection|please enable cookies/i;

// Inline script code is full of feature flags and words ("octocaptcha_origin_optimization" on GitHub) that
// are not a challenge. Keep each script TAG (its src shows a real challenge widget) but drop its code.
const markupOf = (html) => String(html || '').slice(0, 200000)
  .replace(/<script\b([^>]*)>[\s\S]*?<\/script>/gi, '<script$1></script>')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
const SOFT404 = /\b(page not found|404|not be found|doesn['’]t exist|does not exist|no longer available)\b/i;
const NEEDS_JS = /enable javascript|requires javascript|javascript is (disabled|required)|you need to enable javascript/i;

// bodyChars: text in the cleaned page body (not just what Readability kept); structured: the page has
// JSON-LD or an og:description. Both guard against calling a readable page "JavaScript-only".
function classify({ status, text = '', visibleChars = null, title = '', scriptCount = null, bodyChars = null, structured = false }) {
  if (status === 304) return { verdict: 'not_modified' };
  if (status === 401 || status === 403 || status === 407 || status === 429 || status === 451) return { verdict: 'blocked', reason: `HTTP ${status}` };
  if (status === 503 && CHALLENGE.test(markupOf(text).slice(0, 30000))) return { verdict: 'blocked', reason: 'Challenge page (HTTP 503)' };
  if (status === 404 || status === 410) return { verdict: 'gone', reason: `HTTP ${status}` };
  if (status >= 500) return { verdict: 'error', reason: `HTTP ${status}` };
  if (status >= 400) return { verdict: 'error', reason: `HTTP ${status}` };
  if (status === 204) return { verdict: 'empty', reason: 'No content' };
  const vis = visibleChars == null ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length : visibleChars;
  if (vis < 2500 && CHALLENGE.test(markupOf(text).slice(0, 30000))) return { verdict: 'blocked', reason: 'Bot challenge page' };
  if (vis < 1500 && SOFT404.test(title)) return { verdict: 'soft404', reason: 'Looks like a "not found" page' };
  const scripts = scriptCount == null ? (text.match(/<script\b/gi) || []).length : scriptCount;
  const body = Math.max(vis, bodyChars || 0);
  if (body < 250 && !structured && (scripts >= 3 || NEEDS_JS.test(text))) return { verdict: 'js_required', reason: 'Needs JavaScript to render (not supported)' };
  if (vis < 120) return { verdict: 'empty', reason: 'Almost no text' };
  return { verdict: 'ok' };
}

module.exports = { classify, CHALLENGE };
