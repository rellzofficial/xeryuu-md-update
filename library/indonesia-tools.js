'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PLATE_REGIONS = [
  ['BL', 'Provinsi Aceh'], ['BB', 'Sumatera Utara bagian barat'], ['BK', 'Sumatera Utara bagian timur'],
  ['BA', 'Provinsi Sumatera Barat'], ['BM', 'Provinsi Riau'], ['BP', 'Provinsi Kepulauan Riau'],
  ['BG', 'Provinsi Sumatera Selatan'], ['BN', 'Provinsi Kepulauan Bangka Belitung'],
  ['BE', 'Provinsi Lampung'], ['BD', 'Provinsi Bengkulu'], ['BH', 'Provinsi Jambi'],
  ['A', 'Banten: Serang, Cilegon, Pandeglang, Lebak dan sekitarnya'],
  ['B', 'DKI Jakarta, Tangerang, Depok dan Bekasi'],
  ['D', 'Bandung, Cimahi dan Bandung Barat'], ['E', 'Cirebon, Indramayu, Majalengka dan Kuningan'],
  ['F', 'Bogor, Sukabumi dan Cianjur'], ['T', 'Purwakarta, Karawang dan Subang'],
  ['Z', 'Garut, Tasikmalaya, Ciamis, Banjar dan Pangandaran'],
  ['G', 'Pekalongan, Tegal, Brebes, Batang dan Pemalang'], ['H', 'Semarang, Salatiga, Kendal dan Demak'],
  ['K', 'Pati, Kudus, Jepara, Rembang, Blora dan Grobogan'], ['R', 'Banyumas, Cilacap, Purbalingga dan Banjarnegara'],
  ['AA', 'Magelang, Purworejo, Kebumen, Temanggung dan Wonosobo'],
  ['AB', 'Daerah Istimewa Yogyakarta'], ['AD', 'Surakarta dan wilayah sekitarnya'],
  ['AE', 'Madiun, Ngawi, Magetan, Ponorogo dan Pacitan'],
  ['AG', 'Kediri, Blitar, Tulungagung, Nganjuk dan Trenggalek'],
  ['L', 'Kota Surabaya'], ['M', 'Pulau Madura'],
  ['N', 'Malang, Batu, Pasuruan, Probolinggo dan Lumajang'],
  ['P', 'Banyuwangi, Jember, Bondowoso dan Situbondo'], ['S', 'Bojonegoro, Tuban, Lamongan dan Jombang'],
  ['W', 'Sidoarjo dan Gresik'], ['DK', 'Provinsi Bali'], ['DR', 'Pulau Lombok, Nusa Tenggara Barat'],
  ['EA', 'Sumbawa, Dompu dan Bima, Nusa Tenggara Barat'], ['DH', 'Pulau Timor bagian Nusa Tenggara Timur'],
  ['EB', 'Flores dan pulau sekitar, Nusa Tenggara Timur'], ['ED', 'Pulau Sumba, Nusa Tenggara Timur'],
  ['DT', 'Sulawesi Tenggara'], ['DN', 'Sulawesi Tengah'], ['DD', 'Sulawesi Selatan bagian selatan'],
  ['DP', 'Sulawesi Selatan bagian utara'], ['DB', 'Sulawesi Utara daratan'], ['DM', 'Gorontalo'],
  ['DC', 'Sulawesi Barat'], ['DE', 'Maluku'], ['DG', 'Maluku Utara'], ['PA', 'Papua'], ['PB', 'Papua Barat']
];
const PLATE_REGION_MAP = new Map(PLATE_REGIONS);

function normalizePlate(input) {
  return String(input || '').toUpperCase().replace(/[.\-]/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseIndonesianPlate(input) {
  const normalized = normalizePlate(input);
  const match = normalized.match(/^([A-Z]{1,2})\s*(\d{1,4})\s*([A-Z]{0,3})$/);
  if (!match) {
    return {
      validFormat: false,
      normalized,
      message: 'Format tidak dikenali. Contoh format umum: B 1234 XYZ atau AB 123 C.'
    };
  }
  const prefix = match[1];
  const region = PLATE_REGION_MAP.get(prefix) || '';
  return {
    validFormat: true,
    normalized: `${prefix} ${match[2]}${match[3] ? ` ${match[3]}` : ''}`,
    prefix,
    number: match[2],
    suffix: match[3],
    region,
    knownPrefix: Boolean(region),
    message: region
      ? `Format umum terbaca. Kode awal ${prefix} umumnya terkait ${region}.`
      : `Format umum terbaca, tetapi kode awal ${prefix} tidak ada dalam cakupan data lokal fitur ini.`
  };
}

const COMMON_IDX_TICKERS = new Set((
  'AALI ABBA ABDA ABMM ACES ACRO ADHI ADMF ADMR ADRO AGII AGRO AKRA AMAG AMAR AMFG AMIN AMMN AMMS AMRT ANTM APEX APIC ARCI AREA ARNA ARTO ASGR ASII ASLC ASRI ASSA AUTO AVIA AYAM BABY BACA BANK BBCA BBHI BBKP BBLD BBNI BBRI BBTN BBYB BCAP BCIC BCIP BDMN BEKS BELL BFIN BGTG BHAT BHIT BIKA BIMA BINA BINO BIPI BIRD BISI BJBR BJTM BKSL BLTA BLTZ BMAS BMRI BNBA BNGA BNII BNLI BOBA BOGA BOLT BRAM BRIS BRMS BRNA BRPT BSDE BSSR BTEK BTPS BUDI BUKA BULL CARS CBMF CCSI CEKA CENT CFIN CHIP CITA CLPI CMNP CMRY CNMA COAL CPIN CPRO CRAB CSAP CTRA CUAN DEFI DEWA DGIK DIGI DKFT DMAS DMND DOID DRMA DSSA DUTI DVLA EAST ELSA ELTY EMTK ENRG ENZO ERAA ESIP ESSA ESTI ETWA EXCL FAST FILM FIRE FISH FITT FREN FUTR GDST GDYR GEMA GGRM GGRP GIAA GJTL GLOB GMFI GMTD GOLD GOTO GPRA GREN GRPM GULA HADE HDFA HDIT HEAL HERO HEXA HILL HMSP HOME HOPE HRTA HRUM ICBP ICON IDEA IFII IGAR IIKP IMAS IMPC INAF INAI INCO INDF INDY INKP INPP INPS INRU INTP IPCC IPCM IPOL IPPE IPTV IRRA ISAT ISSP ITIC ITMG JARR JECC JGLE JIHD JKON JPFA JRPT JSMR JTPE KARW KBLI KBLM KDSI KINO KIOS KKGI KLBF KMDS KMTR KOBX KPIG KRAS KREN LCKM LION LIVE LMAS LMPI LMSH LPCK LPKR LPPF LPPS LSIP LTLS MABA MAIN MAPA MAPI MARK MASA MAYA MBAP MBMA MBSS MBTO MCAS MCOL MDIA MDKA MDKI MDLN MDRN MEDC MEGA MERK META MFMI MGNA MICE MIDI MIKA MINA MIRA MITI MKPI MLBI MLIA MLPL MLPT MMLP MNCN MPPA MPRO MREI MTDL MTEL MTLA MTSM MYOH MYOR MYRX MYTX NANO NASA NATO NCKL NELY NIKL NIPS NIRO NICE NKLA NOBU NRCA NSSS NTBK NUSA OBMD OCAP OKAS OMRE OPMS PADI PANI PANR PANS PBID PBRX PDES PEGE PGAS PGEO PGLI PICO PJAA PLIN PMMP PNBN PNIN PNLF PNSE POLI POLL POLU PORT POWR PRAS PRDA PRIM PSDN PSKT PTPP PTRO PUDP PWON PZZA RAJA RALS RANC RBMS RDTX REAL RELI RICY RIGS RISE RMKE RMKO ROTI RUIS SAFE SAME SAMF SAPX SCMA SCCO SCMA SCNP SEMA SGER SGRO SHID SILO SIMP SIPD SKBM SKLT SMAR SMBR SMCB SMDM SMDR SMGR SMKL SMKM SMMA SMMT SMRA SMSM SNLK SOCI SONA SPMA SRAJ SRTG SSIA SSMS SSTM STAR STTP SUGI SULI SUPR SURE TAMA TAPG TAXI TBIG TBLA TBMS TCID TCPI TDPM TFAS TGKA TIFA TINS TKIM TLKM TMAS TMPO TNCA TOBA TOPS TOTL TOTO TOWR TPIA TPMA TRIM TRIN TRIS TRST TRUE TSPC TURI UANG UCID ULTJ UNIQ UNIT UNTR UNVR UNSP UNTD VICI VINS VOKS VRNA WAPO WEGE WEHA WGSH WICO WIKA WINS WIFI WINR WMPP WOOD WSKT WTON YELO ZATA ZBRA ZINC ZONE'.split(/\s+/)
));

function normalizeStockSymbol(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) throw new Error('Masukkan kode saham, misalnya BBCA, AAPL, MSFT, atau IHSG.');
  if (['IHSG', 'IDX', 'IDXCOMPOSITE', '^JKSE', 'JKSE'].includes(raw)) return '^JKSE';
  const original = raw.replace(/\s+/g, '');
  if (!/^[A-Z0-9^][A-Z0-9.^=-]{0,14}$/.test(original) || /[;|`$]/.test(original)) {
    throw new Error('Kode saham tidak valid. Contoh: BBCA, BBCA.JK, AAPL, MSFT, atau IHSG.');
  }
  if (original.startsWith('^') || original.includes('=') || original.includes('.')) return original;
  // Common IDX tickers default to Yahoo's .JK notation. Other valid symbols
  // are treated as international tickers; an IDX ticker can always be explicit with .JK.
  return COMMON_IDX_TICKERS.has(original) ? `${original}.JK` : original;
}

function formatIDR(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency', currency: 'IDR', maximumFractionDigits: 2
  }).format(value);
}

function formatJakartaTime(epochSeconds) {
  const epoch = Number(epochSeconds);
  if (!Number.isFinite(epoch) || epoch <= 0) return 'Waktu pembaruan tidak diberikan sumber';
  return `${new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'medium', hour12: false
  }).format(new Date(epoch * 1000))} WIB`;
}

const STOCK_CACHE_FILE = path.join(__dirname, 'database', 'stock-quote-cache.json');
const STOCK_CACHE_TTL_MS = 90 * 1000;
const STOCK_STALE_TTL_MS = 72 * 60 * 60 * 1000;
const YAHOO_MIN_REQUEST_GAP_MS = 1500;
const stockQuoteCache = new Map();
const stockQuoteInFlight = new Map();
const yahooHostCooldownUntil = new Map();
let stockCacheLoaded = false;
let nextYahooRequestAt = 0;

function loadStockQuoteCache() {
  if (stockCacheLoaded) return;
  stockCacheLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(STOCK_CACHE_FILE, 'utf8'));
    const records = parsed?.quotes && typeof parsed.quotes === 'object' ? parsed.quotes : {};
    const now = Date.now();
    for (const [symbol, record] of Object.entries(records)) {
      const fetchedAt = Number(record?.fetchedAt || 0);
      const quote = record?.quote;
      if (!fetchedAt || now - fetchedAt > STOCK_STALE_TTL_MS || !quote || !Number.isFinite(Number(quote.price)) || Number(quote.price) <= 0) continue;
      stockQuoteCache.set(symbol, { fetchedAt, quote });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn('[SAHAM CACHE] Cache lokal tidak dapat dibaca:', error?.message || error);
  }
}

function persistStockQuoteCache() {
  try {
    const now = Date.now();
    const quotes = {};
    for (const [symbol, record] of stockQuoteCache) {
      if (record && now - Number(record.fetchedAt || 0) <= STOCK_STALE_TTL_MS) quotes[symbol] = record;
    }
    fs.mkdirSync(path.dirname(STOCK_CACHE_FILE), { recursive: true });
    const temporary = `${STOCK_CACHE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, quotes }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, STOCK_CACHE_FILE);
  } catch (error) {
    console.warn('[SAHAM CACHE] Gagal menyimpan cache kutipan:', error?.message || error);
  }
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForYahooRequestSlot() {
  const now = Date.now();
  const reservedSlot = Math.max(now, nextYahooRequestAt);
  nextYahooRequestAt = reservedSlot + YAHOO_MIN_REQUEST_GAP_MS;
  const delay = reservedSlot - now;
  if (delay > 0) await wait(delay);
}

function getRetryAfterMs(headers = {}) {
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined || raw === null || raw === '') return 3 * 60 * 1000;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30 * 60 * 1000, Math.max(30 * 1000, seconds * 1000));
  const date = Date.parse(String(raw));
  return Number.isFinite(date) ? Math.min(30 * 60 * 1000, Math.max(30 * 1000, date - Date.now())) : 3 * 60 * 1000;
}

function buildQuoteFromYahooResponse(data, symbol) {
  const body = data?.chart;
  if (body?.error) {
    const error = new Error(String(body.error.description || body.error.code || 'Sumber data saham menolak permintaan').slice(0, 180));
    error.sourceStatus = Number(body.error.code === 'Not Found' ? 404 : 0);
    throw error;
  }
  const result = body?.result?.[0];
  const meta = result?.meta;
  if (!result || !meta) throw new Error(`Tidak ada kutipan valid untuk ${symbol}.`);

  const quote = result?.indicators?.quote?.[0] || {};
  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  let latestClose = null;
  let latestTimestamp = null;
  for (let i = Math.min(timestamps.length, quote.close?.length || 0) - 1; i >= 0; i--) {
    const value = Number(quote.close[i]);
    if (Number.isFinite(value) && value > 0) {
      latestClose = value;
      latestTimestamp = timestamps[i];
      break;
    }
  }
  const metaPrice = Number(meta.regularMarketPrice);
  const price = Number.isFinite(metaPrice) && metaPrice > 0 ? metaPrice : latestClose;
  if (!Number.isFinite(price) || price <= 0) throw new Error(`Sumber data tidak memberikan harga valid untuk ${symbol}.`);

  const rawPreviousClose = Number(meta.chartPreviousClose ?? meta.previousClose);
  const previousClose = Number.isFinite(rawPreviousClose) && rawPreviousClose > 0 ? rawPreviousClose : null;
  const change = previousClose === null ? null : price - previousClose;
  const changePercent = change === null ? null : (change / previousClose) * 100;
  const reportedTime = Number(meta.regularMarketTime) || Number(latestTimestamp) || 0;
  const volumeValues = Array.isArray(quote.volume) ? quote.volume : [];
  const latestVolume = [...volumeValues].reverse().find(value => Number.isFinite(Number(value)) && Number(value) >= 0);

  return {
    symbol,
    name: String(meta.longName || meta.shortName || symbol).trim(),
    price,
    previousClose,
    change,
    changePercent,
    currency: String(meta.currency || 'IDR'),
    timestamp: reportedTime,
    updatedAt: formatJakartaTime(reportedTime),
    marketState: String(meta.marketState || 'Tidak disediakan sumber'),
    delayedByMinutes: Number.isFinite(Number(meta.exchangeDataDelayedBy)) ? Number(meta.exchangeDataDelayedBy) : null,
    volume: Number.isFinite(Number(latestVolume)) ? Number(latestVolume) : null,
    source: 'Yahoo Finance Chart API',
    note: 'Kutipan dapat tertunda sesuai kebijakan penyedia dan bukan feed transaksi langsung resmi Bursa Efek Indonesia.'
  };
}

async function fetchFreshIndonesianStockQuote(symbol) {
  const axios = require('axios');
  const hosts = ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'];
  const errors = [];

  for (const host of hosts) {
    const cooldownUntil = Number(yahooHostCooldownUntil.get(host) || 0);
    if (cooldownUntil > Date.now()) {
      errors.push({ host, status: 429, detail: `cooldown lokal sampai ${new Date(cooldownUntil).toISOString()}` });
      continue;
    }

    await waitForYahooRequestSlot();
    try {
      const endpoint = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}`;
      const response = await axios.get(endpoint, {
        params: { range: '5d', interval: '5m', includePrePost: 'false' },
        timeout: 12_000,
        maxContentLength: 3 * 1024 * 1024,
        headers: {
          'User-Agent': 'Xeryuu-MD/16.5 stock-quote client',
          Accept: 'application/json'
        },
        validateStatus: () => true
      });

      const status = Number(response?.status || 0);
      if (status === 429) {
        const cooldownMs = getRetryAfterMs(response?.headers || {});
        yahooHostCooldownUntil.set(host, Date.now() + cooldownMs);
        errors.push({ host, status, detail: `rate limit; jeda ${Math.ceil(cooldownMs / 1000)} detik` });
        console.warn(`[SAHAM] ${host} membatasi permintaan (429); host ini ditunda.`);
        continue;
      }
      if (status < 200 || status >= 300) {
        errors.push({ host, status, detail: String(response?.data?.chart?.error?.description || response?.statusText || 'respons HTTP tidak berhasil').slice(0, 140) });
        continue;
      }

      try {
        return buildQuoteFromYahooResponse(response.data, symbol);
      } catch (parseError) {
        errors.push({ host, status: Number(parseError?.sourceStatus || 0), detail: String(parseError?.message || parseError).slice(0, 140) });
      }
    } catch (error) {
      const status = Number(error?.response?.status || error?.sourceStatus || 0);
      if (status === 429) {
        const cooldownMs = getRetryAfterMs(error?.response?.headers || {});
        yahooHostCooldownUntil.set(host, Date.now() + cooldownMs);
      }
      errors.push({ host, status, detail: String(error?.message || error).slice(0, 140) });
    }
  }

  if (errors.some(item => item.status === 404 || item.status === 422)) {
    throw new Error(`Kode saham ${symbol} tidak ditemukan pada sumber data.`);
  }
  if (errors.some(item => item.status === 429)) {
    throw new Error('Sumber data saham sedang membatasi permintaan (HTTP 429). Bot sudah mencoba host cadangan dan menerapkan jeda agar tidak terus membanjiri API. Coba lagi setelah beberapa menit. Jika cache lokal tersedia, data cache akan ditampilkan dengan penanda bahwa harganya mungkin sudah lama.');
  }
  const lastError = errors[errors.length - 1];
  throw new Error(`Sumber data saham tidak dapat diakses${lastError?.status ? ` (HTTP ${lastError.status})` : ''}${lastError?.detail ? `: ${lastError.detail}` : ''}. Coba lagi nanti.`);
}

async function getIndonesianStockQuote(input) {
  const symbol = normalizeStockSymbol(input);
  loadStockQuoteCache();
  const now = Date.now();
  const cached = stockQuoteCache.get(symbol);
  const cachedAge = cached ? Math.max(0, now - Number(cached.fetchedAt || 0)) : Infinity;

  if (cached && cachedAge <= STOCK_CACHE_TTL_MS) {
    return { ...cached.quote, isStale: false, cacheFetchedAt: cached.fetchedAt, cacheAgeMs: cachedAge };
  }
  if (stockQuoteInFlight.has(symbol)) return stockQuoteInFlight.get(symbol);

  const request = (async () => {
    try {
      const quote = await fetchFreshIndonesianStockQuote(symbol);
      const fetchedAt = Date.now();
      stockQuoteCache.set(symbol, { fetchedAt, quote });
      persistStockQuoteCache();
      return { ...quote, isStale: false, cacheFetchedAt: fetchedAt, cacheAgeMs: 0 };
    } catch (error) {
      const age = cached ? Math.max(0, Date.now() - Number(cached.fetchedAt || 0)) : Infinity;
      if (cached && age <= STOCK_STALE_TTL_MS) {
        return {
          ...cached.quote,
          isStale: true,
          cacheFetchedAt: cached.fetchedAt,
          cacheAgeMs: age,
          staleReason: String(error?.message || error)
        };
      }
      throw error;
    } finally {
      stockQuoteInFlight.delete(symbol);
    }
  })();
  stockQuoteInFlight.set(symbol, request);
  return request;
}

function formatStockQuote(quote) {
  const number = value => new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(value);
  const currency = /^[A-Z]{3}$/.test(String(quote.currency || '')) ? String(quote.currency) : 'IDR';
  const money = value => {
    if (currency === 'IDR') return formatIDR(value);
    try { return new Intl.NumberFormat('id-ID', { style: 'currency', currency, maximumFractionDigits: 4 }).format(value); }
    catch { return `${number(value)} ${currency}`; }
  };
  const changeLabel = quote.change === null || quote.changePercent === null
    ? 'Tidak tersedia dari sumber'
    : `${quote.change > 0 ? '+' : ''}${money(quote.change)} (${quote.changePercent > 0 ? '+' : ''}${number(quote.changePercent)}%)`;
  const volumeLabel = quote.volume === null ? 'Tidak tersedia' : new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 }).format(quote.volume);
  const marketHeading = quote.symbol === '^JKSE' ? 'INDEKS IHSG' : currency === 'IDR' && String(quote.symbol).endsWith('.JK') ? 'SAHAM INDONESIA' : 'SAHAM INTERNASIONAL';
  return [
    `╭─═⪩ 📈 *${marketHeading}*`,
    '│',
    `│ 🏢 ${quote.name}`,
    `│ 🔎 Kode: ${quote.symbol}`,
    `│ 💵 Harga terakhir: ${money(quote.price)}`,
    `│ 📊 Perubahan: ${changeLabel}`,
    `│ 📦 Volume terakhir: ${volumeLabel}`,
    `│ 🕒 Pembaruan sumber: ${quote.updatedAt}`,
    `│ ⏱️ Keterlambatan: ${quote.delayedByMinutes === null ? 'Tidak dinyatakan sumber' : quote.delayedByMinutes === 0 ? '0 menit menurut sumber' : `${quote.delayedByMinutes} menit`}`,
    `│ 🏛️ Status pasar: ${quote.marketState}`,
    '│',
    '╰─═─═─═─═─═─═⪩',
    quote.isStale ? `⚠️ CACHE LOKAL: permintaan baru gagal; kutipan terakhir berhasil diambil ${quote.cacheFetchedAt ? new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'medium', timeStyle: 'short', hour12: false }).format(new Date(quote.cacheFetchedAt)) + ' WIB' : 'sebelumnya'}. Harga ini mungkin sudah lama dan bukan konfirmasi harga terkini.` : '',
    `Sumber: ${quote.source}`,
    quote.note
  ].filter(Boolean).join('\n');
}

function isWithinRoot(root, target) {
  const relative = path.relative(root, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function enumerateFiles(root, extensions, maxFiles = 1200) {
  const found = [];
  const skippedDirectories = new Set([
    'node_modules', '.git', '.svn', 'connection', 'sessions', 'auth_info', 'auth_state',
    'tmp', 'temp', 'logs', 'cache', 'richhtml-cache', '.next', 'dist', 'build'
  ]);
  const visit = directory => {
    if (found.length >= maxFiles) return;
    let items;
    try { items = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (_) { return; }
    for (const item of items) {
      if (found.length >= maxFiles) break;
      const fullPath = path.join(directory, item.name);
      if (item.isDirectory()) {
        if (!skippedDirectories.has(item.name) && !item.name.startsWith('.')) visit(fullPath);
      } else if (item.isFile() && extensions.has(path.extname(item.name).toLowerCase())) {
        try {
          if (fs.statSync(fullPath).size <= 8 * 1024 * 1024) found.push(fullPath);
        } catch (_) {}
      }
    }
  };
  visit(root);
  return found;
}

function runNodeCheck(filePath, timeoutMs = 20000) {
  return new Promise(resolve => {
    let output = '';
    let child;
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, detail: 'node --check melewati batas 20 detik.' });
    }, timeoutMs);
    try {
      child = spawn(process.execPath, ['--check', filePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      finish({ ok: false, detail: error.message });
      return;
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => {
        if (output.length < 5000) output += chunk.toString().slice(0, 5000 - output.length);
      });
    }
    child.once('error', error => finish({ ok: false, detail: error.message }));
    child.once('close', code => finish({ ok: code === 0, detail: output.trim() }));
  });
}

function resolveLocalRequire(fromFile, request) {
  if (!request.startsWith('.')) return true;
  const base = path.resolve(path.dirname(fromFile), request);
  const candidates = path.extname(base)
    ? [base]
    : [base, `${base}.js`, `${base}.json`, `${base}.node`, path.join(base, 'index.js'), path.join(base, 'index.json')];
  return candidates.some(candidate => {
    try { return fs.statSync(candidate).isFile(); } catch (_) { return false; }
  });
}

async function diagnoseProject(projectRoot) {
  const root = path.resolve(projectRoot || process.cwd());
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error('Folder proyek tidak ditemukan.');
  const jsFiles = enumerateFiles(root, new Set(['.js', '.cjs', '.mjs']));
  const jsonFiles = enumerateFiles(root, new Set(['.json'])).filter(file => {
    const relative = path.relative(root, file).split(path.sep);
    return !relative.includes('database') && !relative.includes('connection') && !relative.includes('sessions');
  });
  const issues = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, jsFiles.length) }, async () => {
    while (cursor < jsFiles.length) {
      const index = cursor++;
      const file = jsFiles[index];
      const result = await runNodeCheck(file);
      if (!result.ok) {
        issues.push({ file, type: 'Syntax JavaScript', detail: result.detail || 'node --check gagal.' });
        continue;
      }
      let source = '';
      try { source = fs.readFileSync(file, 'utf8'); } catch (_) { continue; }
      const requirePattern = /\brequire\s*\(\s*(['"])(\.[^'"]+)\1\s*\)/g;
      let match;
      while ((match = requirePattern.exec(source)) !== null) {
        if (!resolveLocalRequire(file, match[2])) {
          // authen.js is intentionally excluded from the user distribution and
          // all call sites load it under try/catch as optional local secrets.
          // Do not report that deliberate absence as a broken relative import.
          const optionalTarget = path.resolve(path.dirname(file), match[2]);
          if (path.basename(optionalTarget).toLowerCase() === 'authen.js' && !fs.existsSync(optionalTarget)) continue;
          issues.push({ file, type: 'Require lokal tidak ditemukan', detail: match[2] });
          if (issues.length >= 200) return;
        }
      }
    }
  });
  await Promise.all(workers);

  for (const file of jsonFiles) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      issues.push({ file, type: 'JSON tidak valid', detail: String(error.message || error).slice(0, 300) });
    }
    if (issues.length >= 200) break;
  }

  return {
    root,
    javascriptFilesChecked: jsFiles.length,
    jsonFilesChecked: jsonFiles.length,
    issueCount: issues.length,
    issues: issues.slice(0, 40),
    truncated: issues.length > 40,
    maxFilesReached: jsFiles.length >= 1200 || jsonFiles.length >= 1200
  };
}

function formatDiagnostics(result) {
  const lines = [
    '╭─═⪩ 🧪 *DIAGNOSTIK SCRIPT XERYUU*',
    '│',
    `│ 📂 Folder: ${path.basename(result.root)}`,
    `│ 📄 JavaScript: ${result.javascriptFilesChecked} file diperiksa`,
    `│ 🧾 JSON: ${result.jsonFilesChecked} file diperiksa`,
    `│ ⚠️ Temuan: ${result.issueCount}`,
    '│',
    '╰─═─═─═─═─═─═⪩'
  ];
  if (!result.issueCount) {
    lines.push('', '✅ Tidak ditemukan error sintaks, require lokal yang hilang, atau JSON statis tidak valid pada cakupan pemeriksaan ini.');
  } else {
    lines.push('', '*Rincian temuan:*');
    for (const issue of result.issues) {
      const shortPath = path.relative(result.root, issue.file) || path.basename(issue.file);
      lines.push(`• ${issue.type}: ${shortPath}`, `  ${String(issue.detail || '-').replace(/\s+/g, ' ').slice(0, 220)}`);
    }
    if (result.truncated) lines.push(`… dan ${result.issueCount - result.issues.length} temuan lainnya.`);
  }
  if (result.maxFilesReached) lines.push('', '⚠️ Batas pemindaian 1.200 file per kategori tercapai; pemeriksaan ini mungkin belum mencakup seluruh folder.');
  lines.push('', 'Catatan: ini pemeriksaan statis; tidak membuktikan semua alur runtime atau API bebas masalah.');
  return lines.join('\n').slice(0, 12000);
}

module.exports = {
  PLATE_REGION_MAP,
  normalizePlate,
  parseIndonesianPlate,
  normalizeStockSymbol,
  formatIDR,
  formatStockQuote,
  getIndonesianStockQuote,
  diagnoseProject,
  formatDiagnostics,
  resolveLocalRequire,
  enumerateFiles,
  isWithinRoot
};
