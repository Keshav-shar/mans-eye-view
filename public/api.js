async function req(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      keepalive: method !== 'GET' && body !== undefined && JSON.stringify(body).length < 60000,
    });
  } catch {
    throw new Error('Cannot reach Nexus. Check that the server is still running.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (u) => req('GET', u),
  post: (u, b = {}) => req('POST', u, b),
  patch: (u, b) => req('PATCH', u, b),
  del: (u) => req('DELETE', u),
};
