const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const crypto = require("crypto");
const fs = require("fs");
let chromium = null;
try { chromium = require("playwright-core").chromium; } catch (_) { chromium = null; }

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, "omkar.db"));
db.pragma("journal_mode=WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings(
  courier TEXT PRIMARY KEY,
  enabled INTEGER DEFAULT 0,
  api_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  api_secret TEXT DEFAULT '',
  user_id TEXT DEFAULT '',
  password TEXT DEFAULT '',
  app_key TEXT DEFAULT '',
  auth_mode TEXT DEFAULT 'JSON_BODY'
);
CREATE TABLE IF NOT EXISTS shipments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  awb TEXT UNIQUE NOT NULL,
  courier TEXT NOT NULL,
  status TEXT DEFAULT 'PENDING',
  location TEXT DEFAULT '',
  destination TEXT DEFAULT '',
  last_updated TEXT,
  due_date TEXT DEFAULT '',
  booking_date TEXT DEFAULT '',
  transaction_no TEXT DEFAULT '',
  pod_url TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tracking_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL,
  status TEXT,
  location TEXT,
  event_time TEXT,
  description TEXT,
  FOREIGN KEY(shipment_id) REFERENCES shipments(id)
);
`);

// Upgrade older Phase-2 databases safely.
for (const sql of [
  "ALTER TABLE shipments ADD COLUMN due_date TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN booking_date TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN transaction_no TEXT DEFAULT ''",
  "ALTER TABLE shipments ADD COLUMN pod_url TEXT DEFAULT ''",
  "ALTER TABLE settings ADD COLUMN user_id TEXT DEFAULT ''",
  "ALTER TABLE settings ADD COLUMN password TEXT DEFAULT ''",
  "ALTER TABLE settings ADD COLUMN app_key TEXT DEFAULT ''",
  "ALTER TABLE settings ADD COLUMN auth_mode TEXT DEFAULT 'JSON_BODY'"
]) {
  try { db.exec(sql); } catch (_) { /* column already exists */ }
}

db.prepare("INSERT OR IGNORE INTO settings(courier) VALUES('TRACKON')").run();

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

const now = () => new Date().toISOString();

function getSetting() {
  return db.prepare("SELECT * FROM settings WHERE courier='TRACKON'").get();
}

function getShipment(awb) {
  const s = db.prepare("SELECT * FROM shipments WHERE UPPER(awb)=UPPER(?)").get(awb);
  if (!s) return null;
  s.events = db.prepare(
    "SELECT status,location,event_time,description FROM tracking_events WHERE shipment_id=? ORDER BY event_time DESC"
  ).all(s.id);
  return s;
}

function safeJson(value) {
  try { return JSON.parse(value); } catch (_) { return null; }
}

function firstValue(obj, paths) {
  for (const p of paths) {
    let cur = obj;
    for (const part of p.split(".")) {
      if (cur === null || cur === undefined) break;
      cur = cur[part];
    }
    if (cur !== undefined && cur !== null && String(cur).trim() !== "") return cur;
  }
  return "";
}

function normaliseTrackonResponse(raw, awb) {
  // Trackon's official Customer Tracking API returns:
  // { summaryTrack: {...}, lstDetails: [...], ResponseStatus: {...} }
  // Keep compatibility with older/alternate response shapes too.
  const data = typeof raw === "object" && raw !== null ? raw : {};
  const summary = data.summaryTrack || data.SummaryTrack ||
                  (data.data && (data.data.summaryTrack || data.data.SummaryTrack)) || {};
  const responseStatus = data.ResponseStatus || data.responseStatus || {};
  const apiMessage = String(firstValue(responseStatus, ["Message", "message"]) || "");

  if (apiMessage && !/^success$/i.test(apiMessage)) {
    const apiErrors = firstValue(responseStatus, ["Errors", "errors"]);
    const err = new Error(`Trackon API response: ${apiMessage}${apiErrors ? " — " + String(apiErrors) : ""}`);
    err.code = "TRACKON_API_RESPONSE_ERROR";
    throw err;
  }

  const detailCandidates = [
    data.lstDetails, data.LstDetails, data.LSTDETAILS,
    data.data && data.data.lstDetails,
    data.data && data.data.LstDetails,
    summary.lstDetails, summary.LstDetails
  ];
  let details = detailCandidates.find(Array.isArray) || [];

  const get = (obj, paths) => firstValue(obj || {}, paths);
  const summaryStatus = String(get(summary, [
    "CURRENT_STATUS", "Current_Status", "current_status",
    "CURRENTSTATUS", "status", "Status", "currentStatus"
  ]) || get(data, ["CURRENT_STATUS", "current_status", "status", "Status"]) || "TRACKING AVAILABLE");

  const summaryLocation = String(get(summary, [
    "CURRENT_CITY", "current_city", "CURRENT_CITY_NAME", "location", "Location"
  ]) || "");
  const destination = String(get(summary, ["DESTINATION", "destination", "Destination"]) || "");
  const dueDate = String(get(summary, ["DUE_DATE", "DueDate", "dueDate", "deliveryDueDate"]) || "");
  const bookingDate = String(get(summary, ["BOOKING_DATE", "BookingDate", "booking_date"]) || "");
  const transactionNo = String(get(summary, ["TRANSACTION_NO", "TransactionNo", "transaction_no"]) || "");
  const podUrl = String(get(summary, ["POD_URL", "PODUrl", "podUrl", "podLink"]) || "");
  const summaryDate = get(summary, ["EVENTDATE", "EventDate", "eventDate", "lastUpdated"]);
  const summaryTime = get(summary, ["EVENTTIME", "EventTime", "eventTime"]);
  const summaryUpdated = [summaryDate, summaryTime].filter(Boolean).join(" ");

  const normalEvents = details.map((e) => {
    const status = String(get(e, [
      "CURRENT_STATUS", "current_status", "CURRENTSTATUS",
      "status", "Status", "Event", "event", "description", "Description"
    ]) || summaryStatus);
    const location = String(get(e, [
      "CURRENT_CITY", "current_city", "CURRENT_CITY_NAME", "location", "Location", "city", "City"
    ]) || "");
    const eventDate = get(e, ["EVENTDATE", "EventDate", "eventDate", "event_time", "eventTime", "Date"]);
    const eventTime = get(e, ["EVENTTIME", "EventTime", "eventTime"]);
    const eventStamp = [eventDate, eventTime].filter(Boolean).join(" ");
    const code = String(get(e, ["TRACKING_CODE", "TrackingCode", "tracking_code"]) || "");
    return {
      status,
      location,
      event_time: eventStamp || String(get(e, ["event_time", "timestamp", "dateTime", "datetime", "Date"]) || ""),
      transaction_no: String(get(e, ["TRANSACTION_NO", "TransactionNo", "transaction_no"]) || ""),
      description: [status, code ? `Tracking Code: ${code}` : ""].filter(Boolean).join(" • ")
    };
  }).filter(e => e.status || e.location || e.event_time || e.description);

  // Some API responses may have a useful summary but an empty detail array.
  if (!normalEvents.length) {
    normalEvents.push({
      status: summaryStatus,
      location: summaryLocation,
      event_time: summaryUpdated || now(),
      transaction_no: transactionNo,
      description: "Current status received from Trackon Customer Tracking API."
    });
  }

  const latest = normalEvents[0] || {};
  return {
    awb: String(get(summary, ["AWBNO", "AWBNo", "awb", "awbNo"]) || awb),
    courier: "TRACKON",
    status: summaryStatus || latest.status || "TRACKING AVAILABLE",
    location: summaryLocation || latest.location || "",
    destination,
    due_date: dueDate,
    booking_date: bookingDate,
    transaction_no: transactionNo || latest.transaction_no || "",
    pod_url: podUrl,
    last_updated: summaryUpdated || latest.event_time || now(),
    events: normalEvents,
    raw: data
  };
}

function chromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_BIN,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe") : "",
    process.env["PROGRAMFILES(X86)"] ? path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe") : "",
    "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"
  ].filter(Boolean);
  return candidates.find(x => { try { return require("fs").existsSync(x); } catch (_) { return false; } }) || null;
}

// Very short cache for repeated public-page lookups. This is not used for API mode.
const trackonPublicCache = new Map();
const TRACKON_PUBLIC_CACHE_MS = 20000;

// Safe performance diagnostics: never log credentials or full AWB values.
function trackonTiming(label, startedAt, details = "") {
  const elapsedMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6);
  console.log(`[Trackon timing] ${label} ${elapsedMs}ms${details ? ` | ${details}` : ""}`);
}
function trackonAwbTag(awb) {
  const value = String(awb || "");
  return `awbSuffix=${value.slice(-4) || "none"}`;
}

// Reuse one Chromium process for Trackon public tracking requests. Launching a
// fresh browser for every AWB adds significant startup overhead on cloud hosts.
let trackonBrowserPromise = null;
let trackonReusablePage = null;
// A single reusable page must not process two AWBs at once.
let trackonPublicQueue = Promise.resolve();
async function getTrackonBrowser(executablePath) {
  if (!chromium) throw Object.assign(new Error("Playwright Core is not installed."), { code: "PLAYWRIGHT_MISSING" });
  if (!trackonBrowserPromise) {
    trackonBrowserPromise = chromium.launch({ executablePath, headless: true }).catch(err => {
      trackonBrowserPromise = null;
      throw err;
    });
  }
  let browser = await trackonBrowserPromise;
  if (!browser.isConnected()) {
    trackonReusablePage = null;
    trackonBrowserPromise = chromium.launch({ executablePath, headless: true }).catch(err => {
      trackonBrowserPromise = null;
      throw err;
    });
    browser = await trackonBrowserPromise;
  }
  return browser;
}
async function getTrackonReusablePage(browser) {
  if (!trackonReusablePage || trackonReusablePage.isClosed()) {
    trackonReusablePage = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
    });
    await trackonReusablePage.route("**/*", route => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) return route.abort();
      return route.continue();
    });
    trackonReusablePage.on("close", () => { trackonReusablePage = null; });
  }
  return trackonReusablePage;
}
async function callTrackonPublicPage(awb, trackType = "AWB") {
  const task = trackonPublicQueue.then(() => callTrackonPublicPageUnlocked(awb, trackType));
  trackonPublicQueue = task.catch(() => {});
  return task;
}

async function callTrackonPublicPageUnlocked(awb, trackType = "AWB") {
  const requestStarted = process.hrtime.bigint();
  const awbTag = trackonAwbTag(awb);
  console.log(`[Trackon timing] start | ${awbTag} | type=${trackType}`);
  const cacheKey = `${String(awb).trim().toUpperCase()}|${trackType}`;
  const cached = trackonPublicCache.get(cacheKey);
  if (cached && Date.now() - cached.at < TRACKON_PUBLIC_CACHE_MS) {
    trackonTiming("cache-hit", requestStarted, awbTag);
    return JSON.parse(JSON.stringify(cached.result));
  }
  if (!chromium) {
    const e = new Error("Public Trackon mode needs Playwright Core. Run npm install first.");
    e.code = "PLAYWRIGHT_MISSING";
    throw e;
  }
  const executablePath = chromeExecutable();
  if (!executablePath) {
    const e = new Error("Chrome/Chromium was not found. Set CHROME_PATH or install Google Chrome.");
    e.code = "CHROME_NOT_FOUND";
    throw e;
  }

  const fs = require("fs");
  const debugDir = path.join(__dirname, "data", "trackon-debug");
  fs.mkdirSync(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const debugBase = path.join(debugDir, `${awb}_${stamp}`);

  const browserStarted = process.hrtime.bigint();
  const browser = await getTrackonBrowser(executablePath);
  trackonTiming("get-browser", browserStarted, awbTag);
  let page = null;
  let stage = "get-reusable-page";
  let pageStarted = process.hrtime.bigint();
  try {
    page = await getTrackonReusablePage(browser);
    // Response listeners are per-request; clear old listeners to avoid stale
    // network bodies and listener accumulation while reusing the same page.
    page.removeAllListeners("response");
    const networkBodies = [];
    page.on("response", async response => {
      try {
        const req = response.request();
        const type = req.resourceType();
        if (!["xhr", "fetch", "document"].includes(type)) return;
        const url = response.url();
        const ct = (response.headers()["content-type"] || "").toLowerCase();
        if (!/json|text|html|javascript/i.test(ct) && !/track|tracking|multi/i.test(url)) return;
        const body = await response.text().catch(() => "");
        if (body && body.length < 2000000) {
          networkBodies.push({ url, status: response.status(), contentType: ct, body: body.slice(0, 500000) });
        }
      } catch (_) {}
    });

    stage = "page-goto-or-reuse";
    pageStarted = process.hrtime.bigint();
    let target = null;
    const findTrackingInput = async () => {
      const inputs = page.locator("input:visible");
      const count = await inputs.count().catch(() => 0);
      let found = null;
      for (let i = 0; i < count; i++) {
        const el = inputs.nth(i);
        const meta = ((await el.getAttribute("placeholder").catch(() => "")) || "") + " " + ((await el.getAttribute("name").catch(() => "")) || "") + " " + ((await el.getAttribute("id").catch(() => "")) || "") + " " + ((await el.getAttribute("aria-label").catch(() => "")) || "");
        if (/awb|consign|tracking|order|ref/i.test(meta)) { found = el; break; }
      }
      if (!found && count) found = inputs.nth(0);
      return found;
    };
    // After a successful lookup Trackon usually leaves the public tracking
    // form on the result page. Reuse it instead of reloading the whole site.
    const sameTrackonPage = /(^|\.)trackon\.in$/i.test(new URL(page.url()).hostname) && page.url().includes("/courier-tracking");
    if (sameTrackonPage) target = await findTrackingInput();
    const reusedPage = Boolean(target);
    if (!reusedPage) {
      // Commit means the document navigation has started; do not wait for every
      // external asset before locating the tracking form.
      await page.goto("https://trackon.in/courier-tracking", { waitUntil: "commit", timeout: 20000 });
      const inputDeadline = Date.now() + 6000;
      while (Date.now() < inputDeadline && !target) {
        target = await findTrackingInput();
        if (!target) await page.waitForTimeout(150);
      }
    }
    trackonTiming(reusedPage ? "reuse-trackon-page" : "page-goto-domcontentloaded", pageStarted, awbTag);

    stage = "find-input";
    pageStarted = process.hrtime.bigint();
    if (!target) target = await findTrackingInput();
    if (!target) throw new Error("Trackon tracking input was not found on the public page.");
    trackonTiming("find-input", pageStarted, `${awbTag} | reusedPage=${reusedPage}`);

    stage = "fill-submit";
    pageStarted = process.hrtime.bigint();
    await target.fill(awb);
    if (trackType === "ORDER") {
      const order = page.getByText(/Order\s*\/\s*Ref\s*Number/i).first();
      if (await order.count()) await order.click().catch(() => {});
    }

    // Trackon's single AWB form is a normal POST form:
    //   action="/courier-tracking"
    //   name="awbSingleTrackingId"
    // The earlier versions tried to click a generic visible button. In the
    // captured debug page no POST request was generated, so the safest fix is
    // to submit the exact single-AWB form itself. This is the same public-page
    // form submission a normal browser performs; no private endpoint or
    // security challenge is bypassed.
    const singleForm = page.locator('form.singleAWBTrack').first();
    if (await singleForm.count()) {
      // IMPORTANT: Trackon's form contains <button name="submit">, which
      // shadows the native form.submit() method. Calling form.submit()
      // therefore throws "form.submit is not a function".
      // Click the real submit button so the browser sends the normal POST
      // request, including the button's name/value.
      const submitButton = singleForm.locator('button[type="submit"]').first();
      if (await submitButton.count()) {
        // Do not make the click wait for the entire page load; the result loop
        // below watches the rendered history and waits for it to stabilize.
        await submitButton.click({ noWaitAfter: true, timeout: 8000 });
      } else {
        // Native prototype fallback for pages where the button is absent.
        await singleForm.evaluate(form => HTMLFormElement.prototype.submit.call(form));
      }
    } else {
      await target.press("Enter").catch(() => {});
    }
    trackonTiming("fill-and-submit", pageStarted, awbTag);

    // Wait for the public page's complete history to render. The whole body can
    // keep changing because of unrelated page text, clocks, or banners. Instead,
    // stabilize the visible tracking-table rows (and fall back to body text only
    // when no table rows are available). This avoids waiting for irrelevant text
    // while still requiring the requested AWB, a date, an event, and repeated
    // identical history snapshots before parsing.
    stage = "wait-result";
    pageStarted = process.hrtime.bigint();
    let resultText = "";
    let previousSnapshot = "";
    let stablePolls = 0;
    let firstValidAt = 0;
    const resultDeadline = Date.now() + 10000;
    while (Date.now() < resultDeadline) {
      resultText = await page.locator("body").innerText().catch(() => "");
      const visibleRows = await page.locator("table:visible tr:visible").evaluateAll(rows =>
        rows.map(tr => String(tr.innerText || "").replace(/\s+/g, " ").trim())
          .filter(row => row && /\d{1,2}\/\d{1,2}\/\d{4}/.test(row))
      ).catch(() => []);
      const tableSnapshot = visibleRows.join("\n");
      const snapshot = tableSnapshot.length >= 20 ? tableSnapshot : resultText;
      const hasDate = /\d{1,2}\/\d{1,2}\/\d{4}/.test(resultText);
      const hasTrackingEvent =
        /delivered|in transit|out for delivery|transaction number|processing|dispatched|booking|arrived|received|undelivered|returned|picked up|manifest/i.test(resultText);
      const hasCurrentAwb = resultText.toUpperCase().includes(String(awb).trim().toUpperCase());
      const isValidResult = hasDate && hasTrackingEvent && hasCurrentAwb;

      if (isValidResult) {
        if (!firstValidAt) firstValidAt = Date.now();
        if (snapshot === previousSnapshot) stablePolls++;
        else stablePolls = 0;
        // Require three matching snapshots spanning at least 450ms. The
        // deadline remains as a safety fallback for pages that never stabilize.
        if (stablePolls >= 3 && Date.now() - firstValidAt >= 450) break;
      } else {
        stablePolls = 0;
        firstValidAt = 0;
      }
      previousSnapshot = snapshot;
      await page.waitForTimeout(150);
    }
    trackonTiming("wait-for-result", pageStarted, `${awbTag} | resultChars=${resultText.length} | stablePolls=${stablePolls}`);

    stage = "parse-result";
    pageStarted = process.hrtime.bigint();
    const bodyText = resultText || await page.locator("body").innerText().catch(() => "");
    if (!bodyText.toUpperCase().includes(String(awb).trim().toUpperCase())) {
      const e = new Error("Trackon did not show a result matching the requested AWB before the timeout. Please retry; previous shipment data was not reused.");
      e.code = "TRACKON_RESULT_NOT_READY";
      throw e;
    }
    // Avoid writing HTML, network dumps and screenshots on every successful AWB.
    // Diagnostics are saved only when a result cannot be read.
    const saveTrackonDebug = async () => {
      try {
        const html = await page.content().catch(() => "");
        fs.writeFileSync(`${debugBase}.txt`, bodyText, "utf8");
        fs.writeFileSync(`${debugBase}.html`, html, "utf8");
        fs.writeFileSync(`${debugBase}.network.json`, JSON.stringify(networkBodies, null, 2), "utf8");
        await page.screenshot({ path: `${debugBase}.png`, fullPage: true }).catch(() => {});
      } catch (_) {}
    };

    if (/captcha|verify you are human|access denied/i.test(bodyText)) {
      await saveTrackonDebug();
      const e = new Error("Trackon public page requested human verification. Public mode stopped; no CAPTCHA/security bypass is attempted.");
      e.code = "TRACKON_HUMAN_VERIFICATION";
      throw e;
    }

    const text = bodyText.replace(/\r/g, "");
    const dueMatch = text.match(/Consignment\s*No\s*:\s*([\s\S]*?)\s+DueDate\s*:\s*([^\n]+)/i);
    const dueDate = dueMatch ? dueMatch[2].trim() : "";
    const consignment = dueMatch ? dueMatch[1].replace(/\s+/g, " ").trim() : awb;

    let history = [];

    // 1) Read all visible table rows in one browser evaluation instead of many
    // Playwright round-trips. Keep every matching row so the complete history
    // is preserved rather than stopping after the first event.
    const tableRows = await page.locator("table:visible tr:visible").evaluateAll(rows =>
      rows.map(tr => Array.from(tr.querySelectorAll("th,td")).map(td =>
        String(td.innerText || "").replace(/\s+/g, " ").trim()
      )).filter(cells => cells.length >= 3)
    ).catch(() => []);
    for (const vals of tableRows) {
      const row = vals.join(" | ");
      if (/transaction\s*number/i.test(row) && /location/i.test(row) && /event/i.test(row)) continue;
      if (vals.some(v => /\d{1,2}\/\d{1,2}\/\d{4}/.test(v)) && vals.some(v => /[A-Z0-9_-]{6,}/i.test(v))) {
        const dateIndex = vals.findIndex(v => /\d{1,2}\/\d{1,2}\/\d{4}/.test(v));
        const eventIndex = vals.length - 1;
        const txIndex = vals.findIndex((v, idx) => idx !== dateIndex && /^[A-Z0-9_-]{6,}$/i.test(v));
        if (txIndex >= 0) {
          const locationIndex = txIndex + 1 < vals.length ? txIndex + 1 : -1;
          const evt = vals[eventIndex] || "";
          if (locationIndex >= 0) history.push({
            event_time: vals[dateIndex] || "",
            transaction_no: vals[txIndex] || "",
            location: vals[locationIndex] || "",
            status: evt || "TRACKING UPDATE",
            description: evt || "TRACKING UPDATE"
          });
        }
      }
    }

    // 2) Parse the actual public-page text layout. Historical Trackon pages
    // render each update as Event -> DATE -> Transaction Number -> Location.
    if (!history.length) {
      const lines = text.split("\n").map(x => x.trim()).filter(Boolean);
      const dateLine = /^(?:DATE\s+)?(\d{1,2}\/\d{1,2}\/\d{4})\s*(\d{1,2}:\d{2})(?:\s*(AM|PM))?$/i;
      const txLine = /^[A-Z0-9][A-Z0-9_-]{5,}$/i;
      const locHint = /\b(HUB|BRANCH|DELHI|MAHARASHTRA|GUJARAT|TAMILNADU|KARNATAKA|RAJASTHAN|PUNJAB|HARYANA|KOLKATA|MUMBAI|PUNE|CHENNAI|HYDERABAD|BENGALURU|BANGALORE|NAGPUR|NASHIK|KAREGAON)\b/i;
      for (let i = 0; i < lines.length; i++) {
        const dm = lines[i].match(dateLine);
        if (!dm) continue;
        let tx = "", loc = "", evt = "";
        // Search nearby lines for transaction and location. Event text is
        // normally immediately before the DATE line.
        for (let j = Math.max(0, i - 8); j < i; j++) {
          if (!tx && txLine.test(lines[j]) && lines[j].length <= 40) tx = lines[j];
          if (!loc && locHint.test(lines[j]) && lines[j].length <= 120) loc = lines[j];
        }
        for (let j = i + 1; j <= Math.min(lines.length - 1, i + 8); j++) {
          if (!tx && txLine.test(lines[j]) && lines[j].length <= 40) tx = lines[j];
          if (!loc && locHint.test(lines[j]) && lines[j].length <= 120) loc = lines[j];
          if (!evt && /^(?:S\/MENT|S\/MENT|IN\s|OUT\s|DELIVERED|PROCESSING|ARRIVED|PICKED|BOOKED|RECEIVED|UNDELIVERED|RETURNED|RTO|DELIVERY|MANIFEST|BAG\s)/i.test(lines[j])) evt = lines[j];
        }
        if (tx || loc || evt) {
          history.push({ event_time: `${dm[1]} ${dm[2]}${dm[3] ? " " + dm[3] : ""}`, transaction_no: tx, location: loc, status: evt || "TRACKING UPDATE", description: evt || "TRACKING UPDATE" });
        }
      }
    }

    // 3) Inspect captured XHR/fetch responses. This is still the normal public
    // page's own network traffic; we do not call a private endpoint or bypass
    // security controls.
    if (!history.length) {
      for (const item of networkBodies) {
        const b = item.body || "";
        if (!/transaction|location|event|consignment|tracking/i.test(b)) continue;
        const dateMatches = [...b.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})[^\d]{0,40}(\d{1,2}:\d{2})/g)];
        for (const dm of dateMatches) {
          const chunk = b.slice(Math.max(0, dm.index - 250), Math.min(b.length, dm.index + 1000)).replace(/\\u0026/g, "&");
          const tx = (chunk.match(/(?:transaction(?:No|Number)?|Transaction Number)[^A-Za-z0-9]{0,30}([A-Z0-9_-]{6,})/i) || [])[1] || "";
          const loc = (chunk.match(/(?:location|place|branch)[^A-Za-z0-9]{0,30}([^,\"}]{3,120})/i) || [])[1] || "";
          const evt = (chunk.match(/(?:event|status|description|activity)[^A-Za-z0-9]{0,30}([^,\"}]{3,160})/i) || [])[1] || "";
          if (tx || loc || evt) history.push({ event_time: `${dm[1]} ${dm[2]}`, transaction_no: tx, location: loc.trim(), status: evt.trim() || "TRACKING UPDATE", description: evt.trim() || "TRACKING UPDATE" });
        }
        if (history.length) break;
      }
    }

    // De-duplicate identical events.
    const seen = new Set();
    history = history.filter(x => {
      const key = [x.event_time, x.transaction_no, x.location, x.status].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!history.length) {
      await saveTrackonDebug();
      const e = new Error(`Trackon page returned no recognizable tracking rows. Debug files were saved in data\\trackon-debug. Page title: ${await page.title().catch(() => "")}. Current URL: ${page.url()}`);
      e.code = "TRACKON_ROW_FORMAT_UNKNOWN";
      throw e;
    }

    const latest = history[0];
    const finalResult = {
      awb: consignment || awb,
      courier: "TRACKON",
      status: latest.status || "TRACKING AVAILABLE",
      location: latest.location || "",
      destination: "",
      due_date: dueDate,
      booking_date: history.length ? history[history.length - 1].event_time : "",
      transaction_no: latest.transaction_no || "",
      pod_url: "",
      last_updated: latest.event_time || now(),
      events: history,
      source: "TRACKON_PUBLIC_PAGE"
    };
    trackonPublicCache.set(cacheKey, { at: Date.now(), result: finalResult });
    trackonTiming("parse-and-cache-result", pageStarted, `${awbTag} | events=${history.length}`);
    trackonTiming("TOTAL public tracking", requestStarted, `${awbTag} | result=success`);
    // Keep cache bounded for long-running service instances.
    if (trackonPublicCache.size > 300) {
      const oldestKey = trackonPublicCache.keys().next().value;
      if (oldestKey) trackonPublicCache.delete(oldestKey);
    }
    return finalResult;
  } catch (err) {
    trackonTiming("TOTAL public tracking failed", requestStarted, `${awbTag} | stage=${stage} | code=${err.code || "ERROR"}`);
    console.error(`[Trackon timing] failure details | ${awbTag} | stage=${stage} | ${String(err.message || err).slice(0, 240)}`);
    throw err;
  } finally {
    // Keep the reusable Trackon page and Chromium process alive for the next AWB.
    // If the page crashed or was closed by the upstream site, recreate it next time.
    if (page && page.isClosed()) trackonReusablePage = null;
  }
}


async function callIndiaPostPublicPage(consignment) {
  if (!chromium) {
    const e = new Error("India Post test mode needs Playwright Core. Run npm install first.");
    e.code = "PLAYWRIGHT_MISSING";
    throw e;
  }
  const executablePath = chromeExecutable();
  if (!executablePath) {
    const e = new Error("Chrome/Chromium was not found. Set CHROME_PATH or install Google Chrome.");
    e.code = "CHROME_NOT_FOUND";
    throw e;
  }

  const debugDir = path.join(__dirname, "data", "indiapost-debug");
  fs.mkdirSync(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const debugBase = path.join(debugDir, `${consignment}_${stamp}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  const pages = [];
  let resultPage = null;

  const normalise = x => String(x || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const dateRe = /(?:\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?|\b\d{4}-\d{2}-\d{2}\b(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)/i;
  const trackingWordRe = /(booked|booking|dispatched|dispatch|received|delivered|delivery|bagged|forwarded|in transit|transit|item status|event|tracking details|article|consignment|out for delivery|arrived|departed|manifest|return|rto)/i;
  const locationRe = /(post office|tmo|tmo,|s\.o\.|b\.o\.|h\.o\.|pune|hyderabad|sangareddy|mumbai|delhi|chennai|bengaluru|bangalore|maharashtra|telangana|karnataka|gujarat|rajasthan|punjab|haryana|kolkata|nashik|nagpur|india)/i;

  function resultText(page) {
    return page.locator("body").innerText().catch(() => "");
  }

  async function allVisibleText(page) {
    const parts = [];
    for (const frame of page.frames()) {
      try {
        const t = await frame.locator("body").innerText({ timeout: 1500 }).catch(() => "");
        if (t) parts.push(t);
      } catch (_) {}
    }
    return parts.join("\n");
  }

  async function capture(page, suffix="") {
    const txt = await allVisibleText(page);
    const html = await page.content().catch(() => "");
    fs.writeFileSync(`${debugBase}${suffix}.txt`, txt, "utf8");
    fs.writeFileSync(`${debugBase}${suffix}.html`, html, "utf8");
    await page.screenshot({ path: `${debugBase}${suffix}.png`, fullPage: true }).catch(() => {});
    return txt;
  }

  function looksLikeResult(text) {
    const t = String(text || "");
    const lower = t.toLowerCase();
    if (!lower.includes(String(consignment).toLowerCase())) return false;
    // Do not demand a date: some India Post responses initially show only
    // article summary/status before the event list is hydrated.
    const strong = /(item status|tracking details|article details|consignment details|delivery status|current status|event details|track details|consignment no\s*:|article type\s*:)/i.test(t);
    const date = dateRe.test(t);
    const eventWords = trackingWordRe.test(t);
    const hasResultLayout = /(?:location|office|status|event|date|time|article|consignment|booked at|destination)/i.test(t);
    // The current India Post portal uses a modern progress/timeline result
    // with labels such as Consignment No., Booked At and Destination.
    const modernResult = /consignment\s*no\s*:/i.test(t) && /booked at|article type|destination/i.test(t) && /(booked|dispatched|in transit|out for delivery|delivered)/i.test(t);
    return modernResult || (strong && hasResultLayout) || (date && eventWords && hasResultLayout);
  }

  function parseResult(text) {
    const history = [];
    const seen = new Set();
    const add = (time, status, location, transaction="") => {
      time = normalise(time); status = normalise(status); location = normalise(location); transaction = normalise(transaction);
      if (!status || status.length < 2) return;
      const key = `${time}|${status}|${location}|${transaction}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      history.push({ event_time: time, transaction_no: transaction, location, status, description: status });
    };

    const lines = String(text || "").split(/\r?\n/).map(normalise).filter(Boolean);

    // 1. Table-like / row text: date, location/office, event/status, optional transaction.
    for (let i = 0; i < lines.length; i++) {
      if (!dateRe.test(lines[i])) continue;
      const time = lines[i].match(dateRe)?.[0] || lines[i];
      const around = lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 5));
      const status = around.find(x => trackingWordRe.test(x) && x.length <= 180) || "TRACKING UPDATE";
      const location = around.find(x => locationRe.test(x) && x.length <= 180) || "";
      const tx = around.find(x => /^[A-Z0-9][A-Z0-9_-]{5,}$/i.test(x) && x.length <= 50 && !/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/.test(x)) || "";
      add(time, status, location, tx);
    }

    // 2. If labels are present, use the text immediately following them.
    for (let i = 0; i < lines.length; i++) {
      if (/^(?:status|current status|item status|event|activity)\s*:??$/i.test(lines[i])) {
        add("", lines[i + 1] || "TRACKING UPDATE", "", "");
      }
    }

    // 3. Preserve a useful summary even if the page has a card without dates.
    if (!history.length) {
      const statusLine = lines.find(x => trackingWordRe.test(x) && x.length >= 4 && x.length <= 180);
      if (statusLine && /consignment|article|item|status|tracking/i.test(text)) add("", statusLine, "", "");
    }
    return history;
  }

  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    pages.push(page);
    resultPage = page;
    // India Post's newer Track & Trace can open the result in a new tab.
    // Keep that tab in the same user-assisted tracking session so its data
    // can be parsed and returned to the Omkar page instead of leaving the
    // user stranded on the official India Post tab.
    browser.on("page", popup => {
      if (!pages.includes(popup)) pages.push(popup);
      popup.on("framenavigated", frame => {
        if (frame === popup.mainFrame()) lastUrl = frame.url();
      });
    });

    // India Post currently exposes Track & Trace from the main homepage and
    // also from this public legacy route. Prefer the direct tracking route so
    // the test does not depend on homepage widgets/animations.
    // The current India Post site serves Track & Trace from the homepage.
    // Keep several official public routes as fallbacks because the site can
    // redirect between its new and legacy pages depending on the session.
    const urls = [
      "https://www.indiapost.gov.in/",
      "https://indiapost.gov.in/",
      "https://www.indiapost.gov.in/Welcome.htm",
      "https://www.indiapost.gov.in/Index.asp",
      "https://www.indiapost.gov.in/Netscape/SpeedPost.html",
      "https://www.indiapost.gov.in/_layouts/15/dop.portal.tracking/trackconsignment.aspxTrack"
    ];
    let opened = false;
    let openErrors = [];
    for (const url of urls) {
      try {
        // Use commit instead of waiting for every asset. India Post currently
        // has pages that keep network requests open while CAPTCHA initializes.
        await page.goto(url, { waitUntil: "commit", timeout: 30000 }).catch(e => { openErrors.push(`${url}: ${e.message}`); });
        await page.waitForTimeout(4500);
        const t = await resultText(page);
        if (/Track and Trace Services|Consignment Number|Track 'N' Trace|Enter Consignment Number/i.test(t)) { opened = true; break; }
      } catch (e) {
        openErrors.push(`${url}: ${e.message}`);
      }
    }
    if (!opened) {
      await capture(page, '-open-failed').catch(() => {});
      throw new Error("India Post official Track & Trace page could not be opened. Please check Internet/India Post availability. A debug TXT/HTML/PNG was saved in data\indiapost-debug.");
    }

    // Select a real text/search/tel input only. Radio inputs must never be filled.
    const inputs = page.locator('input:visible');
    const count = await inputs.count();
    let target = null;
    for (let i = 0; i < count; i++) {
      const el = inputs.nth(i);
      const type = String((await el.getAttribute("type")) || "text").toLowerCase();
      if (!["text", "search", "tel"].includes(type)) continue;
      const meta = [await el.getAttribute("placeholder"), await el.getAttribute("name"), await el.getAttribute("id"), await el.getAttribute("aria-label")].filter(Boolean).join(" ");
      if (/consignment|article\s*number|reference\s*number|tracking/i.test(meta)) { target = el; break; }
    }
    if (!target) {
      for (let i = 0; i < count; i++) {
        const el = inputs.nth(i);
        const type = String((await el.getAttribute("type")) || "text").toLowerCase();
        if (["text", "search", "tel"].includes(type)) { target = el; break; }
      }
    }
    if (!target) throw new Error("India Post consignment input was not found on the official page.");
    await target.fill(consignment);
    await target.scrollIntoViewIfNeeded().catch(() => {});

    const before = await allVisibleText(page);
    fs.writeFileSync(`${debugBase}-before.txt`, before, "utf8");

    // Helpful diagnostics: if the official page itself cannot initialize the
    // CAPTCHA, report that specifically instead of blaming the result parser.
    if (/error fetching captcha|initializing captcha/i.test(before) && !/play audio captcha/i.test(before)) {
      // Do not fail immediately: CAPTCHA can initialize a moment later.
      await page.waitForTimeout(5000);
    }

    // V5 workflow: the user only has to type the CAPTCHA. As soon as the
    // CAPTCHA input contains text, the script clicks the official Search
    // button automatically. We never read, solve, infer, or bypass CAPTCHA.
    const deadline = Date.now() + 300000; // 5 minutes
    let finalText = before;
    let resultFound = false;
    let lastUrl = page.url();
    let autoSearchClicked = false;
    let searchObserved = false;

    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) lastUrl = frame.url();
    });

    async function clickOfficialSearch() {
      // Current India Post page uses #captcha-input and a visible Search button.
      // Try the current layout first, then generic visible buttons as fallback.
      const captcha = page.locator('#captcha-input:visible').first();
      if (await captcha.count()) {
        const value = String(await captcha.inputValue().catch(() => "")).trim();
        if (value.length >= 1) {
          const buttons = page.locator('button:visible, input[type="button"]:visible, input[type="submit"]:visible');
          const bc = await buttons.count();
          for (let i = 0; i < bc; i++) {
            const b = buttons.nth(i);
            const txt = ((await b.innerText().catch(() => "")) + " " + (await b.getAttribute('value').catch(() => ""))).replace(/\s+/g, ' ').trim();
            if (/^search$/i.test(txt) || /\bsearch\b/i.test(txt)) {
              await b.scrollIntoViewIfNeeded().catch(() => {});
              await b.click().catch(() => {});
              return true;
            }
          }
          // If the page changes its button markup, use the nearest text label.
          const searchText = page.getByText(/^Search$/i).last();
          if (await searchText.count()) {
            await searchText.click().catch(() => {});
            return true;
          }
        }
      }
      return false;
    }

    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      finalText = await allVisibleText(page);
      const lower = finalText.toLowerCase();
      if (!autoSearchClicked) {
        autoSearchClicked = await clickOfficialSearch();
        if (autoSearchClicked) searchObserved = true;
      }
      if (/invalid\s*captcha|captcha.*invalid/i.test(finalText)) {
        throw Object.assign(new Error("India Post returned an invalid CAPTCHA. Enter the CAPTCHA again and wait; Search is automatic in V5."), { code: "INDIAPOST_INVALID_CAPTCHA" });
      }
      if (/searching|loading|please wait/i.test(lower)) searchObserved = true;
      if (looksLikeResult(finalText)) { resultFound = true; resultPage = page; break; }
      // Check every tab/frame: the current India Post result route may open
      // separately from the CAPTCHA form.
      for (const p of pages.slice().reverse()) {
        const t = await allVisibleText(p).catch(() => "");
        if (looksLikeResult(t)) { finalText = t; resultFound = true; resultPage = p; lastUrl = p.url(); break; }
      }
      if (resultFound) break;
      if (/consignment.*not.*found|no record available|no data found/i.test(lower)) {
        break;
      }
    }

    const captured = await capture(resultPage || page, "-result");
    finalText = captured || finalText;

    if (!resultFound) {
      const hasCaptchaError = /error fetching captcha|unexpected response was received from the server|invalid\s*captcha/i.test(finalText);
      const msg = hasCaptchaError
        ? "India Post did not return tracking data because its CAPTCHA/service did not complete successfully. Refresh the India Post browser page, complete CAPTCHA, click Search, and try again. Debug TXT/HTML/PNG was saved in data/indiapost-debug."
        : "India Post Search was not followed by a readable tracking result within 5 minutes. Complete CAPTCHA and click Search in the India Post browser window. Debug TXT/HTML/PNG was saved in data/indiapost-debug.";
      throw Object.assign(new Error(msg + ` Current URL: ${lastUrl}`), { code: hasCaptchaError ? "INDIAPOST_CAPTCHA_OR_SERVICE_ERROR" : "INDIAPOST_RESULT_NOT_DETECTED" });
    }

    const history = parseResult(finalText);
    if (!history.length) {
      throw Object.assign(new Error("India Post returned a result page, but no readable event/status was found. Debug TXT/HTML/PNG was saved in data/indiapost-debug."), { code: "INDIAPOST_RESULT_PARSE_UNKNOWN" });
    }

    history.sort((a, b) => String(b.event_time).localeCompare(String(a.event_time)));
    const latest = history[0];
    const destinationMatch = finalText.match(/(?:destination|to)\s*[:\-]\s*([^\n]{2,100})/i);
    const bookingMatch = finalText.match(/(?:booking\s*date|booked\s*date)\s*[:\-]\s*([^\n]+)/i);
    return {
      awb: consignment,
      courier: "INDIA_POST",
      status: latest.status || "TRACKING AVAILABLE",
      location: latest.location || "",
      destination: destinationMatch ? normalise(destinationMatch[1]) : "",
      due_date: "",
      booking_date: bookingMatch ? normalise(bookingMatch[1]) : (history[history.length - 1].event_time || ""),
      transaction_no: latest.transaction_no || "",
      pod_url: "",
      last_updated: latest.event_time || now(),
      events: history,
      source: "INDIAPOST_PUBLIC_PAGE_USER_ASSISTED"
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function callMovinPublicPage(reference) {
  if (!chromium) {
    const e = new Error("MOVIN public tracking needs Playwright Core. Run npm install first.");
    e.code = "PLAYWRIGHT_MISSING"; throw e;
  }
  const executablePath = chromeExecutable();
  if (!executablePath) {
    const e = new Error("Chrome/Chromium was not found. Set CHROME_PATH or install Google Chrome.");
    e.code = "CHROME_NOT_FOUND"; throw e;
  }
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
    });
    await page.goto("https://www.movin.in/shipment/track", { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1800);

    // MOVIN hosts its tracking form in a third-party Shipsy iframe. Search all
    // frames so the form can be used even when the provider changes its frame URL.
    let input = null, formFrame = null;
    for (let attempt = 0; attempt < 20 && !input; attempt++) {
      for (const frame of page.frames()) {
        const fields = frame.locator('input:visible');
        const n = await fields.count().catch(() => 0);
        for (let i = 0; i < n; i++) {
          const candidate = fields.nth(i);
          const meta = [await candidate.getAttribute('placeholder').catch(() => ''),
                        await candidate.getAttribute('name').catch(() => ''),
                        await candidate.getAttribute('id').catch(() => ''),
                        await candidate.getAttribute('aria-label').catch(() => '')].join(' ');
          if (/reference|tracking|awb|consignment|shipment|waybill/i.test(meta)) {
            input = candidate; formFrame = frame; break;
          }
        }
        if (input) break;
      }
      if (!input) await page.waitForTimeout(1000);
    }
    if (!input) {
      throw Object.assign(new Error("MOVIN tracking form could not be found on the official page. Open https://www.movin.in/shipment/track and confirm the reference number field is available."), { code: "MOVIN_FORM_NOT_FOUND" });
    }
    await input.fill(reference);
    let submitted = false;
    // Prefer a nearby form submit; otherwise use visible buttons with a tracking label.
    const form = input.locator('xpath=ancestor::form[1]');
    if (await form.count().catch(() => 0)) {
      const submit = form.locator('button[type="submit"],input[type="submit"],button:visible').first();
      if (await submit.count().catch(() => 0)) { await submit.click({ timeout: 5000 }).catch(() => {}); submitted = true; }
    }
    if (!submitted) {
      const buttons = formFrame.locator('button:visible, input[type="submit"]:visible, [role="button"]:visible');
      const n = await buttons.count().catch(() => 0);
      for (let i = 0; i < n; i++) {
        const b = buttons.nth(i);
        const label = ((await b.innerText().catch(() => '')) + ' ' + (await b.getAttribute('aria-label').catch(() => '')) + ' ' + (await b.getAttribute('value').catch(() => ''))).trim();
        if (/track|search|submit|go/i.test(label)) { await b.click({ timeout: 5000 }).catch(() => {}); submitted = true; break; }
      }
    }
    if (!submitted) await input.press('Enter').catch(() => {});

    // MOVIN's tracking widget can show the status summary first and hide the
    // event timeline behind a "Details" / "View Details" control. Click that
    // control in the main page or any embedded frame before parsing the result.
    await page.waitForTimeout(1800);
    for (let detailAttempt = 0; detailAttempt < 3; detailAttempt++) {
      let clickedDetails = false;
      for (const frame of page.frames()) {
        const controls = frame.locator('button:visible, a:visible, [role="button"]:visible, summary:visible');
        const count = await controls.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const control = controls.nth(i);
          const label = (
            (await control.innerText().catch(() => '')) + ' ' +
            (await control.getAttribute('aria-label').catch(() => '')) + ' ' +
            (await control.getAttribute('title').catch(() => ''))
          ).replace(/\s+/g, ' ').trim();
          if (/^(view\s*)?details?(\s*(>|v|⌄|expand))?$/i.test(label) ||
              /view shipment details|show details|tracking details|view tracking/i.test(label)) {
            await control.click({ timeout: 2500 }).then(() => { clickedDetails = true; }).catch(() => {});
            if (clickedDetails) break;
          }
        }
        if (clickedDetails) break;
      }
      if (!clickedDetails) break;
      await page.waitForTimeout(900);
    }

    let finalText = '';
    const started = Date.now();
    while (Date.now() - started < 45000) {
      const pieces = [];
      for (const frame of page.frames()) {
        const t = await frame.locator('body').innerText({ timeout: 2000 }).catch(() => '');
        if (t) pieces.push(t);
      }
      finalText = pieces.join('\n');
      const lower = finalText.toLowerCase();
      const hasReference = lower.includes(reference.toLowerCase());
      // MOVIN's visible timeline may put date, time, status and location on
      // separate lines. Accept a dated status timeline even if the embedded
      // tracking widget omits the reference number from its rendered text.
      const hasTimeline = /tracking history|shipment history|current status|delivered|in transit|out for delivery|picked up|shipment booked|manifested|dispatched|exception|undelivered|reached at hub|\baccept\b|consignee|origin|destination/i.test(finalText);
      const hasDatedStatus = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/.test(finalText) && /delivered|in transit|out for delivery|undelivered|reached at hub|\baccept\b/i.test(finalText);
      if ((hasReference && hasTimeline) || hasDatedStatus) break;
      if (/not found|invalid reference|no tracking data|no record found|does not exist/i.test(lower)) {
        throw Object.assign(new Error("MOVIN could not find tracking data for this reference number. Check that you entered the new MOVIN Tracking ID, not an order number."), { code: "MOVIN_NOT_FOUND" });
      }
      await page.waitForTimeout(1000);
    }
    const clean = finalText.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const eventLines = [];
    const dateRe = /(?:\b\d{1,2}[\/\- ]\d{1,2}[\/\- ]\d{2,4}\b|\b\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}\b|\b\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\b)/;
    const statusRe = /booked|manifested|pickup|picked up|in transit|in-transit|out for delivery|delivered|delivery attempted|exception|undelivered|dispatched|arrived|departed|received|rto|return to origin|cancelled|shipment created|reached at hub|\baccept\b/i;
    for (let i = 0; i < clean.length; i++) {
      if (!dateRe.test(clean[i])) continue;
      // MOVIN's timeline renders date, time, status, and location as separate
      // rows (e.g. 05/10/2026 / 04:35 PM / Delivered / Chrompet Centre | CHENNAI).
      const nearby = clean.slice(i + 1, Math.min(clean.length, i + 5));
      const statusOffset = nearby.findIndex(x => statusRe.test(x));
      if (statusOffset < 0) continue;
      const statusLine = nearby[statusOffset];
      const timeLine = /\b\d{1,2}:\d{2}\s*(?:AM|PM)?\b/i.test(nearby[0] || '') ? nearby[0] : '';
      const locationCandidate = nearby.slice(statusOffset + 1).find(x =>
        x && !dateRe.test(x) && !/\b\d{1,2}:\d{2}\s*(?:AM|PM)?\b/i.test(x) &&
        !statusRe.test(x) && !/customer reference|reference no\.?|tracking|delivered$/i.test(x)
      ) || '';
      const eventTime = [clean[i], timeLine].filter(Boolean).join(' ');
      if (!eventLines.some(e => e.event_time === eventTime && e.status === statusLine)) {
        eventLines.push({ status: statusLine, location: locationCandidate, event_time: eventTime, transaction_no: '', description: statusLine });
      }
    }
    const latestStatus = eventLines.length ? eventLines[0].status : ([...clean].reverse().find(x => statusRe.test(x)) || '');
    const status = latestStatus || '';
    if (!status || (!finalText.toLowerCase().includes(reference.toLowerCase()))) {
      try {
        const fs = require("fs");
        const path = require("path");
        const debugDir = path.join(__dirname, "data", "movin-debug");
        fs.mkdirSync(debugDir, { recursive: true });
        fs.writeFileSync(path.join(debugDir, "last-visible-text.txt"),
          "URL: " + page.url() + "\\nREFERENCE: " + reference + "\\n\\n" + finalText,
          "utf8");
        await page.screenshot({ path: path.join(debugDir, "last-page.png"), fullPage: true }).catch(() => {});
      } catch (_) {}
      throw Object.assign(new Error("MOVIN official page opened, but the automated browser could not read the result. A visible Chrome window has been opened for this attempt. Check the MOVIN result there; diagnostic files are saved in data/movin-debug."), { code: "MOVIN_RESULT_NOT_READABLE" });
    }
    const getAfter = (label) => {
      const i = clean.findIndex(x => new RegExp('^' + label + '\\s*[:\\-]?$', 'i').test(x));
      return i >= 0 ? (clean[i+1] || '') : '';
    };
    const location = getAfter('Current Location') || getAfter('Location') || (eventLines[0] && eventLines[0].location) || '';
    const destination = getAfter('Destination') || getAfter('Destination City') || '';
    const booking = getAfter('Booking Date') || getAfter('Booked On') || '';
    return {
      awb: reference, courier: 'MOVIN', status, location, destination,
      due_date: '', booking_date: booking, transaction_no: '', pod_url: '',
      last_updated: (eventLines[0] && eventLines[0].event_time) || now(),
      events: eventLines.length ? eventLines.reverse() : [{ status, location, event_time: now(), transaction_no: '', description: 'Status read from MOVIN official tracking page.' }],
      source: 'MOVIN_PUBLIC_TRACKING_PAGE'
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

const tejTrackingCache = new Map();
const TEJ_TRACKING_CACHE_MS = 15000;

async function callTejPublicPage(consignment) {
  const tejCacheKey = String(consignment || "").trim().toUpperCase();
  const cachedTej = tejTrackingCache.get(tejCacheKey);
  if (cachedTej && Date.now() - cachedTej.at < TEJ_TRACKING_CACHE_MS) {
    console.log(`[TEJ timing] cache-hit | awbSuffix=${tejCacheKey.slice(-4)}`);
    return JSON.parse(JSON.stringify(cachedTej.result));
  }
  if (!chromium) {
    const e = new Error("Tej Courier website tracking needs Playwright Core. Run npm install first.");
    e.code = "PLAYWRIGHT_MISSING";
    throw e;
  }
  const executablePath = chromeExecutable();
  if (!executablePath) {
    const e = new Error("Chrome/Chromium was not found. Set CHROME_PATH or install Google Chrome.");
    e.code = "CHROME_NOT_FOUND";
    throw e;
  }
  const fs = require("fs");
  const debugDir = path.join(__dirname, "data", "tej-debug");
  fs.mkdirSync(debugDir, { recursive: true });
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
    });
    const pages = [page];
    browser.on("page", p => { if (!pages.includes(p)) pages.push(p); });
    // TEJ-only speed-up: skip non-essential media and don't wait for the full
    // document load. Trackon uses a different browser flow and is not changed.
    await page.route("**/*", route => {
      const type = route.request().resourceType();
      if (["image", "font", "media"].includes(type)) return route.abort();
      return route.continue();
    });
    const tejStartedAt = Date.now();
    await page.goto("https://www.tejcouriers.com/shipment-tracking.php", { waitUntil: "commit", timeout: 20000 });

    let input = null;
    const inputDeadline = Date.now() + 6000;
    while (Date.now() < inputDeadline && !input) {
      input = page.locator('input[placeholder*="Consignment" i]:visible').first();
      if (!(await input.count().catch(() => 0))) input = page.locator('input[type="text"]:visible').first();
      if (!(await input.count().catch(() => 0))) { input = null; await page.waitForTimeout(200); }
    }
    if (!input) {
      throw Object.assign(new Error("Tej Courier tracking input was not found on its official page."), { code: "TEJ_FORM_NOT_FOUND" });
    }
    await input.fill(String(consignment));
    let submit = page.getByRole("button", { name: /submit|track/i }).first();
    if (await submit.count().catch(() => 0)) {
      await submit.click({ timeout: 5000 }).catch(async () => { await input.press("Enter").catch(() => {}); });
    } else {
      const form = input.locator("xpath=ancestor::form[1]");
      if (await form.count().catch(() => 0)) await form.evaluate(el => el.requestSubmit()).catch(async () => { await input.press("Enter").catch(() => {}); });
      else await input.press("Enter").catch(() => {});
    }
    // Poll for the result instead of sleeping a fixed 2.2 seconds. This can
    // return sooner on fast responses while still allowing the TEJ page to load.
    let resultPage = page;
    let bodyText = "";
    let rows = [];
    const resultDeadline = Date.now() + 12000;
    while (Date.now() < resultDeadline) {
      for (const p of [...pages].reverse()) {
        const text = await p.locator("body").innerText().catch(() => "");
        const tableRows = await p.locator("table tr").evaluateAll(els => els.map(tr => Array.from(tr.querySelectorAll("th,td")).map(td => (td.innerText || "").trim()).filter(Boolean)).filter(r => r.length >= 2)).catch(() => []);
        if (tableRows.length || /tracking history|shipment details|tracking details|consignment/i.test(text)) {
          resultPage = p; bodyText = text; rows = tableRows;
          if (tableRows.length || /tracking history/i.test(text)) break;
        }
      }
      const hasDatedStatus = /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}\b/.test(bodyText) && /booked|booking|in transit|dispatched|delivered|out for delivery|tracking history/i.test(bodyText);
      if (rows.length || /tracking history/i.test(bodyText) || hasDatedStatus) break;
      await page.waitForTimeout(250);
    }
    console.log(`[TEJ timing] page-and-result ${Date.now() - tejStartedAt}ms | awbSuffix=${String(consignment).slice(-4)}`);

    const cleanRows = rows.filter(r => !/^(date|status|location)$/i.test(r.join(" ").trim()) && r.some(Boolean));
    let events = cleanRows.map(r => {
      // Some TEJ page versions expose history as table rows.
      const date = r[0] || "";
      const status = r[1] || r[0] || "Update";
      const location = r[2] || "";
      const description = r.slice(3).join(" | ");
      return { status, location, event_time: date, transaction_no: "", description };
    }).filter(e => e.status && !/^shipment details$/i.test(e.status));

    // Current TEJ public page may render Tracking History as plain text rather
    // than a table. The diagnostic text for AWB 19431451 shows:
    // Tracking History / 12/10/2026 12:52:00 / PCMC - Booking Inward Done.
    if (!events.length && bodyText) {
      const sectionAt = bodyText.search(/tracking history/i);
      const historyText = sectionAt >= 0 ? bodyText.slice(sectionAt) : bodyText;
      const lines = historyText.split(/\r?\n/).map(x => x.replace(/\s+/g, " ").trim()).filter(Boolean);
      const dateLine = /^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM)?))?$/i;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(dateLine);
        if (!m) continue;
        const description = lines[i + 1] || "";
        if (!description || /^(backed by|contact us|links|profile|service guide|copyright)/i.test(description)) continue;
        const locMatch = description.match(/^([^–—-]+?)\\s*[-–—]\\s*(.+)$/);
        const location = locMatch ? locMatch[1].trim() : "";
        const status = locMatch ? locMatch[2].trim() : description;
        const eventTime = [m[1], m[2] || ""].filter(Boolean).join(" ");
        events.push({ status, location, event_time: eventTime, transaction_no: "", description });
      }
    }

    if (!events.length) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const base = path.join(debugDir, `${String(consignment).replace(/[^a-z0-9_-]/gi, "_")}_${stamp}`);
      try {
        fs.writeFileSync(base + ".txt", `URL: ${resultPage.url()}\nAWB: ${consignment}\n\n${bodyText}`, "utf8");
        await resultPage.screenshot({ path: base + ".png", fullPage: true }).catch(() => {});
      } catch (_) {}
      throw Object.assign(new Error("Tej Courier official website did not return readable tracking rows. Diagnostic files were saved in data/tej-debug."), { code: "TEJ_RESULT_NOT_READABLE" });
    }

    const latest = events[0];
    const readDetail = label => {
      const escaped = label.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&");
      const match = bodyText.match(new RegExp("^\\s*" + escaped + "\\s*:\\s*(.+)$", "im"));
      return match ? match[1].trim() : "";
    };
    const origin = readDetail("Origin");
    const destination = readDetail("Destination");
    const eventText = `${latest.status || ""} ${latest.description || ""}`;
    const consignmentStatus = /booking inward done|booked|booking/i.test(eventText) ? "Booked"
      : (/delivered/i.test(eventText) && !/undelivered/i.test(eventText) ? "Delivered"
      : (/out for delivery/i.test(eventText) ? "Out for Delivery"
      : (/in transit|dispatched|reached at hub/i.test(eventText) ? "In Transit"
      : (latest.status || "TRACKING AVAILABLE"))));
    const tejResult = {
      awb: String(consignment), courier: "TEJ", status: consignmentStatus,
      location: latest.location || origin || "", destination, due_date: "",
      booking_date: latest.event_time || "", transaction_no: "", pod_url: "",
      last_updated: latest.event_time || now(), events,
      source: "TEJ_PUBLIC_TRACKING_PAGE",
      shipment_details: {
        origin, destination, pincode: readDetail("Pincode"),
        consignor: readDetail("Consignor"), consignee: readDetail("Consignee"),
        articles: readDetail("Articles")
      }
    };
    tejTrackingCache.set(tejCacheKey, { at: Date.now(), result: tejResult });
    if (tejTrackingCache.size > 200) tejTrackingCache.delete(tejTrackingCache.keys().next().value);
    return tejResult;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function callTrackon(awb, trackType = "AWB") {
  const s = getSetting();
  if (!s || !s.enabled) {
    const err = new Error("Trackon API is not enabled. Open Admin → Trackon API Settings.");
    err.code = "TRACKON_DISABLED";
    throw err;
  }
  if (!s.api_url) {
    const err = new Error("Trackon API URL is not configured. The User ID/Password/App Key are ready, but Trackon has not supplied the endpoint in the available document.");
    err.code = "TRACKON_API_URL_MISSING";
    throw err;
  }

  const url = new URL(s.api_url);
  const mode = String(s.auth_mode || "JSON_BODY").toUpperCase();
  const bodyObject = {
    UserID: s.user_id || "",
    Pass: s.password || "",
    AppKey: s.app_key || "",
    AWB: awb,
    Awb: awb,
    AWBNo: awb,
    TrackingNo: awb,
    trackingNumber: awb,
    TrackType: trackType,
    Type: trackType,
    RefType: trackType
  };

  const headers = { "Accept": "application/json", "User-Agent": "OMKAR-COURIER-SERVICES/3.0" };
  let requestUrl = url.toString();
  const options = { method: mode === "GET" ? "GET" : "POST", headers, signal: AbortSignal.timeout(20000) };

  if (mode === "BASIC_AUTH") {
    headers.Authorization = "Basic " + Buffer.from(`${s.user_id}:${s.password}`).toString("base64");
    headers.AppKey = s.app_key || "";
  } else if (mode === "APPKEY_HEADER") {
    headers.UserID = s.user_id || "";
    headers.Pass = s.password || "";
    headers.AppKey = s.app_key || "";
  } else if (mode === "QUERY") {
    url.searchParams.set("UserID", s.user_id || "");
    url.searchParams.set("Pass", s.password || "");
    url.searchParams.set("AppKey", s.app_key || "");
    url.searchParams.set(trackType === "ORDER" ? "OrderRef" : "AWB", awb);
    url.searchParams.set("TrackType", trackType);
    requestUrl = url.toString();
  } else if (mode === "GET") {
    // Trackon's Customer Shipment Tracking API document specifies these exact query names:
    // AWBNo, AppKey, userID, Password. Do not add credentials to logs.
    url.searchParams.set("AWBNo", awb);
    url.searchParams.set("AppKey", s.app_key || "");
    url.searchParams.set("userID", s.user_id || "");
    url.searchParams.set("Password", s.password || "");
    requestUrl = url.toString();
  } else {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(bodyObject);
  }

  let response;
  try {
    response = await fetch(requestUrl, options);
  } catch (fetchErr) {
    // Diagnostic logging intentionally includes only the host and error code,
    // never the query string because it contains API credentials.
    const causeCode = fetchErr && fetchErr.cause && fetchErr.cause.code;
    const safeCode = causeCode || fetchErr.code || fetchErr.name || "FETCH_ERROR";
    console.error("[Trackon API connection failed]", JSON.stringify({
      host: url.host,
      protocol: url.protocol,
      code: safeCode,
      name: fetchErr.name || "Error",
      message: fetchErr.message || "fetch failed"
    }));
    const err = new Error(`Trackon API connection failed (${safeCode}). Check Render Application Logs.`);
    err.code = "TRACKON_CONNECTION_FAILED";
    err.causeCode = safeCode;
    throw err;
  }
  const text = await response.text();
  const json = safeJson(text);
  if (!response.ok) {
    const err = new Error(`Trackon API returned HTTP ${response.status}. ${text.slice(0, 300)}`);
    err.code = "TRACKON_HTTP_ERROR";
    throw err;
  }
  if (json === null) {
    const err = new Error("Trackon API returned a non-JSON response. Check the API URL/authentication mode.");
    err.code = "TRACKON_NON_JSON";
    throw err;
  }
  return normaliseTrackonResponse(json, awb);
}

function saveLiveResult(result) {
  const stamp = result.last_updated || now();
  const old = db.prepare("SELECT id FROM shipments WHERE UPPER(awb)=UPPER(?)").get(result.awb);
  let shipmentId;
  if (old) {
    shipmentId = old.id;
    db.prepare("UPDATE shipments SET courier=?,status=?,location=?,destination=?,due_date=?,booking_date=?,transaction_no=?,pod_url=?,last_updated=? WHERE id=?")
      .run(result.courier || 'TRACKON', result.status, result.location, result.destination, result.due_date || '', result.booking_date || '', result.transaction_no || '', result.pod_url || '', stamp, shipmentId);
  } else {
    const x = db.prepare("INSERT INTO shipments(awb,courier,status,location,destination,due_date,booking_date,transaction_no,pod_url,last_updated,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(result.awb, result.courier || "TRACKON", result.status, result.location, result.destination, result.due_date || '', result.booking_date || '', result.transaction_no || '', result.pod_url || '', stamp, stamp);
    shipmentId = x.lastInsertRowid;
  }

  const insertEvent = db.prepare("INSERT INTO tracking_events(shipment_id,status,location,event_time,description) VALUES(?,?,?,?,?)");
  const tx = db.transaction(events => {
    for (const e of (events || [])) insertEvent.run(shipmentId, e.status, e.location, e.event_time || stamp, [e.transaction_no ? `Transaction No: ${e.transaction_no}` : "", e.description || ""].filter(Boolean).join(" • "));
  });
  tx(result.events || []);
  return getShipment(result.awb);
}

app.get("/api/track/:awb", async (req, res) => {
  const routeStarted = process.hrtime.bigint();
  const awb = String(req.params.awb || "").trim();
  const awbTag = trackonAwbTag(awb);
  const trackType = String(req.query.type || "AWB").toUpperCase() === "ORDER" ? "ORDER" : "AWB";
  if (!awb) return res.status(400).json({ error: "AWB is required" });

  try {
    const mode = String(req.query.mode || "API").toUpperCase();
    const courier = String(req.query.courier || "TRACKON").toUpperCase();
    let live;
    if (courier === "INDIA_POST") {
      live = await callIndiaPostPublicPage(awb);
    } else if (courier === "MOVIN") {
      live = await callMovinPublicPage(awb);
    } else if (courier === "TEJ") {
      live = await callTejPublicPage(awb);
    } else {
      live = mode === "PUBLIC" ? await callTrackonPublicPage(awb, trackType) : await callTrackon(awb, trackType);
    }
    const saved = saveLiveResult(live);
    trackonTiming("HTTP /api/track total", routeStarted, `${awbTag} | courier=${String(req.query.courier || "TRACKON").toUpperCase()} | mode=${String(req.query.mode || "API").toUpperCase()} | result=success`);
    return res.json(saved || live);
  } catch (err) {
    trackonTiming("HTTP /api/track failed", routeStarted, `${awbTag} | code=${err.code || "ERROR"}`);
    // If a local shipment exists, keep the local result available while clearly reporting live failure.
    const local = getShipment(awb);
    if (local) {
      local.live_error = err.message;
      local.live_available = false;
      return res.json(local);
    }
    return res.status(502).json({
      error: err.code || "TRACKON_API_ERROR",
      message: err.message,
      courier: String(req.query.courier || "TRACKON").toUpperCase()
    });
  }
});

app.post("/api/public-trackon", async (req, res) => {
  const routeStarted = process.hrtime.bigint();
  const awb = String((req.body || {}).awb || "").trim();
  const awbTag = trackonAwbTag(awb);
  const trackType = String((req.body || {}).type || "AWB").toUpperCase() === "ORDER" ? "ORDER" : "AWB";
  if (!awb) return res.status(400).json({ error: "Enter an AWB to test." });
  try {
    const result = await callTrackonPublicPage(awb, trackType);
    const saved = saveLiveResult(result);
    trackonTiming("HTTP /api/public-trackon total", routeStarted, `${awbTag} | result=success`);
    res.json(saved || result);
  } catch (err) {
    trackonTiming("HTTP /api/public-trackon failed", routeStarted, `${awbTag} | code=${err.code || "ERROR"}`);
    res.status(502).json({ error: err.code || "TRACKON_PUBLIC_ERROR", message: err.message, courier: "TRACKON" });
  }
});

app.get("/api/admin/shipments", (req, res) => {
  res.json(db.prepare("SELECT * FROM shipments ORDER BY id DESC LIMIT 500").all());
});

app.post("/api/admin/shipments", (req, res) => {
  const { awb, status = "PENDING", location = "", destination = "" } = req.body;
  const stamp = now();
  if (!awb) return res.status(400).json({ error: "AWB is required" });
  const old = db.prepare("SELECT id FROM shipments WHERE UPPER(awb)=UPPER(?)").get(String(awb).trim());
  if (old) {
    db.prepare("UPDATE shipments SET courier='TRACKON',status=?,location=?,destination=?,last_updated=? WHERE id=?")
      .run(status, location, destination, stamp, old.id);
    db.prepare("INSERT INTO tracking_events(shipment_id,status,location,event_time,description) VALUES(?,?,?,?,?)")
      .run(old.id, status, location, stamp, "Updated from Admin Panel");
  } else {
    const x = db.prepare("INSERT INTO shipments(awb,courier,status,location,destination,last_updated,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(String(awb).trim(), "TRACKON", status, location, destination, stamp, stamp);
    db.prepare("INSERT INTO tracking_events(shipment_id,status,location,event_time,description) VALUES(?,?,?,?,?)")
      .run(x.lastInsertRowid, status, location, stamp, "Created from Admin Panel");
  }
  res.json({ ok: true });
});

app.get("/api/admin/settings", (req, res) => {
  const s = getSetting() || {};
  res.json({
    courier: "TRACKON",
    enabled: !!s.enabled,
    api_url: s.api_url || "",
    auth_mode: s.auth_mode || "JSON_BODY",
    user_id: s.user_id || "",
    password_set: !!s.password,
    app_key_set: !!s.app_key
  });
});

app.post("/api/admin/settings", (req, res) => {
  const { enabled, api_url = "", user_id = "", password, app_key, auth_mode = "JSON_BODY" } = req.body || {};
  const current = getSetting() || {};
  const newPassword = password === undefined ? (current.password || "") : String(password);
  const newAppKey = app_key === undefined ? (current.app_key || "") : String(app_key);
  const allowedModes = ["JSON_BODY", "QUERY", "GET", "BASIC_AUTH", "APPKEY_HEADER"];
  if (!allowedModes.includes(String(auth_mode).toUpperCase())) return res.status(400).json({ error: "Invalid authentication mode" });

  db.prepare(`UPDATE settings SET enabled=?,api_url=?,user_id=?,password=?,app_key=?,auth_mode=? WHERE courier='TRACKON'`)
    .run(enabled ? 1 : 0, String(api_url).trim(), String(user_id).trim(), newPassword, newAppKey, String(auth_mode).toUpperCase());
  res.json({ ok: true });
});

app.post("/api/admin/test-trackon", async (req, res) => {
  const awb = String((req.body || {}).awb || "").trim();
  const trackType = String((req.body || {}).type || "AWB").toUpperCase() === "ORDER" ? "ORDER" : "AWB";
  if (!awb) return res.status(400).json({ error: "Enter an AWB to test." });
  try {
    const result = await callTrackon(awb, trackType);
    res.json({ ok: true, awb, type: trackType, status: result.status, location: result.location, event_count: result.events.length });
  } catch (err) {
    console.error("[Trackon test request failed]", JSON.stringify({
      code: err.code || "TRACKON_API_ERROR",
      message: err.message || "Unknown error"
    }));
    res.status(502).json({ ok: false, error: err.code || "TRACKON_API_ERROR", message: err.message });
  }
});

app.get("/api/admin/health", (req, res) => {
  const s = getSetting() || {};
  res.json({
    app: "OMKAR COURIER SERVICES",
    courier: "TRACKON",
    api_enabled: !!s.enabled,
    api_url_configured: !!s.api_url,
    user_id_configured: !!s.user_id,
    password_configured: !!s.password,
    app_key_configured: !!s.app_key,
    auth_mode: s.auth_mode || "JSON_BODY",
    time: now()
  });
});


// Branch details are available from Trackon's own public tracking page when a
// user clicks a branch/location. We open the same AWB on the official public
// page and read the visible Branch Details dialog; no details are fabricated.
app.get("/api/trackon/branch-details", async (req, res) => {
  const awb = String(req.query.awb || "").trim();
  const location = String(req.query.location || "").trim();
  if (!awb || !location) {
    return res.status(400).json({ ok: false, message: "AWB and location are required." });
  }
  if (!chromium) {
    return res.status(503).json({ ok: false, message: "Branch details require the Trackon public-page browser service." });
  }
  try {
    // Re-run the normal public tracking flow so the browser page is on this AWB.
    trackonPublicCache.delete(`${String(awb).trim().toUpperCase()}|AWB`);
    await callTrackonPublicPage(awb, "AWB");
    const executablePath = chromeExecutable();
    if (!executablePath) throw new Error("Chrome/Chromium is not available on the server.");
    const browser = await getTrackonBrowser(executablePath);
    const page = await getTrackonReusablePage(browser);

    // Prefer the exact location text. If Trackon displays only a branch-name
    // portion as a link, try the distinctive first part before the comma.
    let target = page.getByText(location, { exact: true }).first();
    if (!(await target.count().catch(() => 0))) {
      const branchPart = location.split(",")[0].replace(/^[A-Z0-9_-]+-/, "").trim();
      target = page.getByText(branchPart, { exact: false }).first();
    }
    if (!(await target.count().catch(() => 0))) {
      return res.status(404).json({ ok: false, message: "This location is not clickable on Trackon's public tracking page." });
    }
    await target.click({ timeout: 5000 });
    await page.getByText(/Branch Details/i).first().waitFor({ state: "visible", timeout: 7000 });
    await page.waitForTimeout(250);
    const dialog = page.locator('[role="dialog"]:visible, .modal:visible, .modal.show:visible').first();
    let detailsText = "";
    if (await dialog.count().catch(() => 0)) {
      detailsText = await dialog.innerText().catch(() => "");
    }
    if (!detailsText || !/Branch Details/i.test(detailsText)) {
      const body = await page.locator("body").innerText().catch(() => "");
      const at = body.search(/Branch Details/i);
      detailsText = at >= 0 ? body.slice(at, at + 3000) : "";
    }
    if (!detailsText) {
      return res.status(404).json({ ok: false, message: "Trackon did not return branch details for this location." });
    }
    res.json({ ok: true, location, detailsText });
  } catch (err) {
    console.error("[Trackon branch details]", String(err.message || err).slice(0, 200));
    res.status(502).json({
      ok: false,
      message: "Could not load branch details from Trackon right now. Please try again."
    });
  }
});

app.use((req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`OMKAR COURIER SERVICES: http://localhost:${PORT}`));
