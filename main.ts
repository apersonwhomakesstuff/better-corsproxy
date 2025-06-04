import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";
const PROXY_ORIGIN = "https://better-corsproxy.deno.dev";

function proxyUrl(rawUrl: string, base: string): string {
  try {
    let urlStr = rawUrl.trim();
    if (!urlStr.match(/^https?:\/\//)) {
      urlStr = "https://" + urlStr; // prepend https if missing
    }
    const absoluteUrl = new URL(urlStr, base).href;

    if (absoluteUrl.startsWith(PROXY_ORIGIN)) return rawUrl; // avoid double proxy

    return `${PROXY_ORIGIN}/?url=${encodeURIComponent(absoluteUrl)}`;
  } catch {
    return rawUrl;
  }
}

function buildDuckDuckGoUrl(urlObj: URL): string | null {
  const q = urlObj.searchParams.get("q");
  if (q) {
    const t = urlObj.searchParams.get("t") || "h_";
    const ia = urlObj.searchParams.get("ia");
    const iax = urlObj.searchParams.get("iax");
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
    const headers = new Headers(req.headers);
    headers.set("User-Agent", USER_AGENT);
    headers.set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
    headers.set("Accept-Language", "en-US,en;q=0.9");
    headers.set("Connection", "keep-alive");

    const proxiedRes = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      redirect: "manual",
    });

    const contentType = proxiedRes.headers.get("content-type") || "";
    const responseHeaders = new Headers(proxiedRes.headers);
    responseHeaders.set("Content-Security-Policy", "frame-ancestors 'none';");
    responseHeaders.set("X-Frame-Options", "DENY");
    responseHeaders.set("Access-Control-Allow-Origin", "*");

    if (contentType.includes("text/html")) {
      const html = await proxiedRes.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      if (!doc) return new Response("Failed to parse HTML", { status: 500 });

      // Rewrite <img> src
      for (const img of doc.querySelectorAll("img")) {
        const src = img.getAttribute("src");
        if (src) img.setAttribute("src", proxyUrl(src, target));
        // Also fix srcset attribute if present
        const srcset = img.getAttribute("srcset");
        if (srcset) {
          const newSrcset = srcset
            .split(",")
            .map((entry) => {
              const [urlPart, size] = entry.trim().split(/\s+/);
              return `${proxyUrl(urlPart, target)}${size ? " " + size : ""}`;
            })
            .join(", ");
          img.setAttribute("srcset", newSrcset);
        }
      }

      // Rewrite <script> src
      for (const script of doc.querySelectorAll("script")) {
        const src = script.getAttribute("src");
        if (src) script.setAttribute("src", proxyUrl(src, target));
      }

      // Rewrite <link rel=stylesheet>
      for (const link of doc.querySelectorAll("link[rel=stylesheet]")) {
        const href = link.getAttribute("href");
        if (href) link.setAttribute("href", proxyUrl(href, target));
      }

      // Rewrite inline CSS url() in <style> and style attributes
      for (const styleTag of doc.querySelectorAll("style")) {
        let cssText = styleTag.textContent;
        if (cssText) {
          cssText = cssText.replace(/url\(["']?([^"')]+)["']?\)/g, (_, url) => `url(${proxyUrl(url, target)})`);
          styleTag.textContent = cssText;
        }
      }
      for (const el of doc.querySelectorAll("[style]")) {
        let styleAttr = el.getAttribute("style");
        if (styleAttr) {
          styleAttr = styleAttr.replace(/url\(["']?([^"')]+)["']?\)/g, (_, url) => `url(${proxyUrl(url, target)})`);
          el.setAttribute("style", styleAttr);
        }
      }

      // Rewrite <a> href links except anchors, mailto, javascript
      for (const a of doc.querySelectorAll("a")) {
        const href = a.getAttribute("href");
        if (
          href &&
          !href.startsWith("#") &&
          !href.startsWith("mailto:") &&
          !href.startsWith("javascript:") &&
          !href.startsWith("tel:")
        ) {
          a.setAttribute("href", proxyUrl(href, target));
        }
      }

      const proxiedHtml = doc.documentElement?.outerHTML || html;
      return new Response(proxiedHtml, {
        status: proxiedRes.status,
        headers: new Headers({
          ...Object.fromEntries(responseHeaders.entries()),
          "content-type": "text/html; charset=utf-8",
        }),
      });
    }

    // For non-HTML (images, scripts, css, etc), just pipe as-is
    return new Response(proxiedRes.body, {
      status: proxiedRes.status,
      headers: responseHeaders,
    });
  } catch (err) {
    return new Response(`Proxy error: ${err}`, { status: 500 });
  }
});

console.log("better-corsproxy running at " + PROXY_ORIGIN);
