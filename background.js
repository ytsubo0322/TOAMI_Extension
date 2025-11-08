import yaml from 'js-yaml';

let sigmaRules = [];
let brandList = [];
let redirectChains = {};
let redirectDetails = {};
let currentDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// Load Sigma rules
async function loadSigmaRules() {
  const rulePaths = [
    'rules/ioks/rule1.yml',
    'rules/ioks/rule2.yml'
  ];
  const rules = [];
  for (const path of rulePaths) {
    const res = await fetch(chrome.runtime.getURL(path));
    const text = await res.text();
    const rule = yaml.load(text);
    rules.push(rule);
  }
  sigmaRules = rules;
}

// Load brand config
async function loadBrandConfig() {
  const res = await fetch(chrome.runtime.getURL("rules/brands.json"));
  brandList = await res.json();
}

// Evaluate Sigma rules
function evaluateSigma(input, rules) {
  const matches = [];
  for (const rule of rules) {
    const selection = rule?.detection?.selection || {};
    let match = true;
    for (const key in selection) {
      const value = selection[key];
      if (key.includes('|contains')) {
        const field = key.split('|')[0];
        if (!input[field]?.some(item => item.includes(value))) {
          match = false;
          break;
        }
      } else {
        if (input[key] !== value) {
          match = false;
          break;
        }
      }
    }
    if (match) matches.push(rule.title || rule.id);
  }
  return matches;
}

// Capture screenshot with UTC timestamp
function captureScreenshotWithTimestamp(tabId, callback) {
  chrome.tabs.captureVisibleTab(null, { format: "png" }, async (dataUrl) => {
    const image = new Image();
    image.src = dataUrl;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);

    const timestamp = new Date().toISOString().replace("T", " ").split(".")[0] + " UTC";
    ctx.font = "16px sans-serif";
    ctx.fillStyle = "white";
    ctx.textAlign = "right";
    ctx.fillText(timestamp, canvas.width - 10, canvas.height - 10);

    const finalDataUrl = canvas.toDataURL("image/png");
    callback(finalDataUrl);
  });
}

// Save log to chrome.storage.local
function saveToamiLog(logData) {
  const timestamp = new Date().toISOString();
  const dateKey = timestamp.slice(0, 10); // YYYY-MM-DD
  const monthKey = timestamp.slice(0, 7).replace("-", ""); // YYYYMM
  const fileKey = `logs/${monthKey}/toami_${dateKey}.json`;

  const logEntry = {
    ...logData,
    datetime: timestamp,
    log_meta: {
      format: "TOAMI_PoC_v1"
    }
  };

  chrome.storage.local.get({ [fileKey]: [] }, (result) => {
    const logs = result[fileKey];
    logs.push(logEntry);
    chrome.storage.local.set({ [fileKey]: logs }, () => {
      console.log("📝 TOAMIログ保存:", logEntry);
    });
  });
}

// Track redirects
chrome.webRequest.onBeforeRedirect.addListener(
  (details) => {
    const tabId = details.tabId;
    if (!redirectChains[tabId]) redirectChains[tabId] = [];
    redirectChains[tabId].push(details.redirectUrl);

    if (!redirectDetails[tabId]) redirectDetails[tabId] = [];
    redirectDetails[tabId].push({
      url: details.url,
      timestamp: new Date().toISOString(),
      status: details.statusCode,
      headers: details.responseHeaders?.reduce((acc, h) => {
        acc[h.name.toLowerCase()] = h.value;
        return acc;
      }, {}) || {}
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Final response and screenshot
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const tabId = details.tabId;
    const finalUrl = details.url;

    if (details.statusCode >= 200 && details.statusCode < 300) {
      chrome.tabs.get(tabId, async (tab) => {
        captureScreenshotWithTimestamp(tabId, async (screenshotDataUrl) => {
          const res = await fetch(finalUrl);
          const htmlText = await res.text();
          const parser = new DOMParser();
          const doc = parser.parseFromString(htmlText, "text/html");

          const input = {
            title: [doc.title],
            hostname: new URL(finalUrl).hostname,
            dom: doc.documentElement.outerHTML,
            html: htmlText,
            js: Array.from(doc.querySelectorAll("script")).map(s => s.textContent || ""),
            css: Array.from(doc.querySelectorAll("link[rel='stylesheet']")).map(l => l.href),
            cookies: [],
            headers: [],
            requests: redirectChains[tabId] || []
          };

          if (sigmaRules.length === 0) await loadSigmaRules();
          const matchedSigmaRules = evaluateSigma(input, sigmaRules);

          const responseHeaders = details.responseHeaders?.reduce((acc, h) => {
            acc[h.name.toLowerCase()] = h.value;
            return acc;
          }, {}) || {};

          const logData = {
            tabId: tabId,
            origin_url: redirectChains[tabId]?.[0] || finalUrl,
            final_url: finalUrl,
            redirect_route: redirectDetails[tabId] || [],
            http_status_code: details.statusCode,
            response_headers: responseHeaders,
            page_title: doc.title,
            favicon_url: "", // filled by content_script
            favicon_hash: "", // filled by content_script
            screenshot: screenshotDataUrl,
            screenshot_path: `screenshots/${new Date().toISOString().replace(/[:]/g, "-")}_tab${tabId}.png`,
            html: htmlText,
            requests: input.requests,
            user_agent: navigator.userAgent,
            detections: {
              favicon_hash: [],
              brand_keyword: [],
              iok_match: matchedSigmaRules
            }
          };

          saveToamiLog(logData);
        });
      });
    }
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

// Message listener
chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (msg.type === "evaluateIOK") {
    if (sigmaRules.length === 0) await loadSigmaRules();
    const matches = evaluateSigma(msg.data, sigmaRules);
    if (matches.length > 0) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "TOAMI-投網- IOK検知",
        message: `一致したルール: ${matches.join(", ")}`,
        priority: 2
      });
    }
    sendResponse({ matches });
  }

  if (msg.type === "faviconHash") {
    if (brandList.length === 0) await loadBrandConfig();
    const match = brandList.find(entry => entry.hash === msg.hash);
    if (match) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon48.png",
        title: "TOAMI-投網- ブランド判定",
        message: `ブランド: ${match.brand}（favicon一致）`,
        priority: 1
      });
    }
  }

  if (msg.type === "brandKeywordMatch") {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon48.png",
      title: "TOAMI-投網- ブランド判定",
      message: `ブランド: ${msg.brand}（キーワード一致: ${msg.keyword}）`,
      priority: 1
    });
  }
});
