async function getFaviconHash() {
  const link = document.querySelector("link[rel='icon'], link[rel='shortcut icon']");
  if (!link || !link.href) return null;

  try {
    const res = await fetch(link.href);
    const buffer = await res.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    return { hash: hashHex, url: link.href };
  } catch (err) {
    console.error("favicon取得エラー:", err);
    return null;
  }
}

async function detectBrandByKeywords(brandList) {
  const pageText = document.body.innerText.toLowerCase();
  for (const entry of brandList) {
    for (const keyword of entry.keywords) {
      if (pageText.includes(keyword.toLowerCase())) {
        chrome.runtime.sendMessage({
          type: "brandKeywordMatch",
          brand: entry.brand,
          keyword: keyword
        });
        break;
      }
    }
  }
}

function collectPageData() {
  return {
    title: [document.title],
    hostname: window.location.hostname,
    dom: document.documentElement.outerHTML,
    html: document.documentElement.innerHTML,
    js: Array.from(document.scripts).map(s => s.textContent || ""),
    css: Array.from(document.styleSheets).map(s => s.href || ""),
    cookies: document.cookie.split("; "),
    headers: [],
    requests: []
  };
}

(async () => {
  const pageData = collectPageData();
  chrome.runtime.sendMessage({ type: "evaluateIOK", data: pageData });

  const favicon = await getFaviconHash();
  if (favicon) {
    chrome.runtime.sendMessage({ type: "faviconHash", hash: favicon.hash, url: favicon.url });
  }

  try {
    const res = await fetch(chrome.runtime.getURL("rules/brands.json"));
    const brandList = await res.json();
    await detectBrandByKeywords(brandList);
  } catch (err) {
    console.error("ブランド設定ファイルの読み込みエラー:", err);
  }
})();
