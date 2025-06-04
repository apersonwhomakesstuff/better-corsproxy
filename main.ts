import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
const PROXY_ORIGIN = "https://dry-ferret-37.deno.dev";

function proxyUrl(rawUrl: string, base: string): string {
  try {
    // Add https: to protocol-relative URLs (//...)
    if (rawUrl.startsWith("//")) rawUrl = "https:" + rawUrl;

    // Add https:// if missing scheme (auto-https QoL)
    if (!rawUrl.match(/^[a-zA-Z]+:\/\//)) rawUrl = "https://" + rawUrl;

    // Construct absolute URL based on base (original page URL)
    const absoluteUrl = new URL(rawUrl, base).href;

    // Avoid double proxy
    if (absoluteUrl.startsWith(PROXY_ORIGIN)) return rawUrl;

    return `${PROXY_ORIGIN}/?url=${encodeURIComponent(absoluteUrl)}`;
  } catch {
    return rawUrl;
  }
}

// Build DuckDuckGo full URL from query params if no ?url= is provided
function buildDuckDuckGoUrl(urlObj: URL): string | null {
  const q = urlObj.searchParams.get("q");
  if (q) {
    const t = urlObj.searchParams.get("t") || "h_";
    const ia = urlObj.searchParams.get("ia") || "";
    const iax = urlObj.searchParams.get("iax") || "";
    // Build DuckDuckGo URL, keep ia and iax params if present
    let ddgUrl = `https://duckduckgo.com/?q=${encodeURIComponent(q)}&t=${encodeURIComponent(t)}`;
    if (ia) ddgUrl += `&ia=${encodeURIComponent(ia)}`;
    if (iax) ddgUrl += `&iax=${encodeURIComponent(iax)}`;
    return ddgUrl;
  }
  return null;
}

const server = Deno.serve(async (req) => {
  const url = new URL(req.url);
  let target = url.searchParams.get("url");

  if (!target) {
    const maybeDDG = buildDuckDuckGoUrl(url);
    if (maybeDDG) target = maybeDDG;
  }

  if (!target) {
    return new Response("Missing ?url parameter", { status: 400 });
  }

  try {
    const newHeaders = new Headers(req.headers);
    newHeaders.set("User-Agent", USER_AGENT);
    newHeaders.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    newHeaders.set("Accept-Language", "en-US,en;q=0.9");
    newHeaders.set("Connection", "keep-alive");

    const proxiedRes = await fetch(target, {
      method: req.method,
      headers: newHeaders,
      body: req.body,
      redirect: "manual",
    });

    const contentType = proxiedRes.headers.get("content-type") || "";
    const headers = new Headers(proxiedRes.headers);

    headers.set("Content-Security-Policy", "frame-ancestors 'none';");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Access-Control-Allow-Origin", "*");

    if (contentType.includes("text/html")) {
      const html = await proxiedRes.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (!doc) return new Response("Failed to parse HTML", { status: 500 });

      // Rewrite images
      for (const img of doc.querySelectorAll("img")) {
        const src = img.getAttribute("src");
        if (src) img.setAttribute("src", proxyUrl(src, target));
      }
      // Rewrite scripts
      for (const script of doc.querySelectorAll("script")) {
        const src = script.getAttribute("src");
        if (src) script.setAttribute("src", proxyUrl(src, target));
      }
      // Rewrite stylesheets
      for (const link of doc.querySelectorAll("link[rel=stylesheet]")) {
        const href = link.getAttribute("href");
        if (href) link.setAttribute("href", proxyUrl(href, target));
      }
      // Rewrite anchors (links)
      for (const a of doc.querySelectorAll("a")) {
        const href = a.getAttribute("href");
        if (
          href &&
          !href.startsWith("#") &&
          !href.startsWith("mailto:") &&
          !href.startsWith("javascript:")
        ) {
          a.setAttribute("href", proxyUrl(href, target));
        }
      }

      const proxiedHtml = doc.documentElement?.outerHTML || html;
      return new Response(proxiedHtml, {
        status: proxiedRes.status,
        headers: new Headers({
          ...Object.fromEntries(headers.entries()),
          "content-type": "text/html; charset=utf-8",
        }),
      });
    }

    return new Response(proxiedRes.body, {
      status: proxiedRes.status,
      headers,
    });
  } catch (err) {
    return new Response(`Proxy error: ${err}`, { status: 500 });
  }
});

console.log("DuckDuckGo-friendly proxy running");
