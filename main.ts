import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

const PROXY_ORIGIN = "https://better-corsproxy.deno.dev";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

function proxyUrl(rawUrl, base) {
  try {
    const absolute = new URL(rawUrl, base).href;
    if (absolute.startsWith(PROXY_ORIGIN)) return rawUrl;
    return `${PROXY_ORIGIN}/?url=${encodeURIComponent(absolute)}`;
  } catch {
    return rawUrl;
  }
}

function rewriteMetaRefresh(doc, base) {
  for (const meta of doc.querySelectorAll('meta[http-equiv="refresh"]')) {
    const content = meta.getAttribute("content");
    if (content) {
      const match = content.match(/\d+;\s*url=(.+)/i);
      if (match) {
        const proxied = proxyUrl(match[1], base);
        meta.setAttribute("content", `0; url=${proxied}`);
      }
    }
  }
}

const server = Deno.serve(async (req) => {
  const url = new URL(req.url);
  let target = url.searchParams.get("url");

  if (!target) {
    const q = url.searchParams.get("q");
    if (q) target = `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
  }

  if (!target) {
    return new Response("Missing ?url parameter", { status: 400 });
  }

  if (!/^https?:\/\//i.test(target)) {
    target = `https://${target}`;
  }

  try {
    const headers = new Headers({
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Connection": "keep-alive",
    });

    const proxiedRes = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    const contentType = proxiedRes.headers.get("content-type") || "";
    const newHeaders = new Headers(proxiedRes.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("X-Frame-Options", "DENY");
    newHeaders.set("Content-Security-Policy", "frame-ancestors 'none'");

    if (contentType.includes("text/html")) {
      const html = await proxiedRes.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (!doc) return new Response("Failed to parse HTML", { status: 500 });

      rewriteMetaRefresh(doc, target);

      for (const tag of doc.querySelectorAll("img[src], script[src], iframe[src], source[src], video[src], audio[src]")) {
        const src = tag.getAttribute("src");
        if (src) tag.setAttribute("src", proxyUrl(src, target));
      }
      for (const tag of doc.querySelectorAll("link[href], a[href], area[href], form[action]")) {
        const attr = tag.hasAttribute("href") ? "href" : "action";
        const val = tag.getAttribute(attr);
        if (val && !val.startsWith("#") && !val.startsWith("mailto:")) {
          tag.setAttribute(attr, proxyUrl(val, target));
        }
      }

      const proxiedHtml = `<!DOCTYPE html>\n${doc.documentElement?.outerHTML}`;
      newHeaders.set("content-type", "text/html; charset=utf-8");

      return new Response(proxiedHtml, {
        status: proxiedRes.status,
        headers: newHeaders,
      });
    }

    return new Response(proxiedRes.body, {
      status: proxiedRes.status,
      headers: newHeaders,
    });
  } catch (err) {
    return new Response(`Proxy error: ${err}`, { status: 500 });
  }
});

console.log("better-corsproxy with anti-eject measures is running");
