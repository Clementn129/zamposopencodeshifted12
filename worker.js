// ZamPOS Cloudflare Worker
// Serves static assets from the ASSETS binding while controlling cache headers
// so that deployments actually reach users WITHOUT manual cache clears.
//
//   - HTML navigations (index.html / SPA fallback) -> no-cache
//   - Content-hashed build assets (dist/assets/*, workbox-*.js) -> immutable
//   - EVERYTHING ELSE (sw.js, manifest*, icons, robots.txt, ...) -> no-cache
//
// The previous rule marked ANY path containing a "." as immutable, which
// wrongly pinned /sw.js and /manifest.json for a year and silently froze PWA
// updates. Only genuinely content-hashed files may be immutable.

const IMMUTABLE_PREFIX = "/assets/";
const IMMUTABLE_RE = /^\/workbox-.*\.js$/;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const response = await env.ASSETS.fetch(request);

    const contentType = response.headers.get("content-type") || "";
    const isHtml = contentType.includes("text/html");
    const isImmutable =
      url.pathname.startsWith(IMMUTABLE_PREFIX) || IMMUTABLE_RE.test(url.pathname);

    const out = new Response(response.body, response);

    if (isHtml) {
      out.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      out.headers.set("Pragma", "no-cache");
      out.headers.set("Expires", "0");
    } else if (isImmutable) {
      out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
    } else {
      // sw.js, manifest.webmanifest, icons, robots.txt, sitemap.xml, ...
      out.headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
    }

    for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
      out.headers.set(key, value);
    }

    return out;
  },
};
