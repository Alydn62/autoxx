const q = (s) => document.querySelector(s);
const stdoutEl = q("#stdout");
const stderrEl = q("#stderr");
const statusEl = q("#status");
const toastEl = q("#toast");
const autoRefresh = q("#auto-refresh");

const showToast = (msg) => {
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  setTimeout(() => toastEl.classList.add("hidden"), 2500);
};

const setPre = (el, txt) => { el.textContent = (txt || "").trim(); };
const appendStd = (out, err) => {
  if (out) stdoutEl.textContent = out;
  if (err) stderrEl.textContent = err;
};

async function call(method, path) {
  const res = await fetch(path, { method });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const text = await res.text();
  return { raw: text, ok: res.ok };
}

async function callPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await res.json();
  const text = await res.text();
  return { raw: text, ok: res.ok };
}

async function onCreate() {
  const n = parseInt(q("#inp-create-n").value || "1", 10);
  showToast("Create akun dimulai...");
  const data = await callPost(`/api/create?n=${n}`);
  if (data && typeof data === "object") {
    appendStd(data.stdout, data.stderr);
    showToast(data.success ? "Create selesai" : "Create gagal");
  } else {
    appendStd("", JSON.stringify(data));
  }
}

async function onSendOtp() {
  showToast("Send OTP...");
  const data = await callPost("/api/send-otp");
  appendStd(data.stdout, data.stderr);
  showToast(data.success ? "Send OTP selesai" : "Send OTP gagal");
}

async function onCheckOtp() {
  showToast("Check OTP...");
  const data = await callPost("/api/check-otp");
  appendStd(data.stdout, data.stderr);
  showToast(data.success ? "Check OTP selesai" : "Check OTP gagal");
}

async function onCheckRetry() {
  showToast("Check OTP (Retry)...");
  const data = await callPost("/api/check-retry");
  appendStd(data.stdout, data.stderr);
  showToast(data.success ? "Check Retry selesai" : "Check Retry gagal");
}

async function onStatus() {
  const data = await call("GET", "/api/status");
  if (data && typeof data === "object") {
    setPre(statusEl, JSON.stringify(data, null, 2));
  } else {
    setPre(statusEl, JSON.stringify(data));
  }
}

async function onLogs() {
  const data = await call("GET", "/api/logs");
  if (data && typeof data === "object") {
    appendStd(data.stdout || JSON.stringify(data, null, 2), data.stderr || "");
  } else {
    appendStd("", JSON.stringify(data));
  }
}

async function onClear() {
  const data = await callPost("/api/clear");
  appendStd(data.stdout, data.stderr);
  showToast(data.success ? "Logs dibersihkan" : "Gagal clear logs");
}

function startAutoRefresh() {
  let intervalId = null;
  autoRefresh.addEventListener("change", () => {
    if (autoRefresh.checked) {
      intervalId = setInterval(onLogs, 5000);
      onLogs();
    } else if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  });
}

function bindButtons() {
  q("#btn-create").addEventListener("click", onCreate);
  q("#btn-send-otp").addEventListener("click", onSendOtp);
  q("#btn-check-otp").addEventListener("click", onCheckOtp);
  q("#btn-check-retry").addEventListener("click", onCheckRetry);
  q("#btn-status").addEventListener("click", onStatus);
  q("#btn-logs").addEventListener("click", onLogs);
  q("#btn-clear").addEventListener("click", onClear);
}

(function init() {
  document.getElementById("year").textContent = new Date().getFullYear();
  bindButtons();
  startAutoRefresh();
  onStatus();
})();
