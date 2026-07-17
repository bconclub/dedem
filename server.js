// DEDEM — transparent same-origin proxy + static server.
//
// Goal: render any site (incl. Next.js / Vercel SPAs) inside our iframes while
// keeping the iframe document SAME-ORIGIN with the app, so the two panels can
// read each other's scroll and stay in sync.
//
// How: every resource the page pulls (HTML, CSS, JS, fonts, images, runtime
// fetches, client-side routes) is routed back through this server. Nothing in
// the iframe ever references the real origin directly, so it never leaves our
// origin and hydration can't bounce it away.

import express from "express";
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 5173;

// When deployed publicly (DEDEM_PUBLIC=1), refuse to proxy private/internal
// addresses. Without this, an open proxy can be pointed at the host's own
// internal services and cloud metadata (169.254.169.254) to steal credentials.
// Left off locally so localhost dev-server previews keep working.
const PUBLIC_MODE = process.env.DEDEM_PUBLIC === "1" || !!process.env.VERCEL;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true; // link-local + cloud metadata
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  const v = ip.toLowerCase();
  if (v === "::1" || v === "::") return true;
  if (v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true;
  if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7)); // IPv4-mapped
  return false;
}

// Returns a reason string if the host must be blocked, else null.
async function blockedReason(hostname) {
  if (!PUBLIC_MODE) return null;
  const h = (hostname || "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal")) {
    return "internal hostname";
  }
  if (net.isIP(h)) return isPrivateIp(h) ? "private IP" : null;
  try {
    const records = await dns.lookup(h, { all: true });
    if (records.some((r) => isPrivateIp(r.address))) return "resolves to private IP";
  } catch {
    return "DNS resolution failed";
  }
  return null;
}

const app = express();

// Last site loaded — used as a fallback to resolve the target origin for
// requests whose Referer doesn't carry it (e.g. after a hard sub-navigation).
// DevDemo previews one site at a time in both panels, so a single value is safe.
let lastOrigin = null;

// ---- Injected into every proxied HTML page ----
const SYNC_AGENT = `
<script>(function(){
  var applyUntil = 0;
  function scroller(){ return document.scrollingElement || document.documentElement || document.body; }
  function maxScroll(el){ return Math.max(1, el.scrollHeight - el.clientHeight); }
  window.addEventListener("scroll", function(){
    if (Date.now() < applyUntil) return;
    var el = scroller();
    parent.postMessage({ __devdemo:true, type:"scroll", ratio: el.scrollTop / maxScroll(el) }, "*");
  }, { passive:true });
  window.addEventListener("message", function(e){
    var m = e.data;
    if (!m || !m.__devdemo || m.type !== "apply") return;
    applyUntil = Date.now() + 120;
    var el = scroller();
    el.scrollTop = m.ratio * maxScroll(el);
  });
})();</script>`;

// Head injection: (1) a meta tag forcing full-URL Referer on subresource
// requests so the catch-all can resolve the target origin, (2) a location fix
// that runs before the site's bundle and sets the iframe path to the site's
// REAL path via history.replaceState — without this, client-side-routed SPAs
// (Vite/React Router, etc.) read pathname "/proxy" and render their 404 page,
// and (3) the scroll-sync agent.
// Hide the scrollbar inside the preview while keeping the page scrollable —
// cleaner look for demos (both panels scroll via the sync agent anyway).
const HIDE_SCROLLBAR = `<style>html{scrollbar-width:none!important;-ms-overflow-style:none!important;}html::-webkit-scrollbar,body::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;}</style>`;

// Network interceptor — patches fetch / XHR / sendBeacon so the site's absolute
// cross-origin requests (e.g. its own API on api.example.com) are rerouted
// through our proxy. Client-rendered apps fetch their content from such APIs;
// fired straight from localhost they'd be CORS-blocked and the page stays empty.
// Must run before the site's bundle, so it goes first in <head>.
const NET_AGENT = `<script>(function(){
  // Capture errors so DEDEM can explain why a site failed to render.
  window.__DD_ERR = [];
  window.addEventListener("error", function(e){ try{ window.__DD_ERR.push(String(e.message)+" @ "+String(e.filename||"").slice(-70)+":"+e.lineno); }catch(_){} });
  window.addEventListener("unhandledrejection", function(e){ try{ window.__DD_ERR.push("promise: "+String((e.reason&&e.reason.message)||e.reason)); }catch(_){} });
  var _ce = console.error;
  console.error = function(){ try{ window.__DD_ERR.push("console.error: "+Array.prototype.slice.call(arguments).map(function(a){return (a&&a.stack)||(a&&a.message)||String(a);}).join(" ").slice(0,400)); }catch(_){} return _ce.apply(console, arguments); };
  // Best-effort anti-frame-detection: some sites hide content when framed.
  try{ Object.defineProperty(window, "frameElement", { get:function(){ return null; }, configurable:true }); }catch(e){}
  var origin = location.origin;
  function pr(u){
    try{ var a = new URL(u, document.baseURI);
      if((a.protocol==="http:"||a.protocol==="https:") && a.origin!==origin){
        return "/proxy?url="+encodeURIComponent(a.href);
      }
    }catch(e){}
    return u;
  }
  var of = window.fetch;
  if(of){ window.fetch = function(input, init){
    try{
      if(typeof input==="string"){ input = pr(input); }
      else if(input && input.url){ input = new Request(pr(input.url), input); }
    }catch(e){}
    return of.call(this, input, init);
  };}
  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, u){
    try{ arguments[1] = pr(u); }catch(e){}
    return xo.apply(this, arguments);
  };
  if(navigator.sendBeacon){ var sb = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(u, d){ try{u=pr(u);}catch(e){} return sb(u,d); }; }
})();</script>`;

function headInject(realPath) {
  const locFix = `<script>try{history.replaceState(null,"",${JSON.stringify(
    realPath || "/"
  )});}catch(e){}</script>`;
  return `<meta name="referrer" content="unsafe-url">${locFix}${NET_AGENT}${HIDE_SCROLLBAR}${SYNC_AGENT}`;
}

function toProxy(absUrl) {
  return "/proxy?url=" + encodeURIComponent(absUrl);
}

function resolveAbs(ref, base) {
  try {
    return new URL(ref, base);
  } catch {
    return null;
  }
}

const SKIP = /^(data:|blob:|javascript:|mailto:|tel:|about:|#)/i;

function rewriteRef(ref, base) {
  const raw = (ref || "").trim();
  if (!raw || SKIP.test(raw) || raw.startsWith("/proxy?url=")) return ref;
  const abs = resolveAbs(raw, base);
  if (!abs || !/^https?:$/.test(abs.protocol)) return ref;
  return toProxy(abs.href);
}

function rewriteSrcset(value, base) {
  return value
    .split(",")
    .map((part) => {
      const seg = part.trim();
      if (!seg) return "";
      const sp = seg.split(/\s+/);
      sp[0] = rewriteRef(sp[0], base);
      return sp.join(" ");
    })
    .filter(Boolean)
    .join(", ");
}

function rewriteCssUrls(css, base) {
  css = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    if (SKIP.test(u.trim())) return m;
    return `url(${q}${rewriteRef(u, base)}${q})`;
  });
  css = css.replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
    return `@import ${q}${rewriteRef(u, base)}${q}`;
  });
  return css;
}

function rewriteHtml(html, base) {
  // The site's real path — restored inside the iframe so SPA routers resolve
  // the right route instead of falling through to their 404.
  let realPath = "/";
  try {
    const u = new URL(base);
    realPath = u.pathname + u.search + u.hash;
  } catch {}

  // Mask <script> elements so URL rewriting never touches their bodies. Modern
  // SSR frameworks (Next.js App Router / RSC, Remix, etc.) embed serialized page
  // data inside inline scripts — e.g. self.__next_f.push([1,"...<a href=...>..."]).
  // Rewriting hrefs inside that payload corrupts it and React wipes the page to
  // blank after hydration. We still rewrite the opening tag's own src attribute.
  const scripts = [];
  html = html.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, attrs, body) => {
    const openTag = "<script" + attrs.replace(
      /\b(src)\s*=\s*("|')(.*?)\2/gi,
      (mm, a, q, val) => `${a}=${q}${rewriteRef(val, base)}${q}`
    ) + ">";
    const token = `DDSCRIPT${scripts.length}DDEND`;
    scripts.push(openTag + body + "</script>");
    return token;
  });

  // Drop existing <base> tags — we resolve URLs ourselves.
  html = html.replace(/<base\b[^>]*>/gi, "");
  // Strip SRI hashes (we rewrite CSS content, which would break integrity).
  html = html.replace(/\s(integrity)=("|')[^"']*\2/gi, "");
  // Neutralise existing referrer meta (we set our own).
  html = html.replace(/<meta\b[^>]*name=["']referrer["'][^>]*>/gi, "");

  // URL-bearing attributes.
  html = html.replace(
    /\b(href|poster|action|formaction|data-src|data-href)\s*=\s*("|')(.*?)\2/gi,
    (m, attr, q, val) => `${attr}=${q}${rewriteRef(val, base)}${q}`
  );
  // src on non-script elements (scripts already handled above and masked out).
  html = html.replace(
    /\b(src)\s*=\s*("|')(.*?)\2/gi,
    (m, attr, q, val) => `${attr}=${q}${rewriteRef(val, base)}${q}`
  );
  // srcset.
  html = html.replace(
    /\b(srcset|imagesrcset|data-srcset)\s*=\s*("|')(.*?)\2/gi,
    (m, attr, q, val) => `${attr}=${q}${rewriteSrcset(val, base)}${q}`
  );
  // Inline <style> blocks.
  html = html.replace(
    /(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi,
    (m, open, css, close) => open + rewriteCssUrls(css, base) + close
  );
  // style="" url()s.
  html = html.replace(
    /\bstyle=("|')(.*?)\1/gi,
    (m, q, css) => `style=${q}${rewriteCssUrls(css, base)}${q}`
  );

  // Restore masked scripts.
  html = html.replace(/DDSCRIPT(\d+)DDEND/g, (m, i) => scripts[+i]);

  // Inject agent into <head> (must be first so the location fix runs before
  // the site's own scripts read location.pathname).
  const inject = headInject(realPath);
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + inject);
  else if (/<html[^>]*>/i.test(html)) html = html.replace(/<html[^>]*>/i, (m) => m + "<head>" + inject + "</head>");
  else html = inject + html;

  return html;
}

const STRIP_HEADERS = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "referrer-policy",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "set-cookie",
  "strict-transport-security",
]);

async function proxyTo(targetUrl, req, res) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    res.status(400).send("Bad target URL");
    return;
  }
  if (!/^https?:$/.test(target.protocol)) {
    res.status(400).send("Unsupported protocol");
    return;
  }

  const blocked = await blockedReason(target.hostname);
  if (blocked) {
    res.status(403).send(`Blocked: target ${blocked}`);
    return;
  }

  // Forward the browser's request headers (so the site's API sees its auth
  // tokens, content-type, etc.), dropping only hop-by-hop / origin-specific ones.
  const DROP_REQ = new Set([
    "host", "connection", "content-length", "accept-encoding",
    "origin", "referer", "cookie", "sec-fetch-site", "sec-fetch-mode",
    "sec-fetch-dest", "sec-fetch-user",
  ]);
  const fwdHeaders = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: req.headers["accept"] || "*/*",
    "Accept-Language": req.headers["accept-language"] || "en-US,en;q=0.9",
  };
  for (const [k, v] of Object.entries(req.headers)) {
    if (!DROP_REQ.has(k.toLowerCase()) && typeof v === "string") fwdHeaders[k] = v;
  }
  // Make the site's API believe the request comes from its own origin.
  fwdHeaders["Origin"] = target.origin;
  fwdHeaders["Referer"] = target.origin + "/";

  const method = (req.method || "GET").toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  let upstream;
  try {
    upstream = await fetch(target.href, {
      method,
      redirect: "follow",
      headers: fwdHeaders,
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
    });
  } catch (err) {
    res
      .status(502)
      .send(
        `<div style="font:16px system-ui;padding:40px;color:#334">DevDemo couldn't reach <b>${target.href}</b>.<br><br>${String(
          err.message || err
        )}</div>`
      );
    return;
  }

  const finalUrl = upstream.url || target.href;

  // Guard against redirect-based SSRF (public URL → internal address).
  try {
    const fb = await blockedReason(new URL(finalUrl).hostname);
    if (fb) { res.status(403).send(`Blocked: redirect target ${fb}`); return; }
  } catch {}
  const contentType = upstream.headers.get("content-type") || "";

  // Forward headers except the ones that block framing / would mislead the browser.
  upstream.headers.forEach((value, key) => {
    if (!STRIP_HEADERS.has(key.toLowerCase())) {
      try {
        res.setHeader(key, value);
      } catch {}
    }
  });
  res.status(upstream.status);

  if (contentType.includes("text/html")) {
    const org = new URL(finalUrl).origin;
    // Persist the origin in a cookie so runtime-constructed requests (webpack
    // dynamic chunks, fetch/XHR) can resolve it even when their Referer no
    // longer carries ?url= (history.replaceState changed the iframe path) and
    // even on stateless serverless where the lastOrigin global doesn't persist.
    // ONLY for the two main preview frames (app.js marks them with main=1).
    // Nested embeds a site loads — Vimeo/YouTube players, maps, analytics, ads —
    // are also HTML frame navigations; without this gate they'd clobber the
    // cookie and every bare chunk request would resolve to the wrong origin.
    if (req.query.main === "1") {
      lastOrigin = org;
      res.setHeader("Set-Cookie", `dedem_o=${encodeURIComponent(org)}; Path=/; SameSite=Lax; Max-Age=86400`);
    }
    let html = await upstream.text();
    html = rewriteHtml(html, finalUrl);
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.send(html);
    return;
  }

  if (contentType.includes("text/css")) {
    let css = await upstream.text();
    css = rewriteCssUrls(css, finalUrl);
    res.setHeader("content-type", contentType);
    res.send(css);
    return;
  }

  // Everything else (JS, fonts, images, JSON, ...) passes through untouched.
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.setHeader("content-type", contentType || "application/octet-stream");
  res.send(buf);
}

// Resolve the intended target origin for a bare same-origin request:
// (1) the Referer's ?url= param, (2) the dedem_o cookie (survives replaceState
// and serverless statelessness), (3) the last-loaded-site global fallback.
function resolveOrigin(req) {
  const ref = req.headers["referer"] || req.headers["referrer"];
  if (ref) {
    try {
      const inner = new URL(ref).searchParams.get("url");
      if (inner) return new URL(inner).origin;
    } catch {}
  }
  const cookie = req.headers["cookie"] || "";
  const m = cookie.match(/(?:^|;\s*)dedem_o=([^;]+)/);
  if (m) {
    try {
      return new URL(decodeURIComponent(m[1])).origin;
    } catch {}
  }
  return lastOrigin;
}

// Explicit proxy route (entry point + all rewritten resources). All methods,
// so intercepted API calls (GET/POST/PUT/...) go through too.
app.all("/proxy", (req, res) => proxyTo(req.query.url, req, res));

// Static app files.
app.use(express.static(path.join(__dirname, "public")));

// Catch-all: runtime-constructed requests (Next.js chunks, fetch/XHR, hard
// sub-navigations) arrive as bare same-origin paths — proxy them to the site.
app.use((req, res) => {
  const origin = resolveOrigin(req);
  if (!origin) {
    res.status(404).send("Not found");
    return;
  }
  proxyTo(origin + req.originalUrl, req, res);
});

// On Vercel the platform invokes the exported app as a serverless handler;
// locally (and on the VPS/Docker) we start a normal listening server.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n  DEDEM running →  http://localhost:${PORT}\n`);
  });
}

export default app;
