'use strict';

function goodMorning(groupName = 'teman-teman') {
  return [
    '╭━━━〔 🌅 𝐆𝐎𝐎𝐃 𝐌𝐎𝐑𝐍𝐈𝐍𝐆 〕━━━╮',
    '│',
    `│ ☀️ Selamat pagi, ${groupName}!`,
    '│ Semoga hari ini membawa energi baru,',
    '│ pikiran yang jernih, dan kabar baik.',
    '│',
    '│ 💧 Jangan lupa minum air dan sarapan.',
    '│ 🌱 Mulai hari dengan langkah kecil,',
    '│ lalu jalani semuanya dengan percaya diri.',
    '│',
    '│ ✨ Hari baru, kesempatan baru.',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '        𝐗𝐄𝐑𝐘𝐔𝐔-𝐌𝐃 • 𝐀𝐔𝐓𝐎 𝐆𝐑𝐄𝐄𝐓𝐈𝐍𝐆'
  ].join('\n');
}

function goodNight(groupName = 'teman-teman') {
  return [
    '╭━━━〔 🌙 𝐆𝐎𝐎𝐃 𝐍𝐈𝐆𝐇𝐓 〕━━━╮',
    '│',
    `│ 🌌 Selamat malam, ${groupName}.`,
    '│ Terima kasih untuk cerita dan tawa',
    '│ yang menemani hari ini.',
    '│',
    '│ 💤 Istirahatkan tubuh dan tenangkan hati.',
    '│ 🌠 Semoga tidur nyenyak, mimpi indah,',
    '│ dan esok bangun dengan semangat baru.',
    '│',
    '│ ✨ Lepaskan lelah, sambut hari esok.',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '        𝐗𝐄𝐑𝐘𝐔𝐔-𝐌𝐃 • 𝐀𝐔𝐓𝐎 𝐆𝐑𝐄𝐄𝐓𝐈𝐍𝐆'
  ].join('\n');
}

function groupClosed(groupName = 'grup ini', time = '') {
  return [
    '╭━━━〔 🌙 𝐆𝐑𝐔𝐏 𝐂𝐋𝐎𝐒𝐄𝐃 〕━━━╮',
    '│',
    `│ 🔒 ${groupName} ditutup otomatis${time ? ` pukul ${time} WIB` : ''}.`,
    '│ Waktunya beristirahat atau menikmati',
    '│ aktivitas di luar chat sejenak.',
    '│',
    '│ 💤 Sampai jumpa saat grup dibuka lagi!',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '        𝐗𝐄𝐑𝐘𝐔𝐔-𝐌𝐃 • 𝐀𝐔𝐓𝐎 𝐌𝐎𝐃𝐄'
  ].join('\n');
}

function groupOpened(groupName = 'grup ini', time = '') {
  return [
    '╭━━━〔 ☀️ 𝐆𝐑𝐔𝐏 𝐎𝐏𝐄𝐍𝐄𝐃 〕━━━╮',
    '│',
    `│ 🔓 ${groupName} dibuka otomatis${time ? ` pukul ${time} WIB` : ''}.`,
    '│ Selamat beraktivitas dan lanjutkan obrolan',
    '│ dengan santun agar grup tetap nyaman.',
    '│',
    '│ 🌱 Semoga hari ini penuh kabar baik!',
    '╰━━━━━━━━━━━━━━━━━━━━━━━━━━━━╯',
    '        𝐗𝐄𝐑𝐘𝐔𝐔-𝐌𝐃 • 𝐀𝐔𝐓𝐎 𝐌𝐎𝐃𝐄'
  ].join('\n');
}

module.exports = { goodMorning, goodNight, groupClosed, groupOpened };
