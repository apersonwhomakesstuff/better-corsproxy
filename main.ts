import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
const PROXY_ORIGIN = "https://better-corsproxy.deno.dev";

// Ensure a valid, proxied URL
function proxyUrl(rawUrl: string, base: string): string {
  try {
    const absolute = new URL(rawUrl, base).href;
    if (absolute.startsWith(PROXY_ORIGIN)) return rawUrl;
    return `${PROXY_ORIGIN}/?url=${encodeURIComponent(absolute)}`;
  } catch {
    return rawUrl;
  }
}

// Optional shortcut for DuckDuckGo search
function buildDuckDuckGoUrl(urlObj: URL): string | null {
  const q = urlObj.searchParams.get("q");
  if (q) {
    const t = urlObj.searchParams.get("t") || "h_";
    return `https://duckduckgo.com/?q=${encodeURIComponent(q)}&t=${encodeURIComponent(t)}`;
  }
  return null;
}

// Auto-correct malformed URLs
function normalizeTarget(input: string): string {
  try {
    new URL(input);
    return input;
  } catch {
    return "https://" + input;
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  let target = url.searchParams.get("url");

  // Build DuckDuckGo target if possible
  if (!target) {
    const alt = buildDuckDuckGoUrl(url);
    if (alt) target = alt;
  }

  if (!target) {
    return new Response("Missing ?url= parameter", { status: 400 });
  }

  // Normalize raw domains
  target = normalizeTarget(target);

  // Loop protection
  if (target.startsWith(PROXY_ORIGIN)) {
    return new Response("⚠️ Loop detected", { status: 508 });
  }

  console.log("Proxying:", target);

  try {
    const headers = new Headers(req.headers);
    headers.set("User-Agent", USER_AGENT);
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    headers.set("Accept-Language", "en-US,en;q=0.9");
    headers.set("Connection", "keep-alive");

    const response = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    const contentType = response.headers.get("content-type") || "";
    const outHeaders = new Headers(response.headers);

    // CORS headers
    outHeaders.set("Access-Control-Allow-Origin", "*");
    outHeaders.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    outHeaders.set("Access-Control-Allow-Headers", "*");
    outHeaders.set("Access-Control-Allow-Credentials", "true");

    // Allow embedding in iframes
    outHeaders.delete("X-Frame-Options");
    outHeaders.delete("Content-Security-Policy");

    // HTML rewriting
    if (contentType.includes("text/html")) {
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (!doc) return new Response("Failed to parse HTML", { status: 500 });

      const rewriteAttr = (selector: string, attr: string) => {
        for (const el of doc.querySelectorAll(selector)) {
          const val = el.getAttribute(attr);
          if (val) el.setAttribute(attr, proxyUrl(val, target));
        }
      };

      rewriteAttr("img", "src");
      rewriteAttr("script", "src");
      rewriteAttr("link[rel=stylesheet]", "href");
      rewriteAttr("a", "href");
      rewriteAttr("form", "action");
      rewriteAttr("source", "src");
      rewriteAttr("video", "src");

      const proxiedHtml = doc.documentElement?.outerHTML ?? html;
      return new Response(proxiedHtml, {
        status: response.status,
        headers: {
          ...Object.fromEntries(outHeaders.entries()),
          "content-type": "text/html; charset=utf-8",
        },
      });
    }

    return new Response(response.body, {
      status: response.status,
      headers: outHeaders,
    });
  } catch (err) {
    return new Response("Proxy error: " + err.message, { status: 500 });
  }
});
