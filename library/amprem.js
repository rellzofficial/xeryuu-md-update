const axios = require('axios');
const crypto = require('crypto');

const ampremLocalApiKeys = (() => {
  try {
    const local = require('../authen.js') || {};
    return local.apiKeys && typeof local.apiKeys === 'object' ? local.apiKeys : {};
  } catch {
    return {};
  }
})();
function ampremSecret(envName, keyName) {
  const candidates = [
    process.env[envName],
    global.xeryuuApiKeys?.[keyName],
    ampremLocalApiKeys[keyName]
  ];
  const value = candidates.find(item => typeof item === 'string' && item.trim());
  return value ? String(value).trim() : '';
}

class AlightMotionAuth {
  ORDER_ID = "JJOOOOZYY";
  API_KEY = ampremSecret('AMPREM_FIREBASE_API_KEY', 'ampremFirebaseApiKey');
  PRODUCT_ID = "am.full.sub.annual.19q4";
  TOKEN = ampremSecret('AMPREM_PURCHASE_TOKEN', 'ampremPurchaseToken');
  SKU_TYPE = "subs";
  FIREBASE_INSTANCE_ID_TOKEN = ampremSecret('AMPREM_FIREBASE_INSTANCE_ID_TOKEN', 'ampremFirebaseInstanceIdToken');
  HEADERS = {
    "Content-Type": "application/json",
    "X-Android-Package": "com.alightcreative.motion",
    "X-Android-Cert": "ECA6BF91B8715A6F810ED0BBFC65B6CD578F52A8",
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 15; 23127PN0CC Build/BP1A.250505.005)"
  };

  generateCodeOrder() {
    return crypto.randomInt(10000, 99999).toString();
  }

  extractOobCode(fullUrl) {
    if (!fullUrl) return null;
    try {
      let cleanUrl = fullUrl.replace(/&amp;/g, '&');
      try { cleanUrl = decodeURIComponent(cleanUrl); } catch (e) {}

      try {
        const urlObj = new URL(cleanUrl);
        let oobCode = urlObj.searchParams.get('oobCode');
        if (!oobCode) {
          const nestedLink = urlObj.searchParams.get('link') || urlObj.searchParams.get('q') || urlObj.searchParams.get('url');
          if (nestedLink) {
            try {
              const innerUrlObj = new URL(nestedLink);
              oobCode = innerUrlObj.searchParams.get('oobCode');
            } catch (e) {}
          }
        }
        if (oobCode) return oobCode.replace(/[^a-zA-Z0-9_-]/g, '');
      } catch (e) {}

      const match = cleanUrl.match(/[?&]oobCode=([a-zA-Z0-9_-]+)/i) || cleanUrl.match(/oobCode=([a-zA-Z0-9_-]+)/i);
      if (match && match[1]) return match[1];
      return null;
    } catch (e) {
      return null;
    }
  }

  async sendMagicLink(email) {
    try {
      if (!this.API_KEY) throw new Error('Konfigurasi API Alight Motion belum tersedia pada settings.js/environment.');
      await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/createAuthUri?key=${this.API_KEY}`, {
        identifier: email,
        continueUri: "http://localhost"
      }, { headers: this.HEADERS });

      await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getOobConfirmationCode?key=${this.API_KEY}`, {
        requestType: 6,
        email: email,
        androidInstallApp: true,
        canHandleCodeInApp: true,
        continueUrl: "https://alightcreative.com?ui_sid=0366624874&ui_sd=0",
        iosBundleId: "com.alightcreative.motion",
        androidPackageName: "com.alightcreative.motion",
        androidMinimumVersion: "585",
        clientType: "CLIENT_TYPE_ANDROID"
      }, { headers: this.HEADERS });

      return { success: true, message: "Link berhasil dikirim." };
    } catch (error) {
      const errData = error.response?.data ? (typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data) : error.message;
      return { success: false, error: errData };
    }
  }

  async verifyAndFetchProfile(email, rawLink) {
    try {
      if (!this.API_KEY) throw new Error('Konfigurasi API Alight Motion belum tersedia pada settings.js/environment.');
      const oobCode = this.extractOobCode(rawLink);
      if (!oobCode) throw new Error("Gagal mengekstrak oobCode dari link.");

      const signinRes = await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/emailLinkSignin?key=${this.API_KEY}`, {
        email: email,
        oobCode: oobCode,
        clientType: "CLIENT_TYPE_ANDROID"
      }, { headers: this.HEADERS });

      const accountRes = await axios.post(`https://www.googleapis.com/identitytoolkit/v3/relyingparty/getAccountInfo?key=${this.API_KEY}`, {
        idToken: signinRes.data.idToken
      }, { headers: this.HEADERS });

      return { success: true, idToken: signinRes.data.idToken, user: accountRes.data.users[0] };
    } catch (error) {
      const errData = error.response?.data ? (typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data) : error.message;
      return { success: false, error: errData };
    }
  }

  async applyPremium(idToken) {
    try {
      if (!this.TOKEN || !this.FIREBASE_INSTANCE_ID_TOKEN) {
        throw new Error('Konfigurasi token Alight Motion belum tersedia pada settings.js/environment.');
      }
      const codeorder = this.generateCodeOrder();
      const url = 'https://us-central1-alight-creative.cloudfunctions.net/verifyPurchase';
      const headers = {
        "authorization": "Bearer " + idToken,
        "firebase-instance-id-token": this.FIREBASE_INSTANCE_ID_TOKEN,
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "user-agent": "okhttp/3.12.1"
      };
      const response = await axios.post(url, {
        data: {
          productId: this.PRODUCT_ID,
          token: this.TOKEN,
          skuType: this.SKU_TYPE,
          orderId: this.ORDER_ID + "-" + codeorder
        }
      }, { headers: headers });
      return { success: true, data: response.data, codeorder: codeorder };
    } catch (error) {
      const errData = error.response?.data ? (typeof error.response.data === 'object' ? JSON.stringify(error.response.data) : error.response.data) : error.message;
      return { success: false, error: errData };
    }
  }
}

const auth = new AlightMotionAuth();
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function generateTempEmails(count) {
  const url = `https://www.sankavollerei.web.id/tools/tempmail/generate-bulk?apikey=planaai&type=dotGmail&count=${count}`;
  const res = await axios.get(url, { timeout: 30000 });
  if (res.data?.status && Array.isArray(res.data?.result?.emails)) {
    return res.data.result.emails;
  }
  throw new Error("Gagal generate tempmail: " + JSON.stringify(res.data));
}

async function getMagicLinkFromInbox(email, maxRetries = 8) {
  const url = `https://www.sankavollerei.web.id/tools/tempmail/inbox?apikey=planaai&email=${encodeURIComponent(email)}`;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await axios.get(url, { timeout: 10000 });
      if (res.data?.status && Array.isArray(res.data?.result?.data)) {
        const messages = res.data.result.data;
        for (const msg of messages) {
          if (msg.from?.includes('alight-creative') || msg.subject?.toLowerCase().includes('alight creative')) {
            if (Array.isArray(msg.links) && msg.links.length > 0) {
              return msg.links[0].url;
            }
            const urlMatch = msg.text?.match(/https?:\/\/[^\s]+/);
            if (urlMatch) return urlMatch[0];
          }
        }
      }
    } catch (e) {}
    await sleep(2000);
  }
  return null;
}

async function processSingleEmail(email) {
  try {
    const sendResult = await auth.sendMagicLink(email);
    if (!sendResult.success) {
      return { email, success: false, stage: "send", error: sendResult.error };
    }

    await sleep(3000);
    const magicLink = await getMagicLinkFromInbox(email, 8);
    if (!magicLink) {
      return { email, success: false, stage: "inbox", error: "Magic link tidak ditemukan di inbox." };
    }

    const profile = await auth.verifyAndFetchProfile(email, magicLink);
    if (!profile.success) {
      return { email, success: false, stage: "verify", error: profile.error };
    }

    const premium = await auth.applyPremium(profile.idToken);
    if (!premium.success) {
      return { email, success: false, stage: "premium", error: premium.error };
    }

    return {
      email,
      success: true,
      idToken: profile.idToken,
      user: profile.user,
      premium: premium.data,
      codeorder: premium.codeorder,
    };
  } catch (err) {
    return { email, success: false, stage: "unknown", error: err.message };
  }
}

 async function handler(req) {
  const urlObj = new URL(req.url);
  const query = Object.fromEntries(urlObj.searchParams.entries());
  
  const res = {
    statusCode: 200,
    bodyData: null,
    status(code) {
      this.statusCode = code;
      return {
        json: (data) => {
          this.bodyData = data;
          return new Response(JSON.stringify(data), {
            status: code,
            headers: {
              "Content-Type": "application/json; charset=UTF-8",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
      };
    }
  };

  const { email, action, link, amount, apikey } = query;

  try {
    if (!action) {
      return res.status(400).json({
        status: false,
        creator: "xnalznotdev",
        message: "Parameter action wajib diisi.",
      });
    }

    switch (action) {
      case "send": {
        const result = await auth.sendMagicLink(email);
        if (!result.success) {
          return res.status(500).json({
            status: false,
            creator: "xnalznotdev",
            message: result.error || "Gagal kirim magic link.",
          });
        }
        return res.status(200).json({
          status: true,
          creator: "xnalznotdev",
          result: { message: result.message },
        });
      }
      
      case "verif": {
        if (!link) {
          return res.status(400).json({
            status: false,
            creator: "xnalznotdev",
            message: "Parameter link wajib diisi.",
          });
        }
        const profile = await auth.verifyAndFetchProfile(email, link);
        if (!profile.success) {
          return res.status(500).json({
            status: false,
            creator: "xnalznotdev",
            message: profile.error || "Gagal verifikasi link.",
          });
        }
        const premium = await auth.applyPremium(profile.idToken);
        if (!premium.success) {
          return res.status(500).json({
            status: false,
            creator: "xnalznotdev",
            message: premium.error || "Gagal apply premium.",
          });
        }
        return res.status(200).json({
          status: true,
          creator: "xnalznotdev",
          result: {
            message: "Verifikasi & premium berhasil.",
            codeorder: premium.codeorder,
          },
        });
      }
     
      case "bulk": {
        if (apikey !== "201115") {
          return res.status(403).json({
            status: false,
            creator: "xnalznotdev",
            message: "API Key tidak valid.",
          });
        }
       
        const count = parseInt(amount);
        if (!count || count < 100) {
          return res.status(400).json({
            status: false,
            creator: "xnalznotdev",
            message: "Parameter amount wajib diisi dan minimal 100.",
          });
        }

        let emails = [];
        try {
          emails = await generateTempEmails(count);
        } catch (err) {
          return res.status(500).json({
            status: false,
            creator: "xnalznotdev",
            message: "Gagal generate tempmail: " + err.message,
          });
        }

        const results = await Promise.all(emails.map(e => processSingleEmail(e)));
        const successful = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);

        return res.status(200).json({
          status: true,
          creator: "xnalznotdev",
          result: {
            message: `Bulk selesai. ${successful.length} berhasil, ${failed.length} gagal.`,
            totalRequested: emails.length,
            totalSuccess: successful.length,
            totalFailed: failed.length,
          },
        });
      }

      default: {
        return res.status(400).json({
          status: false,
          creator: "xnalznotdev",
          message: "Action tidak valid. Gunakan send, verif, atau bulk.",
        });
      }
    }
  } catch (err) {
    return res.status(500).json({
      status: false,
      creator: "xnalznotdev",
      message: err.message,
    });
  }
}

module.exports = handler;