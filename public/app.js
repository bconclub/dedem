// DevDemo — panel sizing, scaling, and scroll-sync relay.

const els = {
  form: document.getElementById("urlForm"),
  input: document.getElementById("urlInput"),
  refresh: document.getElementById("refreshBtn"),
  theme: document.getElementById("themeBtn"),
  sync: document.getElementById("syncToggle"),
  widthSeg: document.getElementById("widthSeg"),
  wLabel: document.getElementById("wLabel"),
  addrDesktop: document.getElementById("addrDesktop"),
  stage: document.getElementById("stage"),
  empty: document.getElementById("empty"),
  vpDesktop: document.getElementById("vpDesktop"),
  vpMobile: document.getElementById("vpMobile"),
  deviceDesktop: document.querySelector(".device.browser"),
  devicePhone: document.querySelector(".device.phone"),
  frameDesktop: document.getElementById("frameDesktop"),
  frameMobile: document.getElementById("frameMobile"),
};

const MOBILE_WIDTH = 390;
let desktopWidth = 1280;
let currentUrl = "";

function normalize(raw) {
  let u = (raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

function proxied(url) {
  // main=1 marks the top preview frame so the server only pins the origin cookie
  // for these two frames — never for nested embeds (video players, maps, ads).
  return "/proxy?url=" + encodeURIComponent(url) + "&main=1";
}

// Render an iframe at a true device width, then scale it to fill its viewport box.
function fit(vp, frame, trueWidth) {
  const rect = vp.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const scale = rect.width / trueWidth;
  frame.style.width = trueWidth + "px";
  frame.style.height = rect.height / scale + "px";
  frame.style.transform = "scale(" + scale + ")";
}

function fitAll() {
  fit(els.vpDesktop, els.frameDesktop, desktopWidth);
  fit(els.vpMobile, els.frameMobile, MOBILE_WIDTH);
}

// Show / hide a clean overlay message inside a panel's device frame.
function panelMsg(deviceEl, html) {
  let el = deviceEl.querySelector(".panel-msg");
  if (!html) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "panel-msg";
    deviceEl.querySelector(".viewport").appendChild(el);
  }
  el.innerHTML = html;
}

// Detect a page that loaded but rendered nothing (blocks embedding, needs a real
// browser tab, etc.) and surface a clean message instead of a blank black void.
function looksBlank(frame) {
  try {
    const doc = frame.contentDocument;
    if (!doc || !doc.body) return true;
    const text = (doc.body.innerText || "").trim().length;
    const imgs = [...doc.querySelectorAll("img")].some((i) => i.complete && i.naturalWidth > 1);
    const media = doc.querySelector("svg, canvas, video, picture");
    return text < 3 && !imgs && !media;
  } catch {
    return false; // cross-origin (shouldn't happen) — assume it rendered
  }
}

let renderWatch = 0;
function watchRender(url) {
  const mine = ++renderWatch;
  const deadline = Date.now() + 9000; // give slow SPAs up to ~9s
  const tick = () => {
    if (mine !== renderWatch) return; // a newer load superseded this one
    const blankD = looksBlank(els.frameDesktop);
    if (!blankD) {
      panelMsg(els.deviceDesktop, "");
      panelMsg(els.devicePhone, "");
      return; // content appeared — done
    }
    if (Date.now() >= deadline) {
      const host = (() => { try { return new URL(url).host; } catch { return url; } })();
      const msg =
        `<svg class="pm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><line x1="6" y1="6" x2="18" y2="18"/></svg>` +
        `<div class="pm-title">Can’t preview this site</div>` +
        `<div class="pm-sub">${host} blocks embedding or renders only in a real browser tab.</div>`;
      panelMsg(els.deviceDesktop, msg);
      panelMsg(els.devicePhone, msg);
      return;
    }
    setTimeout(tick, 700);
  };
  setTimeout(tick, 1500);
}

function load(url) {
  currentUrl = url;
  els.empty.classList.add("hidden");
  els.stage.classList.add("loading");
  els.addrDesktop.textContent = url;
  els.input.value = url;
  panelMsg(els.deviceDesktop, "");
  panelMsg(els.devicePhone, "");
  const src = proxied(url);
  els.frameDesktop.src = src;
  els.frameMobile.src = src;
  fitAll();
  watchRender(url);
}

let loadedCount = 0;
function onFrameLoad() {
  loadedCount++;
  if (loadedCount >= 1) els.stage.classList.remove("loading");
  fitAll();
}
els.frameDesktop.addEventListener("load", onFrameLoad);
els.frameMobile.addEventListener("load", onFrameLoad);

// ---- Controls ----
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const url = normalize(els.input.value);
  if (url) load(url);
});

els.refresh.addEventListener("click", () => {
  if (currentUrl) load(currentUrl);
});

// Studio background: premium dark by default, toggle to light (persisted).
function applyTheme(light) {
  document.body.classList.toggle("light", light);
  els.theme.textContent = light ? "🌙" : "☀️";
  els.theme.title = light ? "Switch to dark studio" : "Switch to light studio";
  try { localStorage.setItem("dedem-light", light ? "1" : "0"); } catch {}
}
els.theme.addEventListener("click", () => {
  applyTheme(!document.body.classList.contains("light"));
  fitAll();
});
try { applyTheme(localStorage.getItem("dedem-light") === "1"); } catch {}

els.widthSeg.addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-w]");
  if (!btn) return;
  desktopWidth = parseInt(btn.dataset.w, 10);
  els.wLabel.textContent = desktopWidth;
  [...els.widthSeg.children].forEach((b) => b.classList.toggle("active", b === btn));
  fitAll();
});

// ---- Scroll sync relay: parent is the hub between the two frames ----
window.addEventListener("message", (e) => {
  const m = e.data;
  if (!m || !m.__devdemo || m.type !== "scroll") return;
  if (!els.sync.checked) return;

  const fromDesktop = e.source === els.frameDesktop.contentWindow;
  const fromMobile = e.source === els.frameMobile.contentWindow;
  if (!fromDesktop && !fromMobile) return;

  const target = fromDesktop ? els.frameMobile : els.frameDesktop;
  target.contentWindow.postMessage(
    { __devdemo: true, type: "apply", ratio: m.ratio },
    "*"
  );
});

// ---- Resize handling ----
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fitAll, 80);
});

// Fit once fonts/layout settle.
requestAnimationFrame(fitAll);
window.addEventListener("load", fitAll);
