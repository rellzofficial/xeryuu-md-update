'use strict';

/**
 * Fun-menu utilities for Xeryuu-MD.
 * All randomized texts and formatting stay in this library rather than xeryuu.js.
 */

const COMPATIBILITY_MESSAGES = [
  { min: 90, title: 'JODOH SEJATI! 💍', text: 'Chemistry kalian luar biasa. Jangan lupa tetap saling menghargai!' },
  { min: 80, title: 'SANGAT COCOK! 💖', text: 'Kalian punya banyak potensi untuk jadi pasangan serasi.' },
  { min: 70, title: 'LUMAYAN COCOK! 💗', text: 'Perlu sedikit penyesuaian lagi, tetapi peluangnya bagus.' },
  { min: 55, title: 'BISA COCOK! 💞', text: 'Kenali satu sama lain lebih dalam dan bangun komunikasi yang baik.' },
  { min: 35, title: 'BUTUH USAHA EKSTRA 💌', text: 'Perbedaan bukan akhir segalanya. Kuncinya komunikasi dan saling memahami.' },
  { min: 0, title: 'MASIH PERLU ADAPTASI 🌱', text: 'Anggap saja ini hiburan. Kecocokan asli tidak ditentukan angka random.' }
];

const PANTUNS = [
  ['Pergi ke pasar membeli ketan,', 'Pulangnya mampir membeli jamu.', 'Kalau kamu ingin punya teman,', 'Jangan lupa tersenyum selalu.'],
  ['Pagi cerah melihat pelangi,', 'Burung bernyanyi di atas dahan.', 'Jangan lelah mengejar mimpi,', 'Langkah kecil membawa perubahan.'],
  ['Jalan-jalan ke kota Medan,', 'Singgah sebentar membeli roti.', 'Kalau ingin punya banyak teman,', 'Jaga ucapan, baikkan hati.'],
  ['Beli mangga di hari Selasa,', 'Mangga dibawa bersama kelapa.', 'Jangan suka menunda-nunda,', 'Kerjakan sekarang selagi bisa.'],
  ['Bunga melati tumbuh di taman,', 'Disiram pagi agar berseri.', 'Terima kasih wahai teman,', 'Kamu membuat hari lebih berarti.'],
  ['Ke tepi danau membawa bekal,', 'Bekal disimpan dalam keranjang.', 'Kalau hidup terasa berat sekali,', 'Istirahat sebentar, lalu berjuang.'],
  ['Burung merpati terbang ke awan,', 'Hinggap sebentar di pohon jati.', 'Kalau kamu punya harapan,', 'Rawat dengan usaha sepenuh hati.'],
  ['Naik sepeda menuju kota,', 'Ban berputar melewati taman.', 'Jangan terlalu memikirkan kata-kata,', 'Yang penting tetap jadi orang baik dan nyaman.'],
  ['Beli buku bersama Rina,', 'Buku disimpan di atas meja.', 'Kalau ingin hidup bahagia,', 'Syukuri hal kecil yang ada.'],
  ['Pergi memancing membawa jala,', 'Dapat seekor ikan gurami.', 'Kalau ingin sukses di masa depan,', 'Belajar tekun setiap hari.'],
  ['Langit senja berwarna jingga,', 'Angin berembus pelan terasa.', 'Kalau hati sedang terluka,', 'Semoga esok membawa bahagia.'],
  ['Ke kebun memetik pepaya,', 'Tak lupa membawa keranjang.', 'Walau hasil belum terlihat nyata,', 'Jangan menyerah terlalu gampang.']
];

const SHELL_ANSWERS = [
  'Iya, sepertinya begitu. 🐚',
  'Belum tentu, coba pikirkan lagi. 🌊',
  'Tanda-tandanya cukup bagus! ✨',
  'Jawabannya ada di dalam hatimu. 💙',
  'Jangan sekarang, coba tanya lagi nanti. 🫧',
  'Bisa jadi, semesta sedang menyusun kejutan. 🌙',
  'Tidak. Kerang ajaib berkata begitu! 🐚',
  'Fokus dulu, keputusan ada di tanganmu. 🌟',
  'Kemungkinannya besar, tetap realistis ya. 💫',
  'Aku belum bisa memastikan. Coba lempar koin! 🪙',
  'Sinyalnya kurang jelas, ulangi pertanyaannya. 📡',
  'Iya, tapi jangan lupa pakai logika juga. 😄'
];

const TRUTHS = [
  'Siapa orang terakhir yang membuatmu tersenyum hari ini?',
  'Apa kebiasaan kecil yang ingin kamu ubah?',
  'Apa hal paling lucu yang pernah kamu alami di sekolah?',
  'Siapa teman yang paling bisa kamu percaya?',
  'Apa impian yang belum pernah kamu ceritakan ke banyak orang?',
  'Apa hal sederhana yang selalu bisa memperbaiki mood-mu?',
  'Kalau bisa mengulang satu hari, hari apa yang kamu pilih?',
  'Apa pelajaran paling berharga yang kamu dapat tahun ini?',
  'Apa hal yang kamu takutkan tetapi ingin kamu coba?',
  'Apa pujian yang masih kamu ingat sampai sekarang?'
];

const DARES = [
  'Kirim tiga emoji yang menggambarkan suasana hatimu sekarang.',
  'Buat satu pantun spontan untuk anggota grup.',
  'Tulis kalimat penyemangat untuk orang yang mengirim pesan terakhir.',
  'Ceritakan satu fakta unik tentang dirimu yang aman dibagikan.',
  'Kirim satu pesan terima kasih kepada teman di grup.',
  'Gambarkan makanan favoritmu hanya dengan lima emoji.',
  'Tulis nama film favoritmu dengan huruf kapital semua.',
  'Buat slogan lucu untuk grup ini.',
  'Sebutkan tiga hal yang membuatmu bersyukur hari ini.',
  'Ketik “AKU SIAP MENANG” sebanyak tiga kali.'
];

const WOULD_YOU_RATHER = [
  'Punya kemampuan teleportasi atau bisa membaca semua bahasa?',
  'Liburan ke gunung atau ke pantai?',
  'Bisa menghentikan waktu atau memutar waktu lima menit ke belakang?',
  'Makan gratis seumur hidup atau jalan-jalan gratis setahun?',
  'Selalu datang tepat waktu atau selalu punya ide kreatif?',
  'Tinggal di dunia game favorit atau dunia film favorit?',
  'Bisa berbicara dengan hewan atau mengerti semua bahasa manusia?',
  'Punya rumah super nyaman atau bisa keliling dunia kapan saja?',
  'Selalu jujur tanpa filter atau selalu tahu kapan orang berbohong?',
  'Bisa menguasai satu alat musik atau satu bahasa baru secara instan?'
];

const EIGHT_BALL_ANSWERS = [
  'Iya, peluangnya terlihat bagus. ✨',
  'Sepertinya iya, tetap jalani dengan bijak.',
  'Belum bisa dipastikan. Coba lagi nanti. 🌙',
  'Tanda-tandanya belum meyakinkan.',
  'Fokus pada hal yang bisa kamu kendalikan. 💡',
  'Kemungkinan besar tidak untuk saat ini.',
  'Bisa jadi, jangan lupa pertimbangkan faktanya.',
  'Gas, tapi tetap pakai logika. 😄'
];

const COMPLIMENTS = [
  'Kamu punya energi yang bikin suasana lebih nyaman. ✨',
  'Cara kamu tetap bertahan sampai sekarang patut diapresiasi. 🌱',
  'Kamu punya nilai yang tidak harus dibuktikan ke semua orang. 💙',
  'Senyummu mungkin sederhana, tapi bisa bikin hari orang lain lebih baik. 😊',
  'Kamu layak mendapat istirahat dan perlakuan baik, termasuk dari diri sendiri. 🌷',
  'Ada hal baik dari dirimu yang mungkin belum kamu sadari. 🌟'
];

const ROASTS = [
  'Loading otak masih 2%, coba refresh dulu. 🫠',
  'Kamu bukan telat, kamu cuma hidup di zona waktu sendiri. ⏰',
  'Kalau rebahan masuk olimpiade, medali emas sudah di tangan. 🥇',
  'Baterai semangatmu low, tapi baterai scroll selalu full. 📱',
  'Rencana hidup sudah rapi, eksekusinya masih di draft. 😂',
  'Kamu punya banyak potensi, cuma lagi mode hemat daya. 🔋'
];

const FACTS = [
  'Gurita memiliki tiga jantung. Dua memompa darah ke insang dan satu ke seluruh tubuh.',
  'Madu yang disimpan dengan baik dapat bertahan sangat lama karena kadar airnya rendah dan sifatnya asam.',
  'Sidik jari koala sangat mirip dengan sidik jari manusia jika dilihat sekilas.',
  'Satu hari di Venus lebih lama daripada satu tahun di Venus.',
  'Hiu telah ada jauh sebelum pohon pertama muncul di Bumi.',
  'Jantung paus biru sangat besar dan dapat berdetak sangat lambat ketika menyelam.',
  'Botani adalah ilmu yang mempelajari tumbuhan, termasuk struktur, pertumbuhan, dan klasifikasinya.',
  'Bulan menjauh dari Bumi beberapa sentimeter setiap tahun.',
  'Wombat menghasilkan kotoran berbentuk kubus, yang membantu agar tidak mudah menggelinding.',
  'Kilatan petir dapat memanaskan udara di sekitarnya hingga jauh lebih panas daripada permukaan Matahari.'
];

const TRAITS = [
  'Periang', 'Pemalu', 'Pendiam', 'Perhatian', 'Sabar', 'Kreatif', 'Penyayang', 'Ambisius',
  'Bijaksana', 'Romantis', 'Cuek tapi peduli', 'Penuh kejutan', 'Misterius', 'Optimis', 'Logis',
  'Peka terhadap sekitar', 'Suka membantu', 'Penuh ide', 'Berani mencoba', 'Setia kawan',
  'Humoris', 'Perfeksionis', 'Mudah bergaul', 'Tenang saat masalah', 'Penuh semangat'
];

const HOBBIES = [
  'Membaca buku', 'Berenang', 'Olahraga', 'Memasak', 'Menulis', 'Bermain game', 'Menonton film',
  'Travelling', 'Mendaki gunung', 'Fotografi', 'Melukis', 'Mendengarkan musik', 'Berkebun',
  'Bersepeda', 'Membuat kerajinan tangan', 'Bermain alat musik', 'Menari', 'Bermain catur',
  'Bermain puzzle', 'Belajar bahasa baru', 'Membuat konten', 'Memelihara tanaman', 'Memasak makanan baru'
];

function pickRandom(values) {
  return values[Math.floor(Math.random() * values.length)];
}

function cleanName(value, fallback = 'Tidak diketahui') {
  const result = String(value == null ? '' : value)
    .replace(/@[0-9]+/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return result || fallback;
}

function parsePairText(value) {
  const input = String(value || '').trim();
  if (!input) return null;
  const divider = input.includes('|') ? '|' : input.includes(' x ') ? ' x ' : null;
  if (!divider) return null;
  const pair = input.split(divider).map(name => cleanName(name, ''));
  if (pair.length < 2 || !pair[0] || !pair[1]) return null;
  return [pair[0], pair.slice(1).join(divider).trim()].filter(Boolean);
}

function scoreCompatibility(name1, name2, score = Math.floor(Math.random() * 100) + 1) {
  const first = cleanName(name1, 'Nama 1');
  const second = cleanName(name2, 'Nama 2');
  const safeScore = Math.max(1, Math.min(100, Math.round(Number(score) || 1)));
  const grade = COMPATIBILITY_MESSAGES.find(item => safeScore >= item.min) || COMPATIBILITY_MESSAGES[COMPATIBILITY_MESSAGES.length - 1];
  const description = safeScore >= 70
    ? (safeScore < 80 ? 'Lumayan Cocok! Perlu sedikit penyesuaian lagi.' : grade.text)
    : grade.text;

  return {
    score: safeScore,
    name1: first,
    name2: second,
    text: [
      '👩‍❤️‍👨 CEK KECOCOKAN JODOH',
      '',
      `👤 Nama 1: ${first}`,
      `👤 Nama 2: ${second}`,
      '',
      `📊 Tingkat Kecocokan: ${safeScore}%`,
      `💖 ${description}`,
      '',
      '╰┈➤ Hasil ini untuk hiburan, ya!'
    ].join('\n')
  };
}

function questionAnswer(command, text) {
  const input = String(text || '').trim();
  if (!input) return { error: `Masukkan pertanyaan terlebih dahulu. Contoh: .${command} saya bakal sukses?` };
  const answers = {
    apakah: ['Iya, kemungkinan besar.', 'Mungkin iya.', 'Bisa jadi.', 'Belum tentu.', 'Sepertinya tidak.', 'Coba lagi nanti.', 'Semesta belum memberi petunjuk.', 'Iya kali, gas! 😄'],
    bisakah: ['Bisa banget, asal konsisten!', 'Bisa, pelan-pelan saja.', 'Mungkin bisa.', 'Tergantung usaha dan situasi.', 'Bisa, tapi perlu strategi.', 'Jangan menyerah dulu!', 'Belum tentu, coba persiapkan diri.'],
    kapankah: ['Sebentar lagi.', 'Minggu depan, mungkin.', 'Saat kamu siap.', 'Ketika kesempatan datang.', 'Jangan ditunggu, mulai sekarang.', 'Butuh beberapa bulan.', 'Aku juga penasaran kapan 😅'],
    bagaimanakah: ['Pelan-pelan sambil belajar.', 'Dengan konsisten, bukan instan.', 'Mulai dari hal kecil dulu.', 'Pakai strategi, jangan cuma mengandalkan hoki.', 'Minta masukan, lalu terus evaluasi.']
  };
  const label = { apakah: 'Apakah', bisakah: 'Bisakah', kapankah: 'Kapankah', bagaimanakah: 'Bagaimanakah' }[command] || command;
  return { text: `🎲 ${label.toUpperCase()}\n\n❔ ${label} ${input}\n\n💬 Jawaban: ${pickRandom(answers[command] || answers.apakah)}` };
}

function scoreCheck(kind, name) {
  const subject = cleanName(name, 'Kamu');
  const score = Math.floor(Math.random() * 99) + 1;
  const configs = {
    cekganteng: { title: 'CEK GANTENG', high: 'Ganteng parah! 😎', mid: 'Lumayan, aura bintangnya ada.', low: 'Pesona itu lebih dari penampilan. 🫶' },
    cekcantik: { title: 'CEK CANTIK', high: 'Cantik banget! ✨', mid: 'Manis dan punya pesona sendiri.', low: 'Tetap cantik dengan jadi diri sendiri. 💖' },
    cekgay: { title: 'CEK GAY', high: 'Hasil random-nya tinggi banget 😂', mid: 'Hasilnya nanggung nih 😆', low: 'Kerang random belum menemukan jawaban 🐚' },
    ceklesbi: { title: 'CEK LESBI', high: 'Hasil random-nya tinggi banget 😂', mid: 'Hasilnya nanggung nih 😆', low: 'Kerang random belum menemukan jawaban 🐚' },
    wangy: { title: 'CEK WANGY', high: 'Wangi bunga satu taman! 🌸', mid: 'Lumayan wangi, lanjutkan! 🌼', low: 'Mungkin perlu mandi dan parfum dulu 😄' },
    rate: { title: 'RATE', high: 'Nilai tinggi, pertahankan!', mid: 'Lumayan, masih bisa ditingkatkan.', low: 'Ini cuma angka random, jangan dimasukkan hati.' },
    top: { title: 'TOP FUN SCORE', high: 'Aura juara terdeteksi! 🏆', mid: 'Masuk papan skor hiburan.', low: 'Latihan lagi, champion! 🔥' }
  };
  const config = configs[kind] || configs.rate;
  const note = score >= 75 ? config.high : score >= 45 ? config.mid : config.low;
  return `╭━━━〔 🎭 ${config.title} 〕━━━╮\n│ 👤 Nama: ${subject}\n│ 📊 Skor: ${score}/100\n│ ✨ ${note}\n╰━━━━━━━━━━━━━━━━━━╯\n_Ini fitur hiburan, bukan penilaian sungguhan._`;
}

function makePantun() {
  return `🌺 PANTUN RANDOM\n\n${pickRandom(PANTUNS).join('\n')}\n\n✦ Semoga harimu menyenangkan!`;
}

function magicShell(question) {
  const input = String(question || '').trim();
  if (!input) return '🐚 KERANG AJAIB\n\nAjukan pertanyaan dulu, ya!\nContoh: .kerangajaib apakah aku bakal sukses?';
  return `🐚 KERANG AJAIB\n\n❔ Pertanyaan:\n${input}\n\n🔮 Jawaban kerang:\n${pickRandom(SHELL_ANSWERS)}\n\n_Keputusan tetap ada di tanganmu. Ini hanya hiburan._`;
}

function truth() { return `🟢 TRUTH\n\n${pickRandom(TRUTHS)}`; }
function dare() { return `🔴 DARE\n\n${pickRandom(DARES)}`; }
function wouldYouRather() { return `⚖️ PILIH SALAH SATU\n\n${pickRandom(WOULD_YOU_RATHER)}\n\nBalas: A atau B, lalu jelaskan alasannya!`; }
function fact() { return `🧠 TAHUKAH KAMU?\n\n${pickRandom(FACTS)}`; }
function pickOption(input) {
  const options = String(input || '').split(/\s*[|,]\s*/).map(value => value.trim()).filter(Boolean);
  if (options.length < 2) return 'Contoh: .pilih nasi goreng | mie ayam | sate';
  return `🎯 PILIHAN RANDOM\n\n${options.map((value, i) => `${i + 1}. ${value}`).join('\n')}\n\n💡 Pilihan bot: *${pickRandom(options)}*`;
}
function randomTrait() { return pickRandom(TRAITS); }
function randomHobby() { return pickRandom(HOBBIES); }
function traitReport(name) {
  return `🎭 CEK SIFAT\n\n👤 Nama: ${cleanName(name, 'Kamu')}\n✨ Sifat random: ${randomTrait()}\n\n_Hanya untuk hiburan, ya!_`;
}
function hobbyReport(name) {
  return `🎨 CEK HOBI\n\n👤 Nama: ${cleanName(name, 'Kamu')}\n🎯 Hobi random: ${randomHobby()}\n\n_Hanya untuk hiburan, ya!_`;
}
function luck(name) {
  const score = Math.floor(Math.random() * 100) + 1;
  const message = score >= 80 ? 'Keberuntungan sedang berpihak kepadamu! ✨' : score >= 55 ? 'Peluangmu cukup bagus, manfaatkan dengan bijak.' : score >= 30 ? 'Tetap semangat, jangan cuma mengandalkan hoki.' : 'Santai, angka random ini bukan ramalan sungguhan.';
  return `🍀 RAMALAN KEBERUNTUNGAN\n\n👤 Nama: ${cleanName(name, 'Kamu')}\n📊 Skor hoki: ${score}/100\n💬 ${message}`;
}

function coinFlip() {
  const result = Math.random() < 0.5 ? 'ANGKA' : 'GAMBAR';
  return `🪙 LEMPAR KOIN\n\nHasil: ${result}\n\n_Ini hasil acak untuk hiburan._`;
}

function eightBall(question) {
  const input = String(question || '').trim();
  if (!input) return '🎱 MAGIC 8-BALL\n\nMasukkan pertanyaan, contoh: .8ball apakah aku bakal sukses?';
  return `🎱 MAGIC 8-BALL\n\n❔ ${input}\n\n🔮 ${pickRandom(EIGHT_BALL_ANSWERS)}\n\n_Hanya hiburan, keputusan tetap milikmu._`;
}

function compliment(name) {
  return `💌 PESAN BAIK UNTUK ${cleanName(name, 'KAMU').toUpperCase()}\n\n${pickRandom(COMPLIMENTS)}`;
}

function roast(name) {
  return `🔥 ROAST RINGAN UNTUK ${cleanName(name, 'KAMU').toUpperCase()}\n\n${pickRandom(ROASTS)}\n\n_Cuma bercanda, jangan dimasukin hati._`;
}

module.exports = {
  cleanName,
  parsePairText,
  scoreCompatibility,
  questionAnswer,
  scoreCheck,
  makePantun,
  magicShell,
  truth,
  dare,
  wouldYouRather,
  fact,
  pickOption,
  randomTrait,
  randomHobby,
  traitReport,
  hobbyReport,
  luck,
  coinFlip,
  eightBall,
  compliment,
  roast,
  pickRandom
};
