import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 4000;
const DATA_FILE = path.join(__dirname, 'data', 'licenses.json');
const CLOUD_DIR = path.join(__dirname, 'data', 'cloud_stores');
const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');

// Global Exception Handler agar proses server Node.js tidak mati jika ada error jaringan/Baileys
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

// Pastikan folder data, cloud stores, dan auth ada
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(CLOUD_DIR)) {
  fs.mkdirSync(CLOUD_DIR, { recursive: true });
}
if (!fs.existsSync(AUTH_DIR)) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

// ==============================================================================
// 1. MANAJEMEN DATABASE WHITELIST LISENSI
// ==============================================================================
function getLicenses() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveLicenses(licenses) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(licenses, null, 2), 'utf-8');
}

function normalizePhone(phone) {
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('+62')) cleaned = '0' + cleaned.substring(3);
  else if (cleaned.startsWith('62')) cleaned = '0' + cleaned.substring(2);
  return cleaned;
}

function formatToWhatsAppJid(phone) {
  let cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.substring(1);
  }
  return `${cleaned}@s.whatsapp.net`;
}

function calculateExpiration(plan) {
  const now = new Date();
  switch (plan) {
    case 'DAILY':
      return new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString();
    case 'WEEKLY':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    case 'MONTHLY':
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
    case 'ANNUAL':
      return new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
    case 'LIFETIME':
    default:
      return '2099-12-31T23:59:59.000Z';
  }
}

function getPlanName(plan) {
  switch (plan) {
    case 'DAILY': return 'Paket Harian (1 Hari)';
    case 'WEEKLY': return 'Paket Mingguan (7 Hari)';
    case 'MONTHLY': return 'Paket Bulanan (30 Hari)';
    case 'ANNUAL': return 'Paket Tahunan (365 Hari)';
    case 'LIFETIME': default: return 'Paket Lifetime (Permanen)';
  }
}

// In-Memory Pending OTPs
const pendingOtps = new Map(); // email -> { otp, phone, machineId, expiresAt }

// ==============================================================================
// 2. KONEKSI WHATSAPP SOCKET (BAILEYS - 100% FREE SELF-HOSTED)
// ==============================================================================
let waSocket = null;
let isWaConnected = false;
let waQrCodeText = null;
let connectedPhoneNumber = null;

async function startWhatsAppService() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  waSocket = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }), // Heningkan log verbose
    printQRInTerminal: false, // Kami cetak kustom agar rapi
    browser: ['Kasir POS Server', 'Chrome', '1.0.0'],
  });

  waSocket.ev.on('creds.update', saveCreds);

  waSocket.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waQrCodeText = qr;
      isWaConnected = false;
      console.log('\n====================================================================');
      console.log('  SCAN QR CODE DI BAWAH DENGAN WHATSAPP DI HP ANDA (SERVER UTAMA)   ');
      console.log('====================================================================');
      console.log('Petunjuk: Buka WhatsApp di HP Anda > Titik 3 / Pengaturan >');
      console.log('          Perangkat Tertaut (Linked Devices) > Tautkan Perangkat\n');
      qrcode.generate(qr, { small: true });
      console.log('====================================================================\n');
    }

    if (connection === 'open') {
      isWaConnected = true;
      waQrCodeText = null;
      connectedPhoneNumber = waSocket?.user?.id?.split(':')[0] || 'Nomor Anda';
      console.log('\n====================================================================');
      console.log(`✓ WHATSAPP SERVER TERHUBUNG! Nomor Pengirim: +${connectedPhoneNumber}`);
      console.log('  Server siap mengirimkan kode OTP secara otomatis ke pembeli kasir.');
      console.log('====================================================================\n');
    }

    if (connection === 'close') {
      isWaConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`Koneksi WhatsApp terputus (Status: ${statusCode}). Reconnecting: ${shouldReconnect}...`);
      if (shouldReconnect) {
        setTimeout(startWhatsAppService, 3000);
      } else {
        console.log('WhatsApp telah logout dari HP Anda. Silakan restart server untuk scan QR ulang.');
      }
    }
  });
}

// Jalankan koneksi WhatsApp di latar belakang
startWhatsAppService().catch((err) => {
  console.error('Error saat inisialisasi WhatsApp Baileys:', err);
});

// Helper Pengiriman Pesan WhatsApp
async function sendWhatsAppOtp(phone, storeName, otp) {
  const message =
    `*KASIR POS GROSIR - KODE AKTIVASI*\n\n` +
    `Halo *${storeName}*,\n\n` +
    `Kode OTP verifikasi aktivasi perangkat PC kasir Anda adalah:\n\n` +
    `🔐 *${otp}*\n\n` +
    `_Kode ini hanya berlaku selama 5 menit. Jangan berikan kode ini kepada siapa pun demi keamanan toko Anda._`;

  if (!isWaConnected || !waSocket) {
    console.warn(`[WA OFFLINE] WhatsApp belum tersambung ke HP. Pesan simulasi:\n${message}`);
    return { success: false, offline: true, message: 'WhatsApp server belum tersambung ke HP' };
  }

  try {
    const jid = formatToWhatsAppJid(phone);
    await waSocket.sendMessage(jid, { text: message });
    console.log(`[WA SENT] Kode OTP ${otp} berhasil terkirim ke WhatsApp ${phone} (${storeName})`);
    return { success: true };
  } catch (err) {
    console.error(`[WA ERROR] Gagal mengirim pesan ke ${phone}:`, err);
    return { success: false, error: err.message };
  }
}

// ==============================================================================
// 3. EXPRESS REST API SERVER UNTUK APLIKASI KASIR & DASHBOARD ADMIN
// ==============================================================================
const app = express();
app.use(cors());
app.use(express.json());

// Endpoint Status Server & WhatsApp
app.get('/api/status', (req, res) => {
  res.json({
    status: 'ONLINE',
    whatsapp: {
      connected: isWaConnected,
      phone_number: connectedPhoneNumber,
      has_qr: !!waQrCodeText,
    },
    total_clients: getLicenses().length,
  });
});

// A. ENDPOINT REQUEST OTP (DIPANGGIL DARI PC KASIR PEMBELI)
app.post('/api/license/request-otp', async (req, res) => {
  const { email, phone, machine_id } = req.body;

  if (!email || !phone) {
    return res.status(400).json({ success: false, message: 'Email dan nomor WhatsApp wajib diisi.' });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanPhone = normalizePhone(phone);
  const licenses = getLicenses();

  // 1. Cek Whitelist: Apakah email ada di database Anda?
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);
  if (!client) {
    return res.status(403).json({
      success: false,
      message:
        'Email ini belum terdaftar di sistem lisensi kami. ' +
        'Silakan hubungi pengembang/vendor software untuk mendaftarkan lisensi toko Anda.',
    });
  }

  // 2. Cek apakah nomor WA cocok dengan email terdaftar
  if (normalizePhone(client.registered_phone) !== cleanPhone) {
    return res.status(403).json({
      success: false,
      message: 'Nomor WhatsApp tidak cocok dengan email terdaftar. Periksa kembali nomor yang Anda masukkan.',
    });
  }

  // 3. Cek Status Lisensi
  if (client.status !== 'ACTIVE') {
    return res.status(403).json({
      success: false,
      message: `Lisensi untuk toko "${client.store_name}" saat ini berstatus ${client.status}. Hubungi admin.`,
    });
  }

  // 4. Cek Single Device Lock: Apakah sedang aktif di PC lain?
  if (client.active_device_id && client.active_device_id !== machine_id) {
    return res.status(403).json({
      success: false,
      message:
        `Lisensi ini sedang aktif di PC lain (${client.active_device_id}). ` +
        `Satu lisensi hanya berlaku untuk 1 komputer. Silakan lakukan "Putus Perangkat / Logout" dari PC lama Anda.`,
    });
  }

  // 5. Generate OTP 6 Digit
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  pendingOtps.set(cleanEmail, {
    otp,
    phone: cleanPhone,
    machineId: machine_id,
    expiresAt: Date.now() + 5 * 60 * 1000, // 5 menit
  });

  // 6. Kirim via WhatsApp HP Anda
  const sendResult = await sendWhatsAppOtp(cleanPhone, client.store_name, otp);

  res.json({
    success: true,
    message: `Kode OTP 6-digit berhasil dikirimkan ke WhatsApp ${cleanPhone}.`,
    cooldown_seconds: 60,
    wa_connected: isWaConnected,
    // Jika WhatsApp belum di-scan di HP, sediakan demo_otp agar pengetesan tetap berjalan lancar
    demo_otp: !isWaConnected ? otp : undefined,
  });
});

// B. ENDPOINT LOGIN LANGSUNG VIA GMAIL (GOOGLE ACCOUNT)
app.post('/api/license/login-gmail', (req, res) => {
  const { email, machine_id, hostname } = req.body;
  const cleanEmail = email?.trim().toLowerCase();

  if (!cleanEmail) {
    return res.status(400).json({ success: false, message: 'Alamat email Gmail wajib diisi.' });
  }
  if (!machine_id) {
    return res.status(400).json({ success: false, message: 'Identitas perangkat PC (Machine ID) wajib disertakan.' });
  }

  const licenses = getLicenses();
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);

  // 1. Cek apakah email terdaftar di Whitelist Vendor
  if (!client) {
    return res.status(404).json({
      success: false,
      code: 'UNREGISTERED',
      message: `Akun "${cleanEmail}" belum terdaftar di sistem kasir. Silakan hubungi Vendor (+6287714491014) untuk aktivasi lisensi (Tersedia: Harian, Mingguan, Bulanan, Tahunan, Lifetime).`,
    });
  }

  // 2. Cek apakah akun dinonaktifkan/dibekukan oleh Vendor (Remote Kill-Switch)
  if (client.status === 'SUSPENDED' || client.status === 'REVOKED') {
    return res.status(403).json({
      success: false,
      code: 'SUSPENDED',
      message: `Akun toko "${client.store_name}" sedang dinonaktifkan oleh server. Hubungi Vendor (+6287714491014).`,
    });
  }

  // 3. Cek Masa Kedaluwarsa Paket Langganan
  if (client.expires_at && new Date() > new Date(client.expires_at)) {
    client.status = 'EXPIRED';
    saveLicenses(licenses);
    return res.status(403).json({
      success: false,
      code: 'EXPIRED',
      message: `Masa aktif paket ${client.plan_name || 'lisensi'} Anda telah berakhir pada ${new Date(client.expires_at).toLocaleDateString('id-ID')}. Silakan hubungi Vendor untuk perpanjangan.`,
    });
  }

  // 4. ATURAN SINGLE ACTIVE DEVICE (ANTI-PIRASI):
  // Jika akun ini sudah aktif di PC lain, TOLAK PC INI, dan PC PERTAMA TETAP AKTIF AMAN.
  if (client.active_device_id && client.active_device_id !== machine_id) {
    return res.status(403).json({
      success: false,
      code: 'DEVICE_LOCKED',
      message: `Akun "${cleanEmail}" saat ini sedang aktif digunakan di PC lain (${client.active_hostname || client.active_device_id}). Satu akun hanya diizinkan aktif di 1 komputer di waktu yang sama. Silakan logout dari komputer sebelumnya, atau hubungi Vendor (+6287714491014) untuk reset perangkat.`,
      active_device_id: client.active_device_id,
      active_hostname: client.active_hostname,
    });
  }

  // 5. Jika lolos (pertama kali atau PC yang sama): Kunci perangkat ini
  client.active_device_id = machine_id;
  client.active_hostname = hostname || client.active_hostname || 'PC Kasir';
  client.last_heartbeat_at = new Date().toISOString();
  saveLicenses(licenses);

  // 6. Buat Token Lisensi Sesi
  const token = Buffer.from(
    JSON.stringify({
      lic_id: client.id,
      email: client.registered_email,
      phone: client.registered_phone,
      machine_id: machine_id,
      hostname: client.active_hostname,
      store_name: client.store_name,
      owner_name: client.owner_name,
      plan: client.plan || 'LIFETIME',
      plan_name: client.plan_name || getPlanName(client.plan || 'LIFETIME'),
      expires_at: client.expires_at,
      issued_at: new Date().toISOString(),
    })
  ).toString('base64');

  res.json({
    success: true,
    message: `Login berhasil! Selamat datang di ${client.store_name}.`,
    token,
    store_name: client.store_name,
    owner_name: client.owner_name,
    plan: client.plan || 'LIFETIME',
    plan_name: client.plan_name || getPlanName(client.plan || 'LIFETIME'),
    expires_at: client.expires_at,
  });
});

// C. ENDPOINT VERIFIKASI OTP & KUNCI HARDWARE (Cadangan WA Gateway)
app.post('/api/license/verify-otp', (req, res) => {
  const { email, otp_code, machine_id, hostname } = req.body;
  const cleanEmail = email?.trim().toLowerCase();
  const cleanOtp = otp_code?.trim();

  const pending = pendingOtps.get(cleanEmail);
  if (!pending) {
    return res.status(400).json({ success: false, message: 'Kode OTP tidak ditemukan atau telah kedaluwarsa.' });
  }

  if (Date.now() > pending.expiresAt) {
    pendingOtps.delete(cleanEmail);
    return res.status(400).json({ success: false, message: 'Kode OTP telah kedaluwarsa. Minta kode baru.' });
  }

  if (pending.otp !== cleanOtp) {
    return res.status(400).json({ success: false, message: 'Kode OTP salah. Periksa kembali WhatsApp Anda.' });
  }

  const licenses = getLicenses();
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);
  if (!client) {
    return res.status(404).json({ success: false, message: 'Data klien tidak ditemukan.' });
  }

  // ATURAN SINGLE DEVICE: TOLAK JIKA AKTIF DI PC LAIN
  if (client.active_device_id && client.active_device_id !== machine_id) {
    return res.status(403).json({
      success: false,
      code: 'DEVICE_LOCKED',
      message: `Akun ini sedang aktif di PC lain (${client.active_hostname || client.active_device_id}). Logout dari PC lama terlebih dahulu.`,
    });
  }

  client.active_device_id = machine_id;
  client.active_hostname = hostname || client.active_hostname || 'PC Kasir';
  client.last_heartbeat_at = new Date().toISOString();
  saveLicenses(licenses);
  pendingOtps.delete(cleanEmail);

  const token = Buffer.from(
    JSON.stringify({
      lic_id: client.id,
      email: client.registered_email,
      phone: client.registered_phone,
      machine_id: machine_id,
      hostname: client.active_hostname,
      store_name: client.store_name,
      owner_name: client.owner_name,
      plan: client.plan || 'LIFETIME',
      plan_name: client.plan_name || getPlanName(client.plan || 'LIFETIME'),
      expires_at: client.expires_at,
      issued_at: new Date().toISOString(),
    })
  ).toString('base64');

  res.json({
    success: true,
    message: 'Aktivasi perangkat berhasil! Selamat datang di aplikasi kasir.',
    token,
    store_name: client.store_name,
    owner_name: client.owner_name,
    plan: client.plan || 'LIFETIME',
    plan_name: client.plan_name || getPlanName(client.plan || 'LIFETIME'),
    expires_at: client.expires_at,
  });
});

// D. ENDPOINT HEARTBEAT & TELEMETRI AKTIVITAS
app.post('/api/license/heartbeat', (req, res) => {
  const { token, machine_id, hostname, total_products, total_transactions } = req.body;
  if (!token) return res.status(400).json({ valid: false, message: 'Token tidak disertakan.' });

  try {
    const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
    const licenses = getLicenses();
    const client = licenses.find((l) => l.registered_email.toLowerCase() === decoded.email?.toLowerCase());

    if (!client) {
      return res.json({ valid: false, status: 'UNREGISTERED', message: 'Lisensi tidak ditemukan di server.' });
    }

    if (client.status !== 'ACTIVE') {
      return res.json({ valid: false, status: client.status, message: `Status akun saat ini: ${client.status}.` });
    }

    // Jika akun sedang aktif di PC lain, tolak heartbeat PC ini
    if (client.active_device_id && client.active_device_id !== machine_id) {
      return res.json({
        valid: false,
        status: 'REVOKED',
        message: `Lisensi aktif di PC lain (${client.active_hostname || client.active_device_id}).`,
      });
    }

    // Periksa kedaluwarsa
    if (client.expires_at && new Date() > new Date(client.expires_at)) {
      client.status = 'EXPIRED';
      saveLicenses(licenses);
      return res.json({ valid: false, status: 'EXPIRED', message: 'Masa aktif lisensi telah habis.' });
    }

    // Update Telemetri Live
    client.last_heartbeat_at = new Date().toISOString();
    if (hostname) client.active_hostname = hostname;
    if (typeof total_products === 'number') client.total_products = total_products;
    if (typeof total_transactions === 'number') client.total_transactions = total_transactions;
    saveLicenses(licenses);

    res.json({
      valid: true,
      status: 'ACTIVE',
      plan: client.plan || 'LIFETIME',
      plan_name: client.plan_name || getPlanName(client.plan || 'LIFETIME'),
      expires_at: client.expires_at,
      message: 'Lisensi aktif dan sah.',
    });
  } catch {
    res.json({ valid: false, status: 'UNREGISTERED', message: 'Format token tidak valid.' });
  }
});

// E. ENDPOINT LOGOUT / PUTUS IKATAN PERANGKAT (DEAKTIVASI DARI PC)
app.post('/api/license/deactivate', (req, res) => {
  const { email, machine_id } = req.body;
  const cleanEmail = email?.trim().toLowerCase();
  const licenses = getLicenses();
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);

  if (client && client.active_device_id === machine_id) {
    client.active_device_id = null;
    client.active_hostname = null;
    saveLicenses(licenses);
    return res.json({ success: true, message: 'Perangkat berhasil diputus. Akun sekarang siap login di PC baru.' });
  }

  res.json({ success: true, message: 'Perangkat tidak terikat.' });
});

// ==============================================================================
// 3.5. ENDPOINT CLOUD DATABASE SYNC & BACKUP
// ==============================================================================

function sanitizeCloudEmail(email) {
  return email.toLowerCase().replace(/[^a-z0-9]/g, '_');
}

// A. PUSH: Simpan Snapshot Database Lokal ke Cloud Server
app.post('/api/cloud-sync/push', (req, res) => {
  const { email, machine_id, snapshot } = req.body;
  const cleanEmail = email?.trim().toLowerCase();

  if (!cleanEmail || !snapshot) {
    return res.status(400).json({ success: false, message: 'Email dan snapshot data toko wajib disertakan.' });
  }

  const licenses = getLicenses();
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);
  if (!client) {
    return res.status(404).json({ success: false, message: 'Akun tidak terdaftar di server.' });
  }

  if (client.status !== 'ACTIVE') {
    return res.status(403).json({ success: false, message: `Akun berstatus ${client.status}. Tidak dapat melakukan sync.` });
  }

  try {
    const cloudFilePath = path.join(CLOUD_DIR, `${sanitizeCloudEmail(cleanEmail)}.json`);
    const cloudData = {
      email: cleanEmail,
      store_name: snapshot.store_name || client.store_name,
      synced_at: new Date().toISOString(),
      machine_id: machine_id || client.active_device_id,
      snapshot: snapshot,
    };

    fs.writeFileSync(cloudFilePath, JSON.stringify(cloudData, null, 2), 'utf-8');

    // Update telemetri di licenses.json
    if (snapshot.products && Array.isArray(snapshot.products)) {
      client.total_products = snapshot.products.length;
    }
    if (snapshot.transactions && Array.isArray(snapshot.transactions)) {
      client.total_transactions = snapshot.transactions.length;
    }
    client.last_cloud_backup_at = cloudData.synced_at;
    saveLicenses(licenses);

    console.log(`[CLOUD SYNC] Data toko ${client.store_name} (${cleanEmail}) berhasil di-push ke server. Total: ${client.total_products} produk, ${client.total_transactions} transaksi.`);

    res.json({
      success: true,
      message: 'Data toko berhasil dicadangkan dan disinkronkan ke Cloud Server!',
      synced_at: cloudData.synced_at,
    });
  } catch (err) {
    console.error('Error saat menyimpan cloud backup:', err);
    res.status(500).json({ success: false, message: 'Gagal menyimpan snapshot ke server: ' + err.message });
  }
});

// B. PULL: Ambil Snapshot Cloud untuk Di-restore di PC (Otomatis saat Login di PC Baru)
app.post('/api/cloud-sync/pull', (req, res) => {
  const { email } = req.body;
  const cleanEmail = email?.trim().toLowerCase();

  if (!cleanEmail) {
    return res.status(400).json({ success: false, message: 'Email wajib disertakan.' });
  }

  const licenses = getLicenses();
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);
  if (!client) {
    return res.status(404).json({ success: false, message: 'Akun tidak terdaftar di server.' });
  }

  const cloudFilePath = path.join(CLOUD_DIR, `${sanitizeCloudEmail(cleanEmail)}.json`);
  if (!fs.existsSync(cloudFilePath)) {
    return res.json({
      success: true,
      has_cloud_data: false,
      message: 'Belum ada data cadangan cloud untuk akun ini. Mulai dengan database awal.',
    });
  }

  try {
    const raw = fs.readFileSync(cloudFilePath, 'utf-8');
    const cloudData = JSON.parse(raw);

    console.log(`[CLOUD SYNC] Data toko ${client.store_name} (${cleanEmail}) berhasil di-pull ke PC kasir.`);

    res.json({
      success: true,
      has_cloud_data: true,
      synced_at: cloudData.synced_at,
      snapshot: cloudData.snapshot,
      message: 'Data cadangan cloud berhasil diambil.',
    });
  } catch (err) {
    console.error('Error saat membaca cloud backup:', err);
    res.status(500).json({ success: false, message: 'Gagal membaca backup cloud: ' + err.message });
  }
});

// C. STATUS CLOUD & DOWNLOAD BACKUP (Admin Vendor)
app.get('/api/cloud-sync/status/:email', (req, res) => {
  const cleanEmail = req.params.email?.trim().toLowerCase();
  const cloudFilePath = path.join(CLOUD_DIR, `${sanitizeCloudEmail(cleanEmail)}.json`);

  if (!fs.existsSync(cloudFilePath)) {
    return res.json({ has_backup: false });
  }

  try {
    const stats = fs.statSync(cloudFilePath);
    const raw = fs.readFileSync(cloudFilePath, 'utf-8');
    const data = JSON.parse(raw);
    res.json({
      has_backup: true,
      synced_at: data.synced_at,
      size_kb: (stats.size / 1024).toFixed(1),
      product_count: data.snapshot?.products?.length || 0,
      transaction_count: data.snapshot?.transactions?.length || 0,
    });
  } catch {
    res.json({ has_backup: false });
  }
});

app.get('/api/cloud-sync/download/:email', (req, res) => {
  const cleanEmail = req.params.email?.trim().toLowerCase();
  const cloudFilePath = path.join(CLOUD_DIR, `${sanitizeCloudEmail(cleanEmail)}.json`);

  if (!fs.existsSync(cloudFilePath)) {
    return res.status(404).send('File backup tidak ditemukan.');
  }

  res.download(cloudFilePath, `backup_${sanitizeCloudEmail(cleanEmail)}.json`);
});

// ==============================================================================
// 4. ENDPOINT ADMIN VENDOR (KONTROL PENUH & TELEMETRI)
// ==============================================================================

// A. Daftar semua klien
app.get('/api/admin/clients', (req, res) => {
  res.json(getLicenses());
});

// B. Daftarkan akun pembeli baru dengan pilihan paket
app.post('/api/admin/clients', (req, res) => {
  const { store_name, owner_name, email, phone, plan } = req.body;

  if (!store_name || !email) {
    return res.status(400).json({ success: false, message: 'Nama toko dan email Gmail wajib diisi.' });
  }

  const licenses = getLicenses();
  const cleanEmail = email.trim().toLowerCase();

  if (licenses.some((l) => l.registered_email.toLowerCase() === cleanEmail)) {
    return res.status(400).json({ success: false, message: 'Email Gmail ini sudah terdaftar sebelumnya.' });
  }

  const selectedPlan = plan || 'MONTHLY';
  const expiresAt = calculateExpiration(selectedPlan);

  const newClient = {
    id: `LIC-${(licenses.length + 1).toString().padStart(3, '0')}`,
    store_name: store_name.trim(),
    owner_name: owner_name?.trim() || 'Pemilik Toko',
    registered_email: cleanEmail,
    registered_phone: normalizePhone(phone || '080000000000'),
    license_key: `KASIR-GMAIL-${Math.random().toString(36).substring(2, 10).toUpperCase()}`,
    plan: selectedPlan,
    plan_name: getPlanName(selectedPlan),
    expires_at: expiresAt,
    status: 'ACTIVE',
    active_device_id: null,
    active_hostname: null,
    total_products: 0,
    total_transactions: 0,
    created_at: new Date().toISOString(),
  };

  licenses.push(newClient);
  saveLicenses(licenses);

  res.json({ success: true, message: 'Akun pembeli baru berhasil didaftarkan!', client: newClient });
});

// C. Perpanjang Masa Aktif Paket
app.post('/api/admin/extend-plan', (req, res) => {
  const { email, plan } = req.body;
  const cleanEmail = email?.trim().toLowerCase();
  const licenses = getLicenses();
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);

  if (!client) {
    return res.status(404).json({ success: false, message: 'Akun klien tidak ditemukan.' });
  }

  const selectedPlan = plan || client.plan || 'MONTHLY';
  client.plan = selectedPlan;
  client.plan_name = getPlanName(selectedPlan);

  // Jika sudah expired atau lifetime, hitung dari hari ini, jika masih aktif tambah durasinya
  const currentExpiry = new Date(client.expires_at || Date.now()).getTime();
  const baseTime = currentExpiry > Date.now() ? currentExpiry : Date.now();

  let addedMs = 30 * 24 * 60 * 60 * 1000;
  if (selectedPlan === 'DAILY') addedMs = 1 * 24 * 60 * 60 * 1000;
  else if (selectedPlan === 'WEEKLY') addedMs = 7 * 24 * 60 * 60 * 1000;
  else if (selectedPlan === 'MONTHLY') addedMs = 30 * 24 * 60 * 60 * 1000;
  else if (selectedPlan === 'ANNUAL') addedMs = 365 * 24 * 60 * 60 * 1000;
  else if (selectedPlan === 'LIFETIME') addedMs = 75 * 365 * 24 * 60 * 60 * 1000;

  client.expires_at = new Date(baseTime + addedMs).toISOString();
  client.status = 'ACTIVE';
  saveLicenses(licenses);

  res.json({
    success: true,
    message: `Masa aktif akun ${cleanEmail} berhasil diperpanjang ke paket ${client.plan_name} hingga ${new Date(client.expires_at).toLocaleDateString('id-ID')}.`,
    client,
  });
});

// D. Kunci / Nonaktifkan Akun (Kill-Switch)
app.post('/api/admin/toggle-status', (req, res) => {
  const { email } = req.body;
  const cleanEmail = email?.trim().toLowerCase();
  const licenses = getLicenses();
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);

  if (!client) {
    return res.status(404).json({ success: false, message: 'Akun klien tidak ditemukan.' });
  }

  client.status = client.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE';
  saveLicenses(licenses);

  res.json({
    success: true,
    message: `Status akun ${cleanEmail} diubah menjadi ${client.status}.`,
    status: client.status,
  });
});

// E. Reset Perangkat (Izinkan Pindah PC)
app.post('/api/admin/reset-device', (req, res) => {
  const { email } = req.body;
  const cleanEmail = email?.trim().toLowerCase();
  const licenses = getLicenses();
  const client = licenses.find((l) => l.registered_email.toLowerCase() === cleanEmail);

  if (!client) {
    return res.status(404).json({ success: false, message: 'Data klien tidak ditemukan.' });
  }

  const oldDevice = client.active_hostname || client.active_device_id || 'tidak ada';
  client.active_device_id = null;
  client.active_hostname = null;
  saveLicenses(licenses);

  res.json({
    success: true,
    message: `Penguncian perangkat ${oldDevice} berhasil di-reset. Akun dapat login di PC baru sekarang.`,
  });
});

// F. Hapus Akun Klien
app.post('/api/admin/delete-client', (req, res) => {
  const { email } = req.body;
  const cleanEmail = email?.trim().toLowerCase();
  let licenses = getLicenses();
  const beforeCount = licenses.length;
  licenses = licenses.filter((l) => l.registered_email.toLowerCase() !== cleanEmail);

  if (licenses.length === beforeCount) {
    return res.status(404).json({ success: false, message: 'Data klien tidak ditemukan.' });
  }

  saveLicenses(licenses);
  res.json({ success: true, message: `Akun ${cleanEmail} berhasil dihapus dari sistem.` });
});

// ==============================================================================
// 5. DASHBOARD WEB ADMIN (Buka di Browser: http://localhost:4000)
// ==============================================================================
app.get('/', (req, res) => {
  const clients = getLicenses();
  const now = Date.now();

  // Helper online status: online jika ada heartbeat dalam 5 menit terakhir
  const isClientOnline = (c) => {
    if (!c.last_heartbeat_at) return false;
    const diff = now - new Date(c.last_heartbeat_at).getTime();
    return diff < 5 * 60 * 1000;
  };

  const onlineCount = clients.filter(isClientOnline).length;
  const activeDeviceCount = clients.filter((c) => c.active_device_id).length;

  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <title>Dashboard Server Lisensi & Telemetri Kasir POS</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-slate-950 text-slate-100 min-h-screen p-6 font-sans">
  <div class="max-w-6xl mx-auto space-y-6">
    <!-- Header -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl">
      <div>
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center font-bold text-white text-lg shadow-lg shadow-blue-500/20">
            K
          </div>
          <div>
            <h1 class="text-xl font-bold text-white">Server Lisensi & Telemetri Kasir</h1>
            <p class="text-xs text-slate-400">Kontrol Akun Gmail, Paket Langganan & Pemantauan Toko Realtime</p>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          ${onlineCount} Toko Online Saat Ini
        </span>
      </div>
    </div>

    <!-- Quick Stats Cards -->
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <div class="bg-slate-900 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
        <div>
          <span class="text-xs text-slate-400">Total Akun Terdaftar</span>
          <div class="text-2xl font-bold text-white mt-1">${clients.length}</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-blue-500/10 text-blue-400 flex items-center justify-center font-bold">🏪</div>
      </div>
      <div class="bg-slate-900 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
        <div>
          <span class="text-xs text-slate-400">Perangkat PC Terkunci</span>
          <div class="text-2xl font-bold text-indigo-400 mt-1">${activeDeviceCount} PC</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-indigo-500/10 text-indigo-400 flex items-center justify-center font-bold">💻</div>
      </div>
      <div class="bg-slate-900 p-4 rounded-xl border border-slate-800 flex items-center justify-between">
        <div>
          <span class="text-xs text-slate-400">Toko Sedang Aktif Jualan</span>
          <div class="text-2xl font-bold text-emerald-400 mt-1">${onlineCount} Toko</div>
        </div>
        <div class="w-10 h-10 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center font-bold">🟢</div>
      </div>
    </div>

    <!-- Form Tambah Akun Pembeli Baru -->
    <div class="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl space-y-4">
      <h2 class="text-sm font-bold text-white flex items-center gap-2">
        <span>➕ Daftarkan Akun Gmail Pembeli Baru</span>
      </h2>
      <form id="addClientForm" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
        <div>
          <label class="block text-slate-300 font-semibold mb-1">Nama Toko *</label>
          <input type="text" id="store_name" required placeholder="Contoh: Toko Barokah" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-blue-500">
        </div>
        <div>
          <label class="block text-slate-300 font-semibold mb-1">Nama Pemilik</label>
          <input type="text" id="owner_name" placeholder="Contoh: Pak Budi" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-blue-500">
        </div>
        <div>
          <label class="block text-slate-300 font-semibold mb-1">Email Gmail *</label>
          <input type="email" id="email" required placeholder="budi@gmail.com" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-blue-500">
        </div>
        <div>
          <label class="block text-slate-300 font-semibold mb-1">Pilihan Paket Langganan *</label>
          <select id="plan" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-blue-500">
            <option value="DAILY">📅 Harian (1 Hari / 24 Jam)</option>
            <option value="WEEKLY">📆 Mingguan (7 Hari)</option>
            <option value="MONTHLY" selected>🗓️ Bulanan (30 Hari)</option>
            <option value="ANNUAL">🏆 Tahunan (365 Hari)</option>
            <option value="LIFETIME">💎 Lifetime (Permanen)</option>
          </select>
        </div>
        <div>
          <label class="block text-slate-300 font-semibold mb-1">No. WhatsApp</label>
          <input type="text" id="phone" placeholder="081234567890" class="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white focus:outline-none focus:border-blue-500">
        </div>
        <div class="sm:col-span-2 lg:col-span-5 flex justify-end pt-1">
          <button type="submit" class="bg-blue-600 hover:bg-blue-500 text-white font-bold px-6 py-2.5 rounded-xl shadow-lg transition-all cursor-pointer">
            Daftarkan Akun
          </button>
        </div>
      </form>
    </div>

    <!-- Tabel Daftar Pembeli & Telemetri -->
    <div class="bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-xl space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-bold text-white">📋 Daftar Akun Terdaftar & Live Telemetri (${clients.length})</h2>
        <span class="text-xs text-slate-400">Aturan: 1 Akun hanya diizinkan di 1 PC aktif</span>
      </div>

      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs text-slate-300">
          <thead class="bg-slate-950 text-slate-400 border-b border-slate-800">
            <tr>
              <th class="p-3">Toko & Akun Gmail</th>
              <th class="p-3">Paket & Masa Berlaku</th>
              <th class="p-3">Status Live</th>
              <th class="p-3">Perangkat PC Terkunci</th>
              <th class="p-3 text-center">Telemetri Toko</th>
              <th class="p-3 text-right">Aksi Vendor</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            ${clients.map((c) => {
              const online = isClientOnline(c);
              const plan = c.plan || 'LIFETIME';
              const planBadgeClass =
                plan === 'DAILY' ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' :
                plan === 'WEEKLY' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' :
                plan === 'MONTHLY' ? 'bg-blue-500/20 text-blue-300 border-blue-500/30' :
                plan === 'ANNUAL' ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' :
                'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';

              const expiryFormatted = c.expires_at ? new Date(c.expires_at).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Selamanya';

              return `
              <tr class="hover:bg-slate-800/60 transition-colors">
                <td class="p-3">
                  <div class="font-bold text-white">${c.store_name}</div>
                  <div class="font-mono text-[11px] text-blue-400">${c.registered_email}</div>
                  <div class="text-[10px] text-slate-500">${c.owner_name} • ${c.registered_phone || '-'}</div>
                </td>
                <td class="p-3">
                  <span class="inline-block px-2 py-0.5 rounded border text-[10px] font-bold ${planBadgeClass}">
                    ${c.plan_name || getPlanName(plan)}
                  </span>
                  <div class="text-[11px] text-slate-400 mt-1">Exp: <span class="font-mono text-slate-300">${expiryFormatted}</span></div>
                </td>
                <td class="p-3">
                  <div class="flex items-center gap-1.5">
                    <span class="w-2 h-2 rounded-full ${online ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}"></span>
                    <span class="text-[11px] font-semibold ${online ? 'text-emerald-400' : 'text-slate-500'}">
                      ${online ? 'Online' : 'Offline'}
                    </span>
                  </div>
                  <div class="text-[10px] text-slate-500 mt-0.5">
                    ${c.last_heartbeat_at ? new Date(c.last_heartbeat_at).toLocaleTimeString('id-ID') : 'Belum pernah buka'}
                  </div>
                </td>
                <td class="p-3">
                  ${c.active_device_id ? `
                    <div class="font-mono text-[11px] text-white font-bold">${c.active_hostname || 'PC Kasir'}</div>
                    <div class="font-mono text-[10px] text-slate-500 truncate max-w-[140px]" title="${c.active_device_id}">${c.active_device_id}</div>
                  ` : `
                    <span class="text-slate-500 italic text-[11px]">Belum terikat PC</span>
                  `}
                </td>
                <td class="p-3 text-center">
                  <div class="text-[11px] font-bold text-slate-200">${c.total_products || 0} Produk</div>
                  <div class="text-[10px] text-slate-400">${c.total_transactions || 0} Transaksi</div>
                  ${c.last_cloud_backup_at ? `
                    <div class="mt-1">
                      <a href="/api/cloud-sync/download/${encodeURIComponent(c.registered_email)}" class="inline-flex items-center gap-1 text-[9px] text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/30 hover:bg-emerald-500/20 font-mono" title="Unduh Cadangan Cloud">
                        ☁️ Backup Cloud OK
                      </a>
                    </div>
                  ` : `
                    <div class="text-[9px] text-slate-600 italic mt-0.5">Belum sync</div>
                  `}
                </td>
                <td class="p-3 text-right">
                  <div class="flex items-center justify-end gap-1.5 flex-wrap">
                    <button onclick="extendPlan('${c.registered_email}')" class="px-2 py-1 bg-blue-600/20 hover:bg-blue-600/30 text-blue-300 border border-blue-500/30 rounded-lg text-[10px] font-bold" title="Perpanjang Masa Aktif">
                      + Perpanjang
                    </button>
                    <button onclick="toggleStatus('${c.registered_email}')" class="px-2 py-1 ${c.status === 'ACTIVE' ? 'bg-amber-600/20 hover:bg-amber-600/30 text-amber-300 border-amber-500/30' : 'bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border-emerald-500/30'} border rounded-lg text-[10px] font-bold" title="Kunci / Buka Akses">
                      ${c.status === 'ACTIVE' ? 'Kunci' : 'Aktifkan'}
                    </button>
                    ${c.active_device_id ? `
                      <button onclick="resetDevice('${c.registered_email}')" class="px-2 py-1 bg-purple-600/20 hover:bg-purple-600/30 text-purple-300 border border-purple-500/30 rounded-lg text-[10px] font-bold" title="Reset PC (Izinkan Pindah PC)">
                        Reset PC
                      </button>
                    ` : ''}
                    <button onclick="deleteClient('${c.registered_email}', '${c.store_name}')" class="px-2 py-1 bg-red-600/20 hover:bg-red-600/30 text-red-300 border border-red-500/30 rounded-lg text-[10px] font-bold" title="Hapus Akun">
                      Hapus
                    </button>
                  </div>
                </td>
              </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    document.getElementById('addClientForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        store_name: document.getElementById('store_name').value,
        owner_name: document.getElementById('owner_name').value,
        email: document.getElementById('email').value,
        plan: document.getElementById('plan').value,
        phone: document.getElementById('phone').value,
      };
      const res = await fetch('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        alert('Sukses mendaftarkan toko!');
        window.location.reload();
      } else {
        alert(data.message);
      }
    });

    async function extendPlan(email) {
      const plan = prompt('Pilih paket perpanjangan:\\nDAILY = Harian (1 Hari)\\nWEEKLY = Mingguan (7 Hari)\\nMONTHLY = Bulanan (30 Hari)\\nANNUAL = Tahunan (365 Hari)\\nLIFETIME = Lifetime (Permanen)', 'MONTHLY');
      if (!plan) return;
      const res = await fetch('/api/admin/extend-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, plan: plan.toUpperCase() })
      });
      const data = await res.json();
      alert(data.message);
      window.location.reload();
    }

    async function toggleStatus(email) {
      const res = await fetch('/api/admin/toggle-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      alert(data.message);
      window.location.reload();
    }

    async function resetDevice(email) {
      if (!confirm('Lepas penguncian PC untuk akun ' + email + '? Pembeli akan bisa login di PC baru.')) return;
      const res = await fetch('/api/admin/reset-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      alert(data.message);
      window.location.reload();
    }

    async function deleteClient(email, storeName) {
      if (!confirm('Apakah Anda yakin ingin menghapus data toko "' + storeName + '" (' + email + ')?')) return;
      const res = await fetch('/api/admin/delete-client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const data = await res.json();
      alert(data.message);
      window.location.reload();
    }
  </script>
</body>
</html>
  `;
  res.send(html);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n[SERVER LISENSI KASIR] Berjalan di port ${PORT}`);
  console.log(`Dashboard Web Admin : http://localhost:${PORT}`);
  console.log(`Login Gmail Endpoint: http://localhost:${PORT}/api/license/login-gmail\n`);
});

