//Please don't change script credit creator
//🔰 Creator : Xnalz
//🔰 Telegram : https://t.me/XnalzNotDev
//🔰 Nomor Whatsapp : 6283116282076
//🔰 ©xnalznotdev
// JANGAN MENGUBAH CREDIT DARI SCRIPT INI, JIKA KETAHUAN MAKA AKAN DIKENAKAN SANKSI DAN KONSEKUENSI ©xnalz

const canvafy = require("canvafy")

async function welcomeBanner(avatar, name, subject, type) {

    // 🎯 beda background
    const background = type === "welcome"
        ? "https://img2.pixhost.to/images/6553/706117100_settomodders.jpg" // welcome
        : "https://img2.pixhost.to/images/6553/706117105_settomodders.jpg" // goodbye

    const banner = await new canvafy.WelcomeLeave()
        .setAvatar(avatar)
        .setBackground("image", background)
        .setTitle("‎") // invisible text
        .setDescription("‎") // invisible text
        .setBorder("#2a2e35")
        .setAvatarBorder("#2a2e35")
        .setOverlayOpacity(0.2)
        .build()

    return banner
}

async function promoteBanner() {
    return null
}

module.exports = { welcomeBanner, promoteBanner }