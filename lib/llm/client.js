'use strict';

// Low-level Groq (OpenAI-compatible) client. One function per concern: transport, JSON recovery,
// and a completeJson() that degrades gracefully across model capabilities.

class AiError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

function parseLoose(content) {
  let s = String(content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(s); } catch { /* fall through */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ }
  }
  throw new AiError(502, 'The model did not return valid JSON. Try again or shorten the note.');
}

async function post(cfg, body, { timeoutMs = 60000, path = '/chat/completions' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${cfg.groqBase}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* non-JSON error body */ }
    const headers = {};
    for (const k of ['retry-after', 'x-ratelimit-remaining-requests', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
      const v = res.headers.get(k);
      if (v != null) headers[k] = v;
    }
    return {
      ok: res.ok, status: res.status, data, headers,
      message: (data && data.error && data.error.message) || raw.slice(0, 300),
      failed: data && data.error && data.error.failed_generation,
      retryAfter: res.headers.get('retry-after'),
    };
  } catch (e) {
    throw new AiError(502, e.name === 'AbortError' ? 'Groq took too long to respond. Try again.' : 'Could not reach Groq. Check your internet connection.');
  } finally {
    clearTimeout(timer);
  }
}

// Models known to accept json_schema structured outputs and reasoning_effort on Groq.
const SCHEMA_MODELS = /gpt-oss|qwen|muse-spark|kimi|llama-4/i;
const EFFORT_MODELS = /gpt-oss|qwen|muse-spark/i;

async function completeJson(cfg, messages, {
  maxTokens = 4096, model, schema = null, schemaName = 'result', temperature = 0.2, effort = null, onResponse = null, timeoutMs = 60000,
} = {}) {
  const useModel = model || cfg.groqModel;
  if (!cfg.groqKey) throw new AiError(503, 'No Groq API key found. Add GROQ_API_KEY to your .env file and restart Nexus.');
  if (!useModel) throw new AiError(503, 'No model name found. Add GROQ_MODEL to your .env file and restart Nexus.');
  const body = {
    model: useModel, messages, temperature, max_completion_tokens: maxTokens, stream: false,
    response_format: schema && SCHEMA_MODELS.test(useModel)
      ? { type: 'json_schema', json_schema: { name: schemaName, schema, strict: false } }
      : { type: 'json_object' },
  };
  if (effort && EFFORT_MODELS.test(useModel)) body.reasoning_effort = effort;
  let r = await post(cfg, body, { timeoutMs });
  // Step down through capabilities the model may not support, one at a time.
  for (let i = 0; i < 3 && !r.ok && r.status === 400 && !r.failed; i++) {
    if (body.reasoning_effort && /reasoning/i.test(r.message)) delete body.reasoning_effort;
    else if (body.response_format && body.response_format.type === 'json_schema' && /response_format|json_schema|schema/i.test(r.message)) body.response_format = { type: 'json_object' };
    else if (body.response_format && /response_format|json_object|json mode/i.test(r.message)) delete body.response_format;
    else break;
    r = await post(cfg, body, { timeoutMs });
  }
  if (onResponse) onResponse(r, useModel);
  if (!r.ok) {
    if (r.status === 400 && r.failed) return parseLoose(r.failed);
    if (r.status === 401 || r.status === 403) throw new AiError(502, 'Groq rejected the API key. Check GROQ_API_KEY in your .env file.', { kind: 'auth' });
    if (r.status === 404 || r.status === 400) throw new AiError(502, `Groq could not use the model "${useModel}": ${r.message}`, { kind: 'model', model: useModel });
    if (r.status === 413) throw new AiError(502, 'The request was too large for this model. Shorten the note and try again.', { kind: 'size' });
    if (r.status === 429) {
      const wait = Number(r.retryAfter);
      throw new AiError(429, `Groq rate limit reached.${Number.isFinite(wait) && wait > 0 ? ` Try again in ${Math.ceil(wait)} seconds.` : ' Try again in a moment.'}`, { kind: 'rate', retryAfter: Number.isFinite(wait) ? wait : null });
    }
    throw new AiError(502, `Groq returned an error (${r.status}). ${r.message}`);
  }
  const content = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
  if (!content) throw new AiError(502, 'Groq returned an empty response. Try again.');
  return parseLoose(content);
}

module.exports = { AiError, parseLoose, post, completeJson, SCHEMA_MODELS };
