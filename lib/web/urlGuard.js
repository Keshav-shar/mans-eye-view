'use strict';
const net = require('net');
const dns = require('dns');
const { registeredDomain } = require('./canonical');

// SSRF guard for everything the crawler fetches. Two layers:
// 1. shape: https only, default port only, no credentials, no IP literals (WHATWG URL already turns
//    "2130706433" and "0x7f.1" into dotted IPs, which are then refused), no internal-looking hostnames;
// 2. address: resolve once, refuse if ANY answer is non-public, and return that address so the socket
//    is pinned to it (no second lookup → no DNS-rebinding window). Redirects re-run both layers.

function v4ToInt(ip) { return ip.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; }
const V4_BLOCKS = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0]);

function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  return V4_BLOCKS.some(([base, mask]) => ((n & mask) >>> 0) === base);
}

function expandV6(ip) {
  let s = ip.toLowerCase().split('%')[0];
  if (s.includes('.')) { // trailing dotted quad (e.g. ::ffff:1.2.3.4)
    const i = s.lastIndexOf(':');
    const v4 = s.slice(i + 1).split('.').map(Number);
    s = `${s.slice(0, i + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x || '0', 16));
}

function isBlockedV6(ip) {
  const w = expandV6(ip);
  if (w.length !== 8 || w.some((x) => !Number.isFinite(x))) return true;
  if (w.every((x) => x === 0)) return true; // ::
  if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) return true; // ::1
  if (w.slice(0, 5).every((x) => x === 0) && (w[5] === 0xffff || w[5] === 0)) return true; // v4-mapped / v4-compatible
  if (w[0] === 0x64 && w[1] === 0xff9b) return true; // NAT64
  if ((w[0] & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((w[0] & 0xffc0) === 0xfe80) return true; // link-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x2001 && w[1] === 0) return true; // Teredo
  if (w[0] === 0x2002) return true; // 6to4 can tunnel to private v4
  return false;
}

function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true;
}

const INTERNAL_HOST = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/i;

function matchesDomain(domain, list) {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

class UrlGuard {
  constructor({ deny = [], trusted = [], lookup = dns.lookup } = {}) {
    this.deny = deny.map((d) => d.toLowerCase());
    this.trusted = trusted.map((d) => d.toLowerCase());
    this.lookup = lookup;
  }

  setLists({ deny, trusted }) {
    if (deny) this.deny = deny.map((d) => d.toLowerCase());
    if (trusted) this.trusted = trusted.map((d) => d.toLowerCase());
  }

  tierOf(host) {
    const h = String(host || '').toLowerCase();
    if (matchesDomain(h, this.deny)) return 'deny';
    if (matchesDomain(h, this.trusted)) return 'trusted';
    return 'open';
  }

  // Synchronous shape check. → { ok, reason, host, domain, tier }
  check(url) {
    let u;
    try { u = new URL(url); } catch { return { ok: false, reason: 'Not a valid URL' }; }
    if (u.protocol !== 'https:') return { ok: false, reason: 'Only https is fetched' };
    if (u.username || u.password) return { ok: false, reason: 'URLs with credentials are refused' };
    if (u.port && u.port !== '443') return { ok: false, reason: 'Only the default https port is allowed' };
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    const bare = host.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) return { ok: false, reason: 'IP addresses are refused; use a domain name' };
    if (!host.includes('.') || INTERNAL_HOST.test(host)) return { ok: false, reason: 'Internal host names are refused' };
    if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false, reason: 'Unusual host name' };
    const tier = this.tierOf(host);
    if (tier === 'deny') return { ok: false, reason: 'This site is on the deny list', host, domain: registeredDomain(host), tier };
    return { ok: true, host, domain: registeredDomain(host), tier };
  }

  // → { ok, reason, address, family }
  resolve(host) {
    return new Promise((resolve) => {
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, reason: 'DNS lookup timed out' }); } }, 5000);
      try {
        this.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (err) return resolve({ ok: false, reason: `DNS lookup failed (${err.code || err.message})` });
          const list = Array.isArray(addrs) ? addrs : [{ address: addrs, family: net.isIP(addrs) }];
          if (!list.length) return resolve({ ok: false, reason: 'DNS returned no addresses' });
          const bad = list.find((a) => isBlockedAddress(a.address));
          if (bad) return resolve({ ok: false, reason: `Resolves to a non-public address (${bad.address})` });
          resolve({ ok: true, address: list[0].address, family: list[0].family || net.isIP(list[0].address) });
        });
      } catch (e) {
        done = true;
        clearTimeout(timer);
        resolve({ ok: false, reason: `DNS lookup failed (${e.message})` });
      }
    });
  }
}

module.exports = { UrlGuard, isBlockedAddress, isBlockedV4, isBlockedV6, matchesDomain };
