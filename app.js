#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const readline = require("readline");
const cfg = require("./config");

// Fix untuk output buffering
process.stdout.setEncoding('utf8');
process.stderr.setEncoding('utf8');

// Fungsi untuk flush output
const flushOutput = () => {
  if (process.stdout.isTTY) {
    process.stdout.write('');
  }
};

const DB = path.join(__dirname, "logs.json");
const LOG_STATUS = { PENDING:"pending", WAITING:"waiting", COMPLETED:"completed", SUCCESS:"success", EXPIRED:"expired", FAILED:"failed", LOGIN:"login" };

// FIXED: Perbaikan normalisasi nomor dengan semua prefix operator Indonesia
const normalizeLocal = (s) => {
  if (!s) return "";
  
  // Convert to string dan hapus spasi dan karakter non-digit kecuali +
  let cleaned = String(s).trim().replace(/[\s\-\(\)\.]/g, "");
  
  console.log(`[NORM] Input: "${s}" -> Cleaned: "${cleaned}"`);
  
  // Handle format internasional
  if (cleaned.startsWith("+62")) {
    cleaned = "0" + cleaned.slice(3);
    console.log(`[NORM] +62 format detected -> "${cleaned}"`);
  } else if (cleaned.startsWith("62") && cleaned.length > 10) {
    cleaned = "0" + cleaned.slice(2);
    console.log(`[NORM] 62 format detected -> "${cleaned}"`);
  }
  
  // Hanya simpan digit
  cleaned = cleaned.replace(/\D/g, "");
  
  // Daftar semua prefix operator Indonesia yang valid
  const validPrefixes = [
    '0811', '0812', '0813', '0814', '0815', '0816', '0817', '0818', '0819',
    '0821', '0822', '0823', '0831', '0832', '0833', '0838',
    '0851', '0852', '0853', '0855', '0856', '0857', '0858', '0859',
    '0877', '0878', '0881', '0882', '0883', '0884', '0885', '0886', 
    '0887', '0888', '0889', '0895', '0896', '0897', '0898', '0899'
  ];
  
  console.log(`[NORM] After cleaning: "${cleaned}" (length: ${cleaned.length})`);
  
  // Jika sudah dimulai dengan 08, cek apakah prefix valid
  if (cleaned.startsWith('08')) {
    const prefix = cleaned.substring(0, 4);
    console.log(`[NORM] Checking prefix: "${prefix}"`);
    if (validPrefixes.includes(prefix) && cleaned.length >= 10 && cleaned.length <= 15) {
      console.log(`[NORM] ✓ Valid prefix found: "${prefix}" -> "${cleaned}"`);
      return cleaned;
    } else {
      console.log(`[NORM] ✗ Invalid prefix or length: "${prefix}" (length: ${cleaned.length})`);
    }
  }
  
  // Jika dimulai dengan 8 (tanpa 0)
  if (cleaned.startsWith('8') && cleaned.length >= 9) {
    const testNumber = '0' + cleaned;
    const prefix = testNumber.substring(0, 4);
    console.log(`[NORM] Testing with 0 prefix: "${testNumber}" -> prefix: "${prefix}"`);
    if (validPrefixes.includes(prefix) && testNumber.length >= 10 && testNumber.length <= 15) {
      console.log(`[NORM] ✓ Valid after adding 0: "${testNumber}"`);
      return testNumber;
    }
  }
  
  // Jika tidak dimulai dengan 0 atau 8, coba tambahkan 0
  if (!cleaned.startsWith('0') && !cleaned.startsWith('8') && cleaned.length >= 9) {
    const testNumber = '0' + cleaned;
    const prefix = testNumber.substring(0, 4);
    console.log(`[NORM] Testing general 0 prefix: "${testNumber}" -> prefix: "${prefix}"`);
    if (validPrefixes.includes(prefix) && testNumber.length >= 10 && testNumber.length <= 15) {
      console.log(`[NORM] ✓ Valid after adding 0: "${testNumber}"`);
      return testNumber;
    }
  }
  
  console.log(`[NORM] ✗ No valid format found for: "${cleaned}"`);
  return ""; // Return empty jika tidak valid
};

// IMPROVED: Handle empty/corrupt JSON files with better error handling
const readDB = () => {
  try {
    if (!fs.existsSync(DB)) {
      console.log("[INFO] File logs.json tidak ditemukan, membuat file baru...");
      flushOutput();
      writeDB([]);
      return [];
    }
    
    const content = fs.readFileSync(DB, "utf8").trim();
    if (!content) {
      console.log("[INFO] File logs.json kosong, inisialisasi dengan array kosong...");
      flushOutput();
      writeDB([]);
      return [];
    }
    
    return JSON.parse(content);
  } catch (error) {
    console.log("[WARN] File logs.json corrupt, mereset ke array kosong...");
    console.log(`[DEBUG] Error detail: ${error.message}`);
    flushOutput();
    writeDB([]);
    return [];
  }
};

const writeDB = (rows) => fs.writeFileSync(DB, JSON.stringify(rows, null, 2));

// IMPROVED: Better error handling for JasaOTP API
async function jasaotpOrder() {
  const u = `https://api.jasaotp.id/v1/order.php?api_key=${cfg.jasaotp.apiKey}&negara=${cfg.jasaotp.negara}&layanan=${cfg.jasaotp.layanan}&operator=${cfg.jasaotp.operator}&_=${Date.now()}`;
  
  try {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    const j = await res.json();
    if (!j.success) throw new Error("JasaOTP: "+(j.message||"gagal order"));
    
    let phone = j.data.number;
    phone = phone.startsWith("+62") ? "0"+phone.slice(3) : phone;
    return { orderId: j.data.order_id, phone };
  } catch (error) {
    throw new Error(`JasaOTP Order Error: ${error.message}`);
  }
}

async function jasaotpGetOtp(orderId) {
  const u = `https://api.jasaotp.id/v1/sms.php?api_key=${cfg.jasaotp.apiKey}&id=${encodeURIComponent(orderId)}&_=${Date.now()}`;
  
  try {
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    if (j && j.success && j.data?.otp) {
      const m = String(j.data.otp).match(/\d{4,8}/);
      if (m) return m[0];
    }
    throw new Error("no-otp");
  } catch (error) {
    if (error.message === "no-otp") throw error;
    throw new Error(`JasaOTP GetOTP Error: ${error.message}`);
  }
}

// IMPROVED: Only add log if registration is successful
function addLog(status, phone, orderId, details="", email="") {
  const rows = readDB();
  rows.unshift({
    id: Date.now(),
    timestamp: new Date().toISOString(),
    status, phone, orderId, details, email,
    createdAt: Date.now()
  });
  writeDB(rows);
}

function updateLog(id, patch) {
  const rows = readDB();
  const i = rows.findIndex(r => r.id === id);
  if (i >= 0) {
    rows[i] = { ...rows[i], ...patch, updatedAt: Date.now() };
    writeDB(rows);
  }
}

function autoExpire() {
  const rows = readDB();
  const limit = cfg.runtime.expireMinutes * 60 * 1000;
  let changed = false;
  for (const r of rows) {
    if (r.status === LOG_STATUS.WAITING && (Date.now()-r.createdAt > limit)) {
      r.status = LOG_STATUS.EXPIRED;
      r.details = "OTP expired after 10 minutes";
      r.updatedAt = Date.now();
      changed = true;
    }
  }
  if (changed) writeDB(rows);
}

function generateRegistrationData(phone, orderId, customEmail = null) {
  let email;
  if (customEmail) {
    email = customEmail;
  } else {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let localPart = "";
    for (let i = 0; i < 15; i++) {
      localPart += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    email = `${localPart}@gmail.com`;
  }

  const now = new Date();
  const maxYear = now.getFullYear() - 20;
  const minYear = maxYear - 40;
  const year = Math.floor(Math.random() * (maxYear - minYear + 1)) + minYear;
  const month = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const day = String(Math.floor(Math.random() * 28) + 1).padStart(2, "0");
  const birthdate = `${year}-${month}-${day}`;

  return {
    fullname: "AKUN TS",
    phone: normalizeLocal(phone),
    email: email,
    birthdate: birthdate,
    password: "@Facebook20",
    pin: "789789",
    security_answer: "111111",
    orderId: orderId
  };
}

// IMPROVED: Better performance with delays and improved error handling
async function registerToTreasury(registrationData) {
  console.log(`[INFO] Step 1: Navigasi ke halaman registrasi...`);
  flushOutput();
  
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-extensions","--disable-gpu"],
    slowMo: 50  // Reduced from 100 to 50 for faster processing
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto("https://web.treasury.id/register", { waitUntil: "domcontentloaded", timeout: 60000 });
    console.log("   [OK] Halaman registrasi berhasil dimuat");
    flushOutput();
    await page.waitForTimeout(1000); // Reduced from 2000 to 1000

    console.log(`[FILL] Step 2: Mengisi form...`);
    flushOutput();
    
    const nameSelectors = [
      'input[placeholder*="Nama Lengkap" i]',
      'input[name*="name" i]',
      'input[id*="name" i]',
      'input[name*="fullname" i]',
      'input[placeholder*="nama" i]'
    ];
    
    let nameSuccess = false;
    for (const sel of nameSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) { // Reduced timeout
          await el.fill('');
          await page.waitForTimeout(200); // Reduced delay
          await el.fill(registrationData.fullname);
          console.log(`   [OK] Nama terisi`);
          flushOutput();
          nameSuccess = true;
          break;
        }
      } catch (e) {}
    }
    
    if (!nameSuccess) {
      throw new Error("Tidak dapat mengisi field nama");
    }

    const phoneSelectors = [
      'input[type="tel"]',
      'input[placeholder*="handphone" i]',
      'input[placeholder*="nomor" i]',
      'input[name*="phone" i]',
      'input[name*="hp" i]',
      'input[placeholder*="telepon" i]'
    ];
    
    let phoneSuccess = false;
    for (const sel of phoneSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.fill('');
          await page.waitForTimeout(200);
          await el.fill(registrationData.phone);
          console.log(`   [OK] Phone terisi`);
          flushOutput();
          phoneSuccess = true;
          break;
        }
      } catch (e) {}
    }
    
    if (!phoneSuccess) {
      throw new Error("Tidak dapat mengisi field phone");
    }

    const emailSelectors = [
      'input[type="email"]',
      'input[placeholder*="Email" i]',
      'input[name*="email" i]',
      'input[id*="email" i]'
    ];
    
    let emailSuccess = false;
    for (const sel of emailSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.fill('');
          await page.waitForTimeout(200);
          await el.fill(registrationData.email);
          console.log(`   [OK] Email terisi: ${registrationData.email}`);
          flushOutput();
          emailSuccess = true;
          break;
        }
      } catch (e) {}
    }
    
    if (!emailSuccess) {
      throw new Error("Tidak dapat mengisi field email");
    }

    try {
      const birthdateEl = page.locator('#birthday').first();
      if (await birthdateEl.isVisible({ timeout: 2000 })) {
        await page.evaluate(() => {
          const el = document.querySelector('#birthday');
          if (el) el.removeAttribute("readonly");
        });
        
        await birthdateEl.click();
        await page.waitForTimeout(300);
        
        await page.evaluate((isoDate) => {
          const el = document.querySelector('#birthday');
          if (el) {
            const proto = Object.getPrototypeOf(el);
            const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (setter) setter.call(el, isoDate);
            else el.value = isoDate;
            
            el.setAttribute("title", isoDate);
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
        }, registrationData.birthdate);
        
        await page.waitForTimeout(300);
        console.log(`   [OK] Birthdate terisi`);
        flushOutput();
      }
    } catch (e) {
      console.log(`   [WARN] Error mengisi birthdate: ${e.message}`);
      flushOutput();
    }

    console.log(`[FILL] Mengisi password & PIN...`);
    flushOutput();
    
    const passwordFields = await page.locator('input[type="password"]').all();
    
    for (let i = 0; i < passwordFields.length; i++) {
      try {
        if (await passwordFields[i].isVisible()) {
          await passwordFields[i].fill('');
          await page.waitForTimeout(100); // Reduced delay
          await passwordFields[i].fill(registrationData.password);
          await page.waitForTimeout(100);
        }
      } catch (e) {}
    }
    console.log(`   [OK] ${passwordFields.length} password fields terisi`);
    flushOutput();

    const pinSelectors = [
      'input[placeholder*="PIN" i]',
      'input[name*="pin" i]',
      'input[id*="pin" i]'
    ];
    
    let pinCount = 0;
    for (const sel of pinSelectors) {
      try {
        const elements = await page.locator(sel).all();
        for (let i = 0; i < elements.length; i++) {
          if (await elements[i].isVisible()) {
            await elements[i].fill('');
            await page.waitForTimeout(100);
            await elements[i].fill(registrationData.pin);
            await page.waitForTimeout(100);
            pinCount++;
          }
        }
      } catch (e) {}
    }

    console.log(`[FILL] Mengisi security question...`);
    flushOutput();
    
    try {
      const selectElements = await page.locator('select').all();
      
      for (let i = 0; i < selectElements.length; i++) {
        const selectEl = selectElements[i];
        if (await selectEl.isVisible({ timeout: 2000 })) {
          const options = await selectEl.locator('option').all();
          
          let found = false;
          for (const option of options) {
            const text = await option.textContent();
            if (text && text.includes("artis favorit")) {
              await selectEl.selectOption({ label: text });
              console.log(`   [OK] Security question dipilih`);
              flushOutput();
              found = true;
              break;
            }
          }
          if (!found && options.length > 1) {
            await selectEl.selectOption({ index: 1 });
            console.log(`   [OK] Security question dipilih (fallback)`);
            flushOutput();
          }
          break;
        }
      }
    } catch (e) {
      console.log(`   [WARN] Error security question: ${e.message}`);
      flushOutput();
    }

    const answerSelectors = [
      'input[placeholder*="Jawaban" i]',
      'input[name*="answer" i]',
      'input[name*="jawaban" i]',
      'input[id*="answer" i]'
    ];
    
    let answerSuccess = false;
    for (const sel of answerSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await el.fill('');
          await page.waitForTimeout(200);
          await el.fill(registrationData.security_answer);
          console.log(`   [OK] Security answer terisi`);
          flushOutput();
          answerSuccess = true;
          break;
        }
      } catch (e) {}
    }

    console.log(`[FILL] Mengecek checkbox terms...`);
    flushOutput();
    
    try {
      const checkboxes = await page.locator('input[type="checkbox"]').all();
      
      for (let i = 0; i < checkboxes.length; i++) {
        const checkbox = checkboxes[i];
        if (await checkbox.isVisible()) {
          const isChecked = await checkbox.isChecked();
          if (!isChecked) {
            await checkbox.click();
            await page.waitForTimeout(200);
          }
        }
      }
      console.log(`   [OK] Checkbox terms dicentang`);
      flushOutput();
    } catch (e) {
      console.log(`   [WARN] Error checkbox: ${e.message}`);
      flushOutput();
    }

    console.log(`[SUBMIT] Step 3: Submit form registrasi...`);
    flushOutput();
    
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Buat Akun")',
      'button:has-text("Daftar")',
      'button.btn-login',
      '.btn-base:has-text("Daftar")',
      'form button',
      '.btn-primary',
      '.btn-submit'
    ];
    
    let submitted = false;
    for (const sel of submitSelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 2000 })) {
          await btn.click();
          submitted = true;
          console.log(`   [OK] Form berhasil di-submit`);
          flushOutput();
          break;
        }
      } catch (e) {}
    }
    
    if (!submitted) {
      throw new Error("Tidak dapat menemukan tombol submit");
    }

    console.log(`[WAIT] Step 4: Menunggu konfirmasi registrasi...`);
    flushOutput();
    
    await page.waitForTimeout(3000); // Reduced from 4000
    
    const currentUrl = await page.url();
    console.log(`   [DEBUG] Current URL: ${currentUrl}`);
    flushOutput();
    
    const successIndicators = [
      'text=berhasil',
      'text=sukses', 
      'text=OTP',
      'text=verifikasi',
      'input[autocomplete="one-time-code"]',
      'input[maxlength="1"]',
      'text=kode verifikasi',
      'text=dikirim',
      '.success',
      '.alert-success'
    ];
    
    let successFound = false;
    let foundIndicator = '';
    
    for (const indicator of successIndicators) {
      try {
        const el = page.locator(indicator).first();
        if (await el.isVisible({ timeout: 1500 })) { // Reduced timeout
          successFound = true;
          foundIndicator = indicator;
          break;
        }
      } catch (e) {}
    }

    if (successFound || (currentUrl !== "https://web.treasury.id/register" && !currentUrl.includes('register'))) {
      console.log(`   [SUCCESS] REGISTRASI BERHASIL ${foundIndicator ? `via: ${foundIndicator}` : 'via URL change'}`);
      flushOutput();
      return true;
    } else {
      throw new Error("Registrasi gagal - tidak ada indikator sukses");
    }

  } catch (error) {
    console.error(`[ERROR] Error pada registrasi: ${error.message}`);
    flushOutput();
    throw error;
  } finally {
    console.log("[CLOSE] Menutup browser...");
    flushOutput();
    await ctx.close(); 
    await browser.close();
  }
}

// IMPROVED: Login function dengan handling untuk loading overlay dan retry mechanism
async function sendOtpViaHeadlessWithPassword(phone, customPassword) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-extensions","--disable-gpu"],
    slowMo: 30
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    const local = normalizeLocal(phone);
    
    console.log(`[LOGIN] Step 1: Navigasi ke halaman login...`);
    flushOutput();
    await page.goto(cfg.treasury.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("   [OK] Halaman login berhasil dimuat");
    flushOutput();
    await page.waitForTimeout(1000);

    console.log(`[FILL] Step 2: Mengisi form login...`);
    flushOutput();
    
    const usernameInput = '#username';
    const passwordInput = '#password';
    const loginButton = '.btn-login';

    // Wait for loading overlay to disappear first
    try {
      console.log("   Menunggu loading overlay menghilang...");
      await page.waitForSelector('.loading-2.fullscreen.overlay.show', { state: 'hidden', timeout: 10000 });
      console.log("   [OK] Loading overlay menghilang");
    } catch (e) {
      console.log("   [INFO] Loading overlay tidak ditemukan atau sudah hilang");
    }
    flushOutput();

    console.log(`   Mengisi username: ${local}...`);
    flushOutput();
    try {
      await page.waitForSelector(usernameInput, { timeout: 10000 });
      await page.locator(usernameInput).fill('');
      await page.waitForTimeout(300);
      await page.locator(usernameInput).fill(local);
      console.log("   [OK] Username berhasil terisi");
      flushOutput();
    } catch (e) {
      throw new Error(`Gagal mengisi username: ${e.message}`);
    }

    console.log(`   Mengisi password...`);
    flushOutput();
    try {
      const passwordField = page.locator(passwordInput);
      await passwordField.fill('');
      await page.waitForTimeout(300);
      await passwordField.fill(customPassword);
      console.log("   [OK] Password berhasil terisi");
      flushOutput();
    } catch (e) {
      throw new Error(`Gagal mengisi password: ${e.message}`);
    }

    console.log(`[CLICK] Step 3: Mengklik tombol login...`);
    flushOutput();
    
    // Enhanced click with retry mechanism and loading overlay handling
    let loginSuccess = false;
    let clickAttempts = 0;
    const maxClickAttempts = 3;
    
    while (!loginSuccess && clickAttempts < maxClickAttempts) {
      clickAttempts++;
      console.log(`   Attempt ${clickAttempts}/${maxClickAttempts}: Mencoba klik login button...`);
      
      try {
        // Wait for any loading overlay to disappear before clicking
        await page.waitForFunction(() => {
          const overlay = document.querySelector('.loading-2.fullscreen.overlay.show');
          return !overlay || overlay.style.display === 'none' || !overlay.classList.contains('show');
        }, { timeout: 5000 });
        
        const loginBtn = page.locator(loginButton);
        
        // Use force click to bypass intercepting elements
        await loginBtn.click({ force: true, timeout: 15000 });
        console.log("   [OK] Tombol login berhasil diklik");
        flushOutput();
        loginSuccess = true;
        
      } catch (e) {
        console.log(`   [RETRY] Click attempt ${clickAttempts} failed: ${e.message.substring(0, 100)}...`);
        flushOutput();
        
        if (clickAttempts < maxClickAttempts) {
          console.log(`   [WAIT] Menunggu 2 detik sebelum retry...`);
          await page.waitForTimeout(2000);
        }
      }
    }
    
    if (!loginSuccess) {
      throw new Error(`Gagal klik login button setelah ${maxClickAttempts} percobaan`);
    }

    console.log(`[WAIT] Step 4: Menunggu response login...`);
    flushOutput();
    
    // Enhanced success indicators with more comprehensive detection
    const successIndicators = [
      { selector: 'input[autocomplete="one-time-code"]', description: 'OTP input (single)' },
      { selector: 'input[maxlength="1"]', description: 'OTP input (multiple)' },
      { selector: 'input[maxlength="6"]', description: 'OTP input (6 digit)' },
      { selector: '[role="dialog"]', description: 'Modal dialog' },
      { selector: '.ant-modal', description: 'Ant Design modal' },
      { selector: '.modal', description: 'Generic modal' },
      { selector: 'text=OTP', description: 'Text containing OTP' },
      { selector: 'text=kode', description: 'Text containing kode' },
      { selector: 'text=verifikasi', description: 'Text containing verifikasi' },
      { selector: 'text=Masukkan kode', description: 'Text masukkan kode' },
      { selector: '.otp-input', description: 'OTP input class' },
      { selector: '[placeholder*="kode" i]', description: 'Placeholder kode' },
      { selector: '[placeholder*="OTP" i]', description: 'Placeholder OTP' }
    ];
    
    // Error indicators to detect failed login
    const errorIndicators = [
      { selector: 'text=salah', description: 'Text salah' },
      { selector: 'text=tidak valid', description: 'Text tidak valid' },
      { selector: 'text=gagal', description: 'Text gagal' },
      { selector: '.error', description: 'Error class' },
      { selector: '.alert-danger', description: 'Alert danger' },
      { selector: '[class*="error"]', description: 'Error in class name' }
    ];
    
    const startTime = Date.now();
    let foundIndicator = null;
    let ok = false;
    let errorFound = false;
    
    // Wait longer and check more thoroughly
    const waitTime = 15000; // 15 seconds
    
    // Check for success indicators
    const checkSuccess = async () => {
      for (const indicator of successIndicators) {
        try {
          const element = page.locator(indicator.selector).first();
          if (await element.isVisible({ timeout: 1000 })) {
            return { found: true, indicator: indicator.description };
          }
        } catch (e) {
          // Continue checking other indicators
        }
      }
      return { found: false };
    };
    
    // Check for error indicators
    const checkError = async () => {
      for (const indicator of errorIndicators) {
        try {
          const element = page.locator(indicator.selector).first();
          if (await element.isVisible({ timeout: 1000 })) {
            return { found: true, indicator: indicator.description };
          }
        } catch (e) {
          // Continue checking other indicators
        }
      }
      return { found: false };
    };
    
    // Check URL change
    const checkUrlChange = async () => {
      const currentUrl = await page.url();
      if (currentUrl !== cfg.treasury.loginUrl && !currentUrl.includes('/login')) {
        return { found: true, indicator: 'URL change' };
      }
      return { found: false };
    };
    
    // Main detection loop
    const endTime = startTime + waitTime;
    while (Date.now() < endTime && !ok && !errorFound) {
      // Check for success
      const successResult = await checkSuccess();
      if (successResult.found) {
        foundIndicator = successResult.indicator;
        ok = true;
        break;
      }
      
      // Check for errors
      const errorResult = await checkError();
      if (errorResult.found) {
        errorFound = true;
        throw new Error(`Login gagal - error detected: ${errorResult.indicator}`);
      }
      
// Check URL change
      const urlResult = await checkUrlChange();
      if (urlResult.found) {
        foundIndicator = urlResult.indicator;
        ok = true;
        break;
      }
      
      // Wait before next check
      await page.waitForTimeout(1000);
    }
    
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`   [TIME] Total waktu login: ${elapsed} detik`);
    flushOutput();
    
    if (ok) {
      console.log(`   [SUCCESS] LOGIN BERHASIL via: ${foundIndicator}`);
      flushOutput();
      return true;
    } else {
      // Take screenshot for debugging if login fails
      try {
        const screenshot = `debug_login_${phone}_${Date.now()}.png`;
        await page.screenshot({ path: screenshot, fullPage: true });
        console.log(`   [DEBUG] Screenshot saved: ${screenshot}`);
      } catch (e) {
        // Ignore screenshot errors
      }
      
      throw new Error("Login gagal - tidak ada indikator sukses setelah 15 detik");
    }
    
  } catch (error) {
    console.error(`[ERROR] Error login ${phone}: ${error.message}`);
    flushOutput();
    throw error;
  } finally {
    console.log("[CLOSE] Menutup browser untuk login ini...");
    flushOutput();
    await ctx.close(); 
    await browser.close();
    console.log("   [OK] Browser ditutup");
    flushOutput();
  }
}

// Fungsi untuk menyimpan hasil ke file log terpisah
function saveResultsToFiles(successResults, failResults) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  // Save success results
  if (successResults.length > 0) {
    const successFile = `logsukses_${timestamp}.json`;
    const successData = {
      timestamp: new Date().toISOString(),
      total: successResults.length,
      results: successResults
    };
    fs.writeFileSync(successFile, JSON.stringify(successData, null, 2));
    console.log(`[SAVE] ${successResults.length} nomor berhasil disimpan ke: ${successFile}`);
  }
  
  // Save failed results
  if (failResults.length > 0) {
    const failFile = `loggagal_${timestamp}.json`;
    const failData = {
      timestamp: new Date().toISOString(),
      total: failResults.length,
      results: failResults
    };
    fs.writeFileSync(failFile, JSON.stringify(failData, null, 2));
    console.log(`[SAVE] ${failResults.length} nomor gagal disimpan ke: ${failFile}`);
  }
  
  flushOutput();
}

// UPDATED: Auto login dengan retry untuk nomor gagal dan format output seperti OTP check
async function cmdAutoLogin() {
  const rl = createInterface();
  
  try {
    console.log("\n=== AUTO LOGIN BATCH (TANPA BATAS MAKSIMAL) ===");
    console.log("Format yang didukung: 08xxx, +628xxx, 628xxx, 8xxx");
    console.log("Prefix yang didukung: 0811-0819, 0821-0823, 0831-0833, 0838, 0851-0859, 0877-0878, 0881-0889, 0895-0899");
    console.log("FITUR BARU: Auto retry untuk nomor yang gagal!");
    flushOutput();
    
    // Terima input single-line dan multi-line
    const input = await askMultilineQuestion(rl, "\nMasukkan nomor-nomor HP:");
    
    // Parse input - tangani format spasi dan multi-line
    let phones = [];
    
    // Split berdasarkan spasi, koma, titik koma, dan separator lainnya
    const rawNumbers = input
      .split(/[\s,;|]+/)  // Split by whitespace, commas, semicolons, pipes
      .filter(num => {
        const trimmed = num.trim();
        return trimmed && 
               trimmed.toLowerCase() !== 'done' &&
               trimmed.toLowerCase() !== '/end' &&
               /\d/.test(trimmed);  // Minimal mengandung satu digit
      });
    
    console.log(`\n[PARSING] Ditemukan ${rawNumbers.length} nomor potensial...`);
    flushOutput();
    
    // Normalisasi setiap nomor (dengan silent processing untuk kecepatan)
    for (let i = 0; i < rawNumbers.length; i++) {
      const raw = rawNumbers[i];
      const normalized = normalizeLocal(raw);
      
      if (normalized && normalized.length >= 10 && normalized.length <= 15) {
        phones.push(normalized);
        console.log(`[OK] ✅ ${normalized} (${phones.length})`);
      } else {
        console.log(`[SKIP] ❌ ${raw}`);
      }
      flushOutput();
    }
    
    console.log(`\n[DETECT] Auto-detected ${phones.length} nomor valid`);
    flushOutput();
    
    if (phones.length === 0) {
      console.log("\n[ERROR] Tidak ada nomor valid yang terdeteksi");
      console.log("[INFO] Contoh format valid:");
      console.log("  - Single line: 08773456789 08123456789 +628773456789");
      console.log("  - Multi line:");
      console.log("    08773456789");
      console.log("    08123456789");
      console.log("    DONE");
      flushOutput();
      rl.close();
      return;
    }
    
    console.log(`[UNLIMITED] Akan memproses SEMUA ${phones.length} nomor (tanpa batas maksimal)`);
    flushOutput();
    
    const password = await askQuestion(rl, "\nMasukkan password untuk semua nomor (kosong = gunakan default @Facebook20): ");
    const finalPassword = password.trim() || "@Facebook20";
    
    if (password.trim() === "") {
      console.log(`[DEFAULT] Menggunakan password default: @Facebook20`);
      flushOutput();
    } else {
      console.log(`[CUSTOM] Menggunakan password: ${finalPassword.substring(0, 3)}${'*'.repeat(Math.max(0, finalPassword.length - 3))}`);
      flushOutput();
    }
    
    const confirm = await askQuestion(rl, `\nLanjutkan auto login untuk ${phones.length} nomor? (y/n): `);
    
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
      console.log("[CANCEL] Auto login dibatalkan");
      flushOutput();
      rl.close();
      return;
    }
    
    rl.close();
    
    console.log(`\n[START] Memulai auto login untuk ${phones.length} nomor...`);
    console.log(`[FEATURE] Auto retry untuk nomor yang gagal setelah selesai semua`);
    flushOutput();
    
    let allSuccessResults = [];
    let allFailResults = [];
    let retryCount = 0;
    const maxRetries = 2; // Maksimal 2x retry
    
    // Fungsi untuk memproses batch nomor
    const processBatch = async (phoneList, batchName, isRetry = false) => {
      console.log(`\n${"=".repeat(70)}`);
      console.log(`${batchName.toUpperCase()}`);
      console.log(`${"=".repeat(70)}`);
      
      let successCount = 0;
      let failCount = 0;
      const successResults = [];
      const failResults = [];
      
      const startTime = Date.now();
      
      for (let i = 0; i < phoneList.length; i++) {
        const phone = phoneList[i];
        const progress = `[${i+1}/${phoneList.length}]`;
        const percentage = Math.round(((i+1) / phoneList.length) * 100);
        
        console.log(`\n[PROCESS] ${progress} (${percentage}%) ${isRetry ? 'RETRY' : 'Login'}: ${phone}`);
        flushOutput();
        
        try {
          const loginSuccess = await sendOtpViaHeadlessWithPassword(phone, finalPassword);
          
          addLog(LOG_STATUS.LOGIN, phone, 0, `Login berhasil untuk ${phone}${isRetry ? ' (retry)' : ''}`, '');
          
          successResults.push({ 
            phone, 
            status: 'SUCCESS', 
            message: 'berhasil',
            timestamp: new Date().toISOString()
          });
          successCount++;
          console.log(`   ✅ Login berhasil`);
          flushOutput();
          
        } catch (error) {
          failResults.push({ 
            phone, 
            status: 'FAILED', 
            message: 'gagal',
            error: error.message,
            timestamp: new Date().toISOString()
          });
          failCount++;
          console.log(`   ❌ LOGIN GAGAL: ${error.message}`);
          flushOutput();
        }
        
        // Delay antar nomor
        if (i < phoneList.length - 1) {
          console.log(`   [DELAY] Menunggu 1 detik sebelum nomor berikutnya...`);
          flushOutput();
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Progress update setiap 25 akun
        if ((i + 1) % 25 === 0) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const remaining = phoneList.length - (i + 1);
          const estimatedRemaining = Math.round(remaining * 1); // 1 detik per akun
          console.log(`   [PROGRESS] ${i + 1}/${phoneList.length} selesai | Elapsed: ${elapsed}s | ETA: ${estimatedRemaining}s`);
          flushOutput();
        }
      }
      
      const totalTime = Math.round((Date.now() - startTime) / 1000);
      console.log(`\n[${batchName.toUpperCase()} RESULT] Berhasil: ${successCount}, Gagal: ${failCount}, Waktu: ${totalTime}s`);
      flushOutput();
      
      return { successResults, failResults };
    };
    
    // ROUND 1: Proses semua nomor pertama kali
    const round1 = await processBatch(phones, "ROUND 1: INITIAL LOGIN ATTEMPT");
    allSuccessResults = [...round1.successResults];
    allFailResults = [...round1.failResults];
    
    // RETRY ROUNDS: Coba lagi nomor yang gagal
    let currentFailedPhones = round1.failResults.map(r => r.phone);
    
    while (currentFailedPhones.length > 0 && retryCount < maxRetries) {
      retryCount++;
      
      console.log(`\n[RETRY INFO] ${currentFailedPhones.length} nomor gagal akan dicoba lagi (Retry ${retryCount}/${maxRetries})`);
      console.log("[RETRY DELAY] Menunggu 5 detik sebelum memulai retry...");
      flushOutput();
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      const retryRound = await processBatch(
        currentFailedPhones, 
        `ROUND ${retryCount + 1}: RETRY ATTEMPT ${retryCount}`, 
        true
      );
      
      // Update hasil: pindahkan yang berhasil dari failed ke success
      retryRound.successResults.forEach(success => {
        // Hapus dari allFailResults
        const failIndex = allFailResults.findIndex(fail => fail.phone === success.phone);
        if (failIndex !== -1) {
          allFailResults.splice(failIndex, 1);
        }
        // Tambah ke allSuccessResults
        allSuccessResults.push(success);
      });
      
      // Update currentFailedPhones untuk retry berikutnya
      currentFailedPhones = retryRound.failResults.map(r => r.phone);
      
      // Update final failed results (hanya yang masih gagal)
      retryRound.failResults.forEach(fail => {
        const existingFailIndex = allFailResults.findIndex(existing => existing.phone === fail.phone);
        if (existingFailIndex !== -1) {
          allFailResults[existingFailIndex] = fail; // Update dengan error terbaru
        }
      });
    }
    
    const totalSuccess = allSuccessResults.length;
    const totalFail = allFailResults.length;
    const totalProcessed = phones.length;
    
    console.log(`\n${"=".repeat(70)}`);
    console.log(`HASIL AKHIR AUTO LOGIN BATCH (DENGAN AUTO RETRY)`);
    console.log(`${"=".repeat(70)}`);
    console.log(`✅ Total Berhasil: ${totalSuccess}/${totalProcessed} (${Math.round((totalSuccess/totalProcessed)*100)}%)`);
    console.log(`❌ Total Gagal: ${totalFail}/${totalProcessed} (${Math.round((totalFail/totalProcessed)*100)}%)`);
    console.log(`🔄 Retry dilakukan: ${retryCount} kali`);
    console.log(`💪 Total diproses: ${totalProcessed} akun (TANPA BATAS)`);
    flushOutput();
    
    // FORMAT OUTPUT BERSIH SEPERTI OTP CHECK (nomor = status)
    console.log(`\n${"=".repeat(70)}`);
    console.log(`HASIL LOGIN BATCH (FORMAT: nomor = status)`);
    console.log(`${"=".repeat(70)}`);
    
    // Tampilkan semua hasil dengan urutan asli
    phones.forEach(phone => {
      const successResult = allSuccessResults.find(r => r.phone === phone);
      const failResult = allFailResults.find(r => r.phone === phone);
      
      if (successResult) {
        console.log(`${phone} = berhasil`);
      } else if (failResult) {
        console.log(`${phone} = gagal`);
      }
    });
    flushOutput();
    
    // Save results to separate log files
    console.log(`\n${"=".repeat(70)}`);
    console.log(`MENYIMPAN HASIL KE FILE LOG TERPISAH`);
    console.log(`${"=".repeat(70)}`);
    saveResultsToFiles(allSuccessResults, allFailResults);
    
    if (totalSuccess > 0) {
      console.log(`\n[INFO] ${totalSuccess} nomor berhasil login dengan status LOGIN`);
      console.log(`[SAVE] Data tersimpan di logs.json untuk referensi`);
      flushOutput();
    }
    
    // Retry summary
    if (retryCount > 0) {
      console.log(`\n${"=".repeat(70)}`);
      console.log(`RINGKASAN AUTO RETRY`);
      console.log(`${"=".repeat(70)}`);
      console.log(`🔄 Total retry dilakukan: ${retryCount} kali`);
      console.log(`✅ Nomor yang berhasil setelah retry: ${allSuccessResults.filter(r => r.message.includes('retry') || retryCount > 0).length}`);
      console.log(`❌ Nomor yang tetap gagal: ${totalFail}`);
      
      if (totalFail > 0) {
        console.log(`\n[FINAL FAILED] Nomor yang tetap gagal setelah ${retryCount}x retry:`);
        allFailResults.forEach(fail => {
          console.log(`   ❌ ${fail.phone} - ${fail.error}`);
        });
      }
      flushOutput();
    }
    
    // File information
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    console.log(`\n${"=".repeat(70)}`);
    console.log(`FILE LOG YANG DIBUAT:`);
    console.log(`${"=".repeat(70)}`);
    if (allSuccessResults.length > 0) {
      console.log(`📁 logsukses_${timestamp}.json - ${allSuccessResults.length} nomor berhasil`);
    }
    if (allFailResults.length > 0) {
      console.log(`📁 loggagal_${timestamp}.json - ${allFailResults.length} nomor gagal`);
    }
    console.log(`📁 logs.json - Database utama (semua log)`);
    flushOutput();
    
    // Quick action suggestions
    console.log(`\n[QUICK ACTIONS] Langkah selanjutnya:`);
    if (totalSuccess > 0) {
      console.log(`   • Jalankan 'node app.js status' untuk melihat ringkasan`);
      console.log(`   • Jalankan 'node app.js logs' untuk detail lengkap`);
      console.log(`   • Buka file logsukses_*.json untuk list nomor berhasil`);
    }
    if (totalFail > 0) {
      console.log(`   • Buka file loggagal_*.json untuk list nomor gagal`);
      console.log(`   • Coba jalankan lagi untuk nomor yang masih gagal`);
      console.log(`   • Periksa password atau koneksi internet`);
    }
    flushOutput();
    
  } catch (error) {
    console.error(`[ERROR] Error dalam auto login: ${error.message}`);
    flushOutput();
    rl.close();
  }
}

async function sendOtpViaHeadless(phone) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-dev-shm-usage","--disable-extensions","--disable-gpu"],
    slowMo: 30
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    const local = normalizeLocal(phone);
    
    console.log(`[LOGIN] Step 1: Navigasi ke halaman login...`);
    flushOutput();
    await page.goto(cfg.treasury.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    console.log("   [OK] Halaman login berhasil dimuat");
    flushOutput();
    await page.waitForTimeout(800);

    console.log(`[FILL] Step 2: Mengisi form login...`);
    flushOutput();
    
    const usernameInput = '#username';
    const passwordInput = '#password';
    const loginButton = '.btn-login';

    console.log(`   Mengisi username: ${local}...`);
    flushOutput();
    try {
      await page.waitForSelector(usernameInput, { timeout: 10000 });
      await page.locator(usernameInput).fill('');
      await page.waitForTimeout(200);
      await page.locator(usernameInput).fill(local);
      console.log("   [OK] Username berhasil terisi");
      flushOutput();
    } catch (e) {
      throw new Error(`Gagal mengisi username: ${e.message}`);
    }

    console.log(`   Mengisi password...`);
    flushOutput();
    try {
      const passwordField = page.locator(passwordInput);
      await passwordField.fill('');
      await page.waitForTimeout(200);
      await passwordField.fill(cfg.treasury.password);
      console.log("   [OK] Password berhasil terisi");
      flushOutput();
    } catch (e) {
      throw new Error(`Gagal mengisi password: ${e.message}`);
    }

    console.log(`[CLICK] Step 3: Mengklik tombol login...`);
    flushOutput();
    try {
      const loginBtn = page.locator(loginButton);
      await loginBtn.click();
      console.log("   [OK] Tombol login berhasil diklik");
      flushOutput();
    } catch (e) {
      throw new Error(`Gagal klik login button: ${e.message}`);
    }

    console.log(`[WAIT] Step 4: Menunggu response login...`);
    flushOutput();
    
    const successIndicators = [
      { selector: 'input[autocomplete="one-time-code"]', description: 'OTP input (single)' },
      { selector: 'input[maxlength="1"]', description: 'OTP input (multiple)' },
      { selector: '[role="dialog"]', description: 'Modal dialog' },
      { selector: '.ant-modal', description: 'Ant Design modal' },
      { selector: '.modal', description: 'Generic modal' },
      { selector: 'text=OTP', description: 'Text containing OTP' },
      { selector: 'text=kode', description: 'Text containing kode' },
      { selector: 'text=verifikasi', description: 'Text containing verifikasi' }
    ];
    
    const startTime = Date.now();
    let foundIndicator = null;
    let ok = false;
    
    const racePromises = successIndicators.map(async (indicator, index) => {
      try {
        await page.waitForSelector(indicator.selector, { timeout: 10000 });
        return { found: true, indicator: indicator.description, index };
      } catch (e) {
        return { found: false, indicator: indicator.description, index };
      }
    });
    
    racePromises.push(
      page.waitForFunction(() => window.location.href.includes('dashboard'), { timeout: 10000 })
        .then(() => ({ found: true, indicator: 'URL changed to dashboard', index: -1 }))
        .catch(() => ({ found: false, indicator: 'URL change check', index: -1 }))
    );
    
    try {
      const result = await Promise.race(racePromises);
      if (result.found) {
        foundIndicator = result.indicator;
        ok = true;
        console.log(`   [OK] SUCCESS INDICATOR FOUND: ${foundIndicator}`);
        flushOutput();
      }
    } catch (e) {
      console.log("   [FAIL] Timeout waiting for success indicators");
      flushOutput();
    }

    if (!ok) {
      const currentUrl = await page.url();
      if (currentUrl !== cfg.treasury.loginUrl && !currentUrl.includes('/login')) {
        ok = true;
        foundIndicator = "URL change";
      }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`   [TIME] Total waktu login: ${elapsed} detik`);
    flushOutput();
    
    if (ok) {
      console.log(`   [SUCCESS] LOGIN BERHASIL via: ${foundIndicator}`);
      flushOutput();
      return true;
    } else {
      throw new Error("Login gagal - tidak ada indikator sukses");
    }
    
  } catch (error) {
    console.error(`[ERROR] Error login ${phone}: ${error.message}`);
    flushOutput();
    throw error;
  } finally {
    console.log("[CLOSE] Menutup browser untuk login ini...");
    flushOutput();
    await ctx.close(); 
    await browser.close();
    console.log("   [OK] Browser ditutup");
    flushOutput();
  }
}

async function cmdCheckOtpRetry() {
  console.log("\n=== CHECK OTP DENGAN 5X RETRY (100 DETIK) ===");
  flushOutput();
  
  const maxRetries = 5;
  const retryInterval = 20000; // 20 seconds per retry
  
  for (let retry = 1; retry <= maxRetries; retry++) {
    console.log(`\n[RETRY] ${retry}/${maxRetries} - Checking OTP...`);
    flushOutput();
    
    autoExpire();
    const rows = readDB();
    const waiting = rows
      .filter(r => r.status === LOG_STATUS.WAITING)
      .sort((a, b) => a.createdAt - b.createdAt);
    
    if (!waiting.length) {
      console.log("[INFO] Tidak ada nomor yang menunggu OTP");
      flushOutput();
      break;
    }
    
    let foundInThisRound = 0;
    
    for (let i = 0; i < waiting.length; i++) {
      const r = waiting[i];
      
      try {
        const otp = await jasaotpGetOtp(r.orderId);
        updateLog(r.id, { 
          status: LOG_STATUS.COMPLETED, 
          details: `OTP ditemukan pada retry ${retry}: ${otp}` 
        });
        console.log(`   [SUCCESS] ${r.phone} = ${otp}`);
        flushOutput();
        foundInThisRound++;
      } catch {
        // Silent fail - will try again in next retry
      }
      
      if (i < waiting.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    
    console.log(`[ROUND ${retry}] OTP ditemukan: ${foundInThisRound}/${waiting.length}`);
    flushOutput();
    
    if (retry < maxRetries) {
      console.log(`[WAIT] Menunggu ${retryInterval/1000} detik sebelum retry berikutnya...`);
      flushOutput();
      await new Promise(resolve => setTimeout(resolve, retryInterval));
    }
  }
  
  // FORMAT OUTPUT BERSIH TANPA DEBUG NORMALISASI
  console.log(`\n=== HASIL AKHIR CHECK OTP (5X RETRY - 100 DETIK) ===`);
  flushOutput();
  
  const finalRows = readDB();
  const completed = finalRows.filter(r => r.status === LOG_STATUS.COMPLETED);
  const stillWaiting = finalRows.filter(r => r.status === LOG_STATUS.WAITING);
  
  // Display results dalam format bersih: nomor hp = otp
  if (completed.length > 0) {
    completed.forEach((r) => {
      const otpMatch = r.details.match(/OTP.*?(\d{4,8})/);
      const otp = otpMatch ? otpMatch[1] : 'unknown';
      // BERSIH: Langsung tampilkan nomor = OTP tanpa debug normalisasi
      console.log(`${r.phone} = ${otp}`);
    });
  } else {
    console.log(`Tidak ada OTP yang ditemukan`);
  }
  
  console.log(`\n[SUMMARY]`);
  console.log(`   - Berhasil dapat OTP: ${completed.length}`);
  console.log(`   - Masih menunggu: ${stillWaiting.length}`);
  flushOutput();
}

// Fungsi lainnya tetap sama...
async function cmdCreate(n) {
  const amount = Math.min(Math.max(parseInt(n||"1",10),1),50);
  console.log(`\n=== MEMULAI CREATE ${amount} AKUN (EMAIL RANDOM) ===`);
  flushOutput();
  
  let successCount = 0;
  let failCount = 0;
  
  for (let i=0; i<amount; i++) {
    console.log(`\n[PROCESS] [${i+1}/${amount}] PROSES CREATE AKUN:`);
    flushOutput();
    
    let orderId = null;
    let phone = null;
    let regData = null;
    
    try {
      console.log("1. Memesan nomor dari JasaOTP...");
      flushOutput();
      const orderResult = await jasaotpOrder();
      orderId = orderResult.orderId;
      phone = orderResult.phone;
      console.log(`   Nomor diperoleh: ${phone} (Order ID: ${orderId})`);
      flushOutput();

      console.log("2. Generate data registrasi...");
      flushOutput();
      regData = generateRegistrationData(phone, orderId);
      console.log(`   Email yang digunakan: ${regData.email}`);
      flushOutput();

      console.log("3. Mendaftarkan ke Treasury...");
      flushOutput();
      const regSuccess = await registerToTreasury(regData);
      
      addLog(LOG_STATUS.PENDING, phone, orderId, `Akun ${i+1}/${amount} - Registrasi berhasil, siap login`, regData.email);
      console.log(`   [OK] REGISTRASI BERHASIL - Status: PENDING`);
      flushOutput();
      successCount++;

    } catch (error) {
      console.error(`[FAIL] Error pada akun ${i+1}: ${error.message}`);
      flushOutput();
      failCount++;
      
      console.log(`   [SKIP] Akun tidak ditambahkan ke log karena registrasi gagal`);
      flushOutput();
    }
    
    if (i < amount - 1) {
      console.log(`   [DELAY] Menunggu 1 detik sebelum akun berikutnya...`);
      flushOutput();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`\n[RESULT] HASIL AKHIR CREATE:`);
  console.log(`   [SUCCESS] Berhasil: ${successCount}/${amount}`);
  console.log(`   [FAILED] Gagal: ${failCount}/${amount}`);
  console.log(`   [LOG] Akun tersimpan di log: ${successCount}`);
  flushOutput();
}

async function cmdSendOtp() {
  console.log("\n=== MEMULAI PROSES SEND OTP ===");
  flushOutput();
  
  autoExpire();
  const rows = readDB();
  const pending = rows
    .filter(r => r.status === LOG_STATUS.PENDING)
    .sort((a, b) => a.createdAt - b.createdAt);
  
  console.log(`[STATS] Status check:`);
  console.log(`   - Total logs: ${rows.length}`);
  console.log(`   - Pending (siap login): ${pending.length}`);
  console.log(`   - Waiting (sudah login): ${rows.filter(r => r.status === LOG_STATUS.WAITING).length}`);
  flushOutput();
  
  if (!pending.length) {
    console.log("\n[FAIL] TIDAK ADA LOG PENDING");
    flushOutput();
    return;
  }
  
console.log(`\n[ORDER] Urutan login berdasarkan waktu create (LAMA → BARU):`);
  pending.forEach((r, i) => {
    const time = new Date(r.timestamp).toLocaleString('id-ID');
    console.log(`   ${i+1}. ${r.phone} - Created: ${time}`);
  });
  flushOutput();
  
  console.log(`\n[START] Akan memproses ${pending.length} nomor untuk login:`);
  flushOutput();
  
  let ok = 0;
  let failed = 0;
  
  for (let i = 0; i < pending.length; i++) {
    const r = pending[i];
    const createdTime = new Date(r.timestamp).toLocaleString('id-ID');
    console.log(`\n[LOGIN] [${i+1}/${pending.length}] PROSES LOGIN: ${r.phone}`);
    console.log(`   Order ID: ${r.orderId}`);
    console.log(`   Created: ${createdTime} (${Math.round((Date.now() - r.createdAt) / 1000 / 60)} menit yang lalu)`);
    flushOutput();
    
    try {
      const sent = await sendOtpViaHeadless(r.phone);
      
      updateLog(r.id, { 
        status: LOG_STATUS.WAITING, 
        details: `Login berhasil - OTP dikirim untuk ${r.phone}` 
      });
      ok++;
      console.log(`   [OK] LOGIN BERHASIL - Status changed to WAITING`);
      flushOutput();
      
    } catch (error) {
      failed++;
      console.log(`   [FAIL] LOGIN GAGAL: ${error.message}`);
      flushOutput();
    }
    
    if (i < pending.length - 1) {
      console.log(`   [DELAY] Menunggu 1 detik sebelum login berikutnya...`);
      flushOutput();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`\n[RESULT] HASIL AKHIR SEND OTP:`);
  console.log(`   [OK] Berhasil login: ${ok}/${pending.length}`);
  console.log(`   [FAIL] Gagal login: ${failed}/${pending.length}`);
  flushOutput();
}

async function cmdCheckOtp() {
  console.log("\n=== MEMULAI CHECK OTP ===");
  flushOutput();
  autoExpire();
  const rows = readDB();
  const waiting = rows
    .filter(r => r.status === LOG_STATUS.WAITING)
    .sort((a, b) => a.createdAt - b.createdAt);
  
  console.log(`[STATS] Status check:`);
  console.log(`   - Waiting for OTP: ${waiting.length}`);
  flushOutput();
  
  if (!waiting.length) {
    console.log("[FAIL] Tidak ada log waiting.");
    flushOutput();
    return;
  }
  
  console.log(`\n[ORDER] Urutan check berdasarkan waktu create (LAMA → BARU):`);
  waiting.forEach((r, i) => {
    const time = new Date(r.timestamp).toLocaleString('id-ID');
    console.log(`   ${i+1}. ${r.phone} - Created: ${time}`);
  });
  flushOutput();
  
  console.log(`\n[CHECK] Mengecek ${waiting.length} nomor untuk OTP:`);
  flushOutput();
  let found = 0;
  
  for (let i = 0; i < waiting.length; i++) {
    const r = waiting[i];
    const createdTime = new Date(r.timestamp).toLocaleString('id-ID');
    console.log(`\n[OTP] [${i+1}/${waiting.length}] Cek OTP: ${r.phone}`);
    console.log(`   Created: ${createdTime} (${Math.round((Date.now() - r.createdAt) / 1000 / 60)} menit yang lalu)`);
    flushOutput();
    
    try {
      const otp = await jasaotpGetOtp(r.orderId);
      updateLog(r.id, { 
        status: LOG_STATUS.COMPLETED, 
        details: `OTP tersedia: ${otp}` 
      });
      console.log(`   [SUCCESS] ${normalizeLocal(r.phone)} = ${otp}`);
      flushOutput();
      found++;
    } catch {
      console.log(`   [WAIT] Belum ada OTP: ${r.phone}`);
      flushOutput();
    }
    
    if (i < waiting.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 500)); // Faster
    }
  }
  
  console.log(`\n[RESULT] HASIL CHECK OTP:`);
  flushOutput();
  if (found) {
    console.log(`   [OK] Total OTP ditemukan: ${found}/${waiting.length}`);
  } else {
    console.log(`   [INFO] Belum ada OTP yang masuk, coba lagi nanti`);
  }
  flushOutput();
}

async function cmdAutoComplete() {
  const rl = createInterface();
  
  try {
    console.log("\n=== AUTOMASI LENGKAP: CREATE + SEND OTP + CHECK OTP ===");
    flushOutput();
    
    const amountStr = await askQuestion(rl, "Masukkan jumlah akun yang ingin dibuat (1-50): ");
    const amount = parseInt(amountStr, 10);
    
    if (amount < 1 || amount > 50) {
      console.log("[ERROR] Jumlah harus antara 1-50!");
      flushOutput();
      rl.close();
      return;
    }
    
    console.log("\nPilihan email:");
    console.log("1. Email random otomatis");
    console.log("2. Email manual (input sendiri)");
    
    const emailChoice = await askQuestion(rl, "Pilih jenis email (1/2): ");
    
    let emails = [];
    if (emailChoice === "2") {
      console.log(`\n[INPUT] Masukkan ${amount} email secara berurutan:`);
      flushOutput();
      
      for (let i = 0; i < amount; i++) {
        const email = await askQuestion(rl, `Email ${i+1}/${amount}: `);
        if (!email.includes('@') || !email.includes('.')) {
          console.log(`[WARN] Email "${email}" tidak valid, tetapi akan tetap digunakan`);
          flushOutput();
        }
        emails.push(email);
      }
    }
    
    rl.close();
    
    console.log(`\n[START] Memulai automasi lengkap untuk ${amount} akun...`);
    flushOutput();
    
    console.log("\n" + "=".repeat(60));
    console.log("STEP 1: CREATE ACCOUNTS");
    console.log("=".repeat(60));
    
    if (emailChoice === "2") {
      await cmdCreateManual(amount, emails);
    } else {
      await cmdCreate(amount);
    }
    
    console.log("\n[DELAY] Menunggu 5 detik sebelum memulai login...");
    flushOutput();
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log("\n" + "=".repeat(60));
    console.log("STEP 2: SEND OTP (LOGIN)");
    console.log("=".repeat(60));
    
    await cmdSendOtp();
    
    console.log("\n[DELAY] Menunggu 10 detik untuk OTP masuk...");
    flushOutput();
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    console.log("\n" + "=".repeat(60));
    console.log("STEP 3: CHECK OTP (5X RETRY)");
    console.log("=".repeat(60));
    
    await cmdCheckOtpRetry();
    
    console.log("\n" + "=".repeat(60));
    console.log("AUTOMASI LENGKAP SELESAI!");
    console.log("=".repeat(60));
    flushOutput();
    
  } catch (error) {
    console.error(`[ERROR] Error dalam automasi lengkap: ${error.message}`);
    flushOutput();
    rl.close();
  }
}

async function cmdCreateManual(n, emails) {
  const amount = Math.min(Math.max(parseInt(n||"1",10),1),50);
  console.log(`\n=== MEMULAI CREATE ${amount} AKUN DENGAN EMAIL MANUAL ===`);
  flushOutput();
  
  let successCount = 0;
  let failCount = 0;
  
  for (let i=0; i<amount; i++) {
    console.log(`\n[PROCESS] [${i+1}/${amount}] PROSES CREATE AKUN MANUAL:`);
    console.log(`   Email yang akan digunakan: ${emails[i]}`);
    flushOutput();
    
    let orderId = null;
    let phone = null;
    let regData = null;
    
    try {
      console.log("1. Memesan nomor dari JasaOTP...");
      flushOutput();
      const orderResult = await jasaotpOrder();
      orderId = orderResult.orderId;
      phone = orderResult.phone;
      console.log(`   Nomor diperoleh: ${phone} (Order ID: ${orderId})`);
      flushOutput();

      console.log("2. Generate data registrasi dengan email manual...");
      flushOutput();
      regData = generateRegistrationData(phone, orderId, emails[i]);
      console.log(`   Email yang digunakan: ${regData.email}`);
      flushOutput();

      console.log("3. Mendaftarkan ke Treasury...");
      flushOutput();
      const regSuccess = await registerToTreasury(regData);
      
      addLog(LOG_STATUS.PENDING, phone, orderId, `Akun ${i+1}/${amount} - Registrasi berhasil (Email: ${emails[i]})`, emails[i]);
      console.log(`   [OK] REGISTRASI BERHASIL - Status: PENDING`);
      flushOutput();
      successCount++;

    } catch (error) {
      console.error(`[FAIL] Error pada akun ${i+1}: ${error.message}`);
      flushOutput();
      failCount++;
      
      console.log(`   [SKIP] Akun tidak ditambahkan ke log karena registrasi gagal`);
      flushOutput();
    }
    
    if (i < amount - 1) {
      console.log(`   [DELAY] Menunggu 1 detik sebelum akun berikutnya...`);
      flushOutput();
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  
  console.log(`\n[RESULT] HASIL AKHIR CREATE MANUAL:`);
  console.log(`   [SUCCESS] Berhasil: ${successCount}/${amount}`);
  console.log(`   [FAILED] Gagal: ${failCount}/${amount}`);
  console.log(`   [LOG] Akun tersimpan di log: ${successCount}`);
  flushOutput();
}

function cmdStatus() {
  console.log("\n=== STATUS LOGS ===");
  flushOutput();
  autoExpire();
  const rows = readDB();
  const g = (s) => rows.filter(r => r.status === s).length;
  
  const stats = {
    total: rows.length,
    pending: g(LOG_STATUS.PENDING),
    waiting: g(LOG_STATUS.WAITING), 
    completed: g(LOG_STATUS.COMPLETED),
    success: g(LOG_STATUS.SUCCESS),
    expired: g(LOG_STATUS.EXPIRED),
    failed: g(LOG_STATUS.FAILED),
    login: g(LOG_STATUS.LOGIN)
  };
  
  console.log("[STATS] Ringkasan status:");
  console.log(`   Total logs: ${stats.total}`);
  console.log(`   Pending (siap login): ${stats.pending}`);
  console.log(`   Waiting (menunggu OTP): ${stats.waiting}`);
  console.log(`   Completed (OTP tersedia): ${stats.completed}`);
  console.log(`   Login (berhasil login): ${stats.login}`);
  console.log(`   Success (berhasil total): ${stats.success}`);
  console.log(`   Failed (gagal): ${stats.failed}`);
  console.log(`   Expired (kadaluarsa): ${stats.expired}`);
  flushOutput();
  
  if (rows.length > 0) {
    console.log("\n[RECENT] 5 Log terbaru:");
    const recent = rows.slice(0, 5);
    recent.forEach((r, i) => {
      const time = new Date(r.timestamp).toLocaleString('id-ID');
      console.log(`   ${i+1}. [${r.status.toUpperCase()}] ${r.phone} - ${time}`);
      if (r.details) console.log(`      Detail: ${r.details}`);
      if (r.email) console.log(`      Email: ${r.email}`);
    });
    flushOutput();
  }
}

function cmdClear() {
  try {
    const rows = readDB();
    if (rows.length > 0) {
      const backupFile = `logs_backup_${Date.now()}.json`;
      fs.writeFileSync(backupFile, JSON.stringify(rows, null, 2));
      console.log(`[BACKUP] Logs lama disimpan ke: ${backupFile}`);
      flushOutput();
    }
    
    writeDB([]);
    console.log("[SUCCESS] Logs berhasil dihapus dan direset");
    console.log("[INFO] File logs.json telah direset ke array kosong []");
    console.log("[READY] Siap untuk create akun baru");
    flushOutput();
  } catch (error) {
    console.error("[ERROR] Gagal menghapus logs:", error.message);
    flushOutput();
  }
}

function cmdLogs() {
  console.log("\n=== DETAIL LOGS ===");
  flushOutput();
  autoExpire();
  const rows = readDB();
  
  if (!rows.length) {
    console.log("[INFO] Tidak ada logs");
    flushOutput();
    return;
  }
  
  const sortedRows = [...rows].sort((a, b) => a.createdAt - b.createdAt);
  
  console.log(`[TOTAL] ${rows.length} logs ditemukan (diurutkan LAMA → BARU):\n`);
  flushOutput();
  
  sortedRows.forEach((r, i) => {
    const time = new Date(r.timestamp).toLocaleString('id-ID');
    const ageMinutes = Math.round((Date.now() - r.createdAt) / 1000 / 60);
    console.log(`${i+1}. ID: ${r.id}`);
    console.log(`   Status: [${r.status.toUpperCase()}]`);
    console.log(`   Phone: ${r.phone}`);
    console.log(`   Order ID: ${r.orderId}`);
    console.log(`   Time: ${time} (${ageMinutes} menit yang lalu)`);
    if (r.details) console.log(`   Details: ${r.details}`);
    if (r.email) console.log(`   Email: ${r.email}`);
    console.log("");
    flushOutput();
  });
}

function createInterface() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function askMultilineQuestion(rl, question) {
  return new Promise((resolve) => {
    console.log(question);
    console.log("PILIHAN INPUT:");
    console.log("1. Paste semua nomor dengan spasi: 08111 08222 08333");
    console.log("2. Atau ketik satu per baris, lalu ketik 'DONE' di akhir");
    console.log("3. Format mixed juga didukung");
    flushOutput();
    
    const lines = [];
    let isMultilineMode = false;
    
    const processLine = (line) => {
      const trimmed = line.trim();
      
      // Jika input mengandung spasi, anggap sebagai single-line input
      if (!isMultilineMode && trimmed.includes(' ')) {
        rl.removeListener('line', processLine);
        resolve(trimmed);
        return;
      }
      
      // Set multiline mode jika ada input tanpa spasi
      if (!isMultilineMode && trimmed && !trimmed.includes(' ')) {
        isMultilineMode = true;
      }
      
      if (trimmed.toLowerCase() === 'done' || trimmed.toLowerCase() === '/end') {
        rl.removeListener('line', processLine);
        resolve(lines.join(' '));
      } else if (trimmed) {
        lines.push(trimmed);
        console.log(`[INPUT] Line ${lines.length}: ${trimmed}`);
        if (!isMultilineMode) {
          console.log("[HINT] Ketik 'DONE' jika sudah selesai, atau lanjut ketik nomor berikutnya");
        }
        flushOutput();
      }
    };
    
    rl.on('line', processLine);
  });
}

async function cmdManualEmail() {
  const rl = createInterface();
  
  try {
    const amountStr = await askQuestion(rl, "Masukkan jumlah akun yang ingin dibuat (1-50): ");
    const amount = parseInt(amountStr, 10);
    
    if (amount < 1 || amount > 50) {
      console.log("[ERROR] Jumlah harus antara 1-50!");
      flushOutput();
      rl.close();
      return;
    }
    
    console.log(`\n[INPUT] Masukkan ${amount} email secara berurutan:`);
    flushOutput();
    
    const emails = [];
    
    for (let i = 0; i < amount; i++) {
      const email = await askQuestion(rl, `Email ${i+1}/${amount}: `);
      
      if (!email.includes('@') || !email.includes('.')) {
        console.log(`[WARN] Email "${email}" tidak valid, tetapi akan tetap digunakan`);
        flushOutput();
      }
      
      emails.push(email);
    }
    
    console.log(`\n[CONFIRM] Email yang akan digunakan:`);
    emails.forEach((email, i) => {
      console.log(`   ${i+1}. ${email}`);
    });
    flushOutput();
    
    const confirm = await askQuestion(rl, "\nLanjutkan proses create akun? (y/n): ");
    
    if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
      console.log("[CANCEL] Proses create akun dibatalkan");
      flushOutput();
      rl.close();
      return;
    }
    
    rl.close();
    
    console.log(`\n[START] Memulai create ${amount} akun dengan email manual...`);
    flushOutput();
    
    await cmdCreateManual(amount, emails);
    
  } catch (error) {
    console.error(`[ERROR] Error dalam cmdManualEmail: ${error.message}`);
    flushOutput();
    rl.close();
  }
}

// SIMPLIFIED MENU - HANYA 3 COMMAND UTAMA
async function cmdMulai() {
  while (true) {
    const rl = createInterface();
    
    console.log("\n" + "=".repeat(60));
    console.log("               TREASURY AUTOMATION MENU");
    console.log("=".repeat(60));
    console.log("1. AUTO COMPLETE (Create + Send + Check OTP)");
    console.log("2. Auto Login Batch (paste nomor tanpa batas + auto retry)");
    console.log("3. Clear Logs (Hapus semua log)");
    console.log("4. Exit");
    console.log("=".repeat(60));
    flushOutput();
    
    const choice = await askQuestion(rl, "Pilih menu (1-4): ");
    rl.close();
    
    switch (choice) {
      case "1":
        console.log("\n[START] Automasi lengkap...");
        flushOutput();
        await cmdAutoComplete();
        break;
        
      case "2":
        console.log("\n[START] Memulai auto login batch dengan auto retry...");
        flushOutput();
        await cmdAutoLogin();
        break;
        
      case "3":
        const rl3 = createInterface();
        const confirm = await askQuestion(rl3, "Yakin ingin menghapus semua logs? (y/n): ");
        rl3.close();
        if (confirm.toLowerCase() === 'y' || confirm.toLowerCase() === 'yes') {
          cmdClear();
        } else {
          console.log("[CANCEL] Penghapusan logs dibatalkan");
          flushOutput();
        }
        break;
        
      case "4":
        console.log("\n[EXIT] Keluar dari program...");
        flushOutput();
        return;
        
      default:
        console.log("[ERROR] Pilihan tidak valid! Gunakan angka 1-4.");
        flushOutput();
        break;
    }
  }
}

// MAIN EXECUTION
(async () => {
  const [,, cmd, arg] = process.argv;
  try {
    if (cmd === "mulai")              await cmdMulai();
    else if (cmd === "create")        await cmdCreate(arg);
    else if (cmd === "create-manual") await cmdManualEmail();
    else if (cmd === "send-otp")      await cmdSendOtp();
    else if (cmd === "check-otp")     await cmdCheckOtp();
    else if (cmd === "check-retry")   await cmdCheckOtpRetry();
    else if (cmd === "auto-complete") await cmdAutoComplete();
    else if (cmd === "auto-login")    await cmdAutoLogin();
    else if (cmd === "status")        cmdStatus();
    else if (cmd === "logs")          cmdLogs();
    else if (cmd === "clear")         cmdClear();
    else {
      console.log(`Treasury Automation Tool - Usage:

MENU INTERAKTIF (3 COMMANDS UTAMA):
  node app.js mulai             - Menu interaktif dengan 3 pilihan utama:
                                  1. AUTO COMPLETE (Create + Send + Check OTP)
                                  2. Auto Login Batch (paste nomor tanpa batas + auto retry)
                                  3. Clear Logs (hapus semua log)

COMMAND MANUAL LANGSUNG (SEMUA FUNGSI TETAP TERSEDIA):
  node app.js create <1-50>     - Order nomor + daftar ke Treasury (email random)
  node app.js create-manual     - Create akun dengan email manual
  node app.js send-otp          - Login ke Treasury (kirim OTP)
  node app.js check-otp         - Cek OTP yang masuk dari JasaOTP
  node app.js check-retry       - Cek OTP 5x retry dalam 100 detik
  node app.js auto-complete     - Automasi lengkap (create + send + check)
  node app.js auto-login        - Login otomatis batch (paste nomor tanpa batas + auto retry)
  node app.js status            - Lihat ringkasan status
  node app.js logs              - Lihat detail semua log
  node app.js clear             - Hapus semua log (reset)

FITUR AUTO LOGIN BATCH (UNLIMITED & OPTIMIZED + AUTO RETRY):
  - TANPA BATAS MAKSIMAL - proses sebanyak apapun nomor
  - AUTO RETRY - nomor yang gagal akan dicoba lagi maksimal 2x
  - FORMAT OUTPUT BERSIH - seperti OTP check (nomor = berhasil/gagal)
  - PROGRESS REALTIME - persentase dan estimasi waktu
  - STATISTIK LENGKAP - throughput, success rate, retry summary
  
  Paste nomor dengan format apapun:
  
  OPSI 1 - Single line dengan spasi:
  088991425191 088991427791 088991425095
  
  OPSI 2 - Multi line dengan DONE:
  088991425191
  088991427791
  088991425095
  DONE
  
  OPSI 3 - Mixed format:
  088991425191 088991427791
  088991425095
  DONE

FITUR BARU AUTO RETRY:
  - Nomor yang gagal akan dikumpulkan dan dicoba lagi
  - Maksimal 2x retry dengan delay 5 detik antar round
  - Output akhir menampilkan semua nomor dengan format: nomor = berhasil/gagal
  - Statistik retry lengkap dengan breakdown hasil

SUPPORTED FORMATS:
  - 08123456789 (standard Indonesia)
  - +628123456789 (international format)
  - 628123456789 (without + prefix)  
  - 8123456789 (without country code)

SUPPORTED PREFIXES:
  - Telkomsel: 0811-0819, 0821-0823
  - Indosat: 0831-0833, 0855-0859  
  - XL: 0817-0818, 0877-0878, 0881-0889
  - Three: 0895-0899
  - Smartfren: 0838, 0851-0853

SETUP PERTAMA KALI:
  - Klik klikdisini.bat untuk setup otomatis
  - Atau manual: npm install && npm run playwright:install
`);
      flushOutput();
    }
  } catch (e) {
    console.error("[ERROR] Program error:", e.message);
    console.log("\n[TIP] Jika ada error JSON, coba: node app.js clear");
    flushOutput();
    process.exit(1);
  }
})();