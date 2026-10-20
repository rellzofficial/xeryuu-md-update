//Please don't change script credit creator
//🔰 Creator : Xnalz
//🔰 Telegram : https://t.me/XnalzNotDev
//🔰 Nomor Whatsapp : 6283116282076
//🔰 ©xnalznotdev
// JANGAN MENGUBAH CREDIT DARI SCRIPT INI, JIKA KETAHUAN MAKA AKAN DIKENAKAN SANKSI DAN KONSEKUENSI ©xnalz

const axios = require('axios');
const chalk = require("chalk");
const cheerio = require('cheerio');
const fetch = require('node-fetch');
const fs = require("fs");
const FormData = require('form-data');
const crypto = require("crypto");
const { normalizePinterestSearchResults } = require('./pinterest-utils.js');

async function tiktokDl(url) {
	return new Promise(async (resolve, reject) => {
		try {
			let data = []
			function formatNumber(integer) {
				let numb = parseInt(integer)
				return Number(numb).toLocaleString().replace(/,/g, '.')
			}
			
			function formatDate(n, locale = 'en') {
				let d = new Date(n)
				return d.toLocaleDateString(locale, {
					weekday: 'long',
					day: 'numeric',
					month: 'long',
					year: 'numeric',
					hour: 'numeric',
					minute: 'numeric',
					second: 'numeric'
				})
			}
			
			let domain = 'https://www.tikwm.com/api/';
			let res = await (await axios.post(domain, {}, {
				headers: {
					'Accept': 'application/json, text/javascript, */*; q=0.01',
					'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
					'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
					'Origin': 'https://www.tikwm.com',
					'Referer': 'https://www.tikwm.com/',
					'Sec-Ch-Ua': '"Not)A;Brand" ;v="24" , "Chromium" ;v="116"',
					'Sec-Ch-Ua-Mobile': '?1',
					'Sec-Ch-Ua-Platform': 'Android',
					'Sec-Fetch-Dest': 'empty',
					'Sec-Fetch-Mode': 'cors',
					'Sec-Fetch-Site': 'same-origin',
					'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
					'X-Requested-With': 'XMLHttpRequest'
				},
				params: {
					url: url,
					count: 12,
					cursor: 0,
					web: 1,
					hd: 1
				}
			})).data.data
			if (res?.duration == 0) {
				res.images.map(v => {
					data.push({ type: 'photo', url: v })
				})
			} else {
				data.push({
					type: 'watermark',
					url: 'https://www.tikwm.com' + res?.wmplay || "/undefined",
				}, {
					type: 'nowatermark',
					url: 'https://www.tikwm.com' + res?.play || "/undefined",
				}, {
					type: 'nowatermark_hd',
					url: 'https://www.tikwm.com' + res?.hdplay || "/undefined"
				})
			}
			let json = {
				status: true,
				title: res.title,
				taken_at: formatDate(res.create_time).replace('1970', ''),
				region: res.region,
				id: res.id,
				durations: res.duration,
				duration: res.duration + ' Seconds',
				cover: 'https://www.tikwm.com' + res.cover,
				size_wm: res.wm_size,
				size_nowm: res.size,
				size_nowm_hd: res.hd_size,
				data: data,
				music_info: {
					id: res.music_info.id,
					title: res.music_info.title,
					author: res.music_info.author,
					album: res.music_info.album ? res.music_info.album : null,
					url: 'https://www.tikwm.com' + res.music || res.music_info.play
				},
				stats: {
					views: formatNumber(res.play_count),
					likes: formatNumber(res.digg_count),
					comment: formatNumber(res.comment_count),
					share: formatNumber(res.share_count),
					download: formatNumber(res.download_count)
				},
				author: {
					id: res.author.id,
					fullname: res.author.unique_id,
					nickname: res.author.nickname,
					avatar: 'https://www.tikwm.com' + res.author.avatar
				}
			}
			resolve(json)
		} catch (e) {
			
		}
	});
}


const PINTEREST_SEARCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

async function pinterest2(query) {
	const keyword = String(query || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
	if (!keyword) return [];

	const baseUrl = 'https://www.pinterest.com';
	const sourcePath = `/search/pins/?q=${encodeURIComponent(keyword)}`;
	const params = {
		source_url: sourcePath,
		data: JSON.stringify({ options: { isPrefetch: false, query: keyword, scope: 'pins', no_fetch_context_on_resource: false }, context: {} }),
		_: Date.now()
	};
	const url = `${baseUrl}/resource/BaseSearchResource/get/`;
	const response = await axios.get(url, {
		params,
		timeout: 18000,
		maxRedirects: 3,
		maxContentLength: 8 * 1024 * 1024,
		headers: {
			Accept: 'application/json, text/javascript, */*; q=0.01',
			'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
			'Cache-Control': 'no-cache',
			Origin: baseUrl,
			Referer: `${baseUrl}${sourcePath}`,
			'User-Agent': PINTEREST_SEARCH_UA,
			'X-Requested-With': 'XMLHttpRequest',
			'x-pinterest-appstate': 'active',
			'x-pinterest-pws-handler': 'www/search/[scope].js',
			'x-pinterest-source-url': sourcePath
		},
		validateStatus: () => true
	});
	if (response.status === 429) {
		const error = new Error('Pinterest membatasi permintaan sementara (HTTP 429). Coba lagi setelah jeda.');
		error.status = 429;
		throw error;
	}
	if (response.status < 200 || response.status >= 300) {
		const error = new Error(`Pinterest menolak pencarian (HTTP ${response.status}). Fallback provider akan dicoba oleh pemanggil.`);
		error.status = response.status;
		throw error;
	}
	const results = normalizePinterestSearchResults(response.data, keyword, baseUrl);
	return results;
}

async function pinterestSearch(query) {
	const keyword = String(query || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
	if (!keyword) return [];
	const errors = [];
	try {
		const direct = await pinterest2(keyword);
		if (direct.length) return direct;
	} catch (error) {
		errors.push(error?.message || String(error));
		console.warn('[PINTEREST SEARCH DIRECT]', error?.message || error);
		// Don't hammer Pinterest after an explicit rate limit.
		// Continue to an independent provider after a Pinterest-side limit; no further
		// requests are sent to Pinterest in this invocation.
	}

	// Public third-party search fallback. This is a fallback, not a guarantee: if the
	// provider itself returns 403/429 or changes schema, we report no results cleanly.
	const fallbackUrl = String(process.env.XERYUU_PINTEREST_SEARCH_API || 'https://api.siputzx.my.id/api/s/pinterest').trim();
	if (fallbackUrl) {
		try {
			const response = await axios.get(fallbackUrl, {
				params: { query: keyword }, timeout: 18000, maxContentLength: 8 * 1024 * 1024,
				headers: { Accept: 'application/json', 'User-Agent': PINTEREST_SEARCH_UA },
				validateStatus: () => true
			});
			if (response.status === 429) {
				console.warn('[PINTEREST SEARCH FALLBACK] Provider rate limited (HTTP 429).');
				return [];
			}
			if (response.status < 200 || response.status >= 300) throw new Error(`Provider HTTP ${response.status}`);
			const fallbackResults = normalizePinterestSearchResults(response.data, keyword);
			if (fallbackResults.length) return fallbackResults;
			errors.push('Provider fallback tidak mengembalikan item gambar yang valid.');
		} catch (error) {
			errors.push(error?.message || String(error));
			console.warn('[PINTEREST SEARCH FALLBACK]', error?.message || error);
		}
	}
	if (errors.length) console.warn('[PINTEREST SEARCH EMPTY]', errors.join(' | ').slice(0, 300));
	return [];
}

async function pinterest(query) {
	const results = await pinterestSearch(query);
	return results.map(item => item.images_url).filter(url => typeof url === 'string' && /^https:\/\//i.test(url));
}

async function mediafire (query) {
	return new Promise((resolve, reject) => {
		axios.get(query)
			.then(({
				data
			}) => {
				const $ = cheerio.load(data)
				const judul = $('body > div.mf-dlr.page.ads-alternate > div.content > div.center > div > div.dl-btn-cont > div.dl-btn-labelWrap > div.promoDownloadName.notranslate > div').text();
				const size = $('body > div.mf-dlr.page.ads-alternate > div.content > div.center > div > div.dl-info > ul > li:nth-child(1) > span').text();
				const upload_date = $('body > div.mf-dlr.page.ads-alternate > div.content > div.center > div > div.dl-info > ul > li:nth-child(2) > span').text();
				const link = $('#downloadButton').attr('href')
				const hsil = {
					judul: link.split('/')[5],
					upload_date: upload_date,
					size: size,
					mime: link.split('/')[5].split('.')[1],
					link: link
				}
				resolve(hsil)
			})
			.catch(reject)
	})
}

const yamille = joaniel;
(function (ryann, ea) {
  const samyra = joaniel, marnia = ryann();
  while (true) {
    try {
      const mckynzee = parseInt(samyra(137)) / 1 * (-parseInt(samyra(133)) / 2) + -parseInt(samyra(134)) / 3 + parseInt(samyra(155)) / 4 * (parseInt(samyra(156)) / 5) + -parseInt(samyra(131)) / 6 * (-parseInt(samyra(130)) / 7) + -parseInt(samyra(140)) / 8 * (parseInt(samyra(147)) / 9) + parseInt(samyra(145)) / 10 + parseInt(samyra(138)) / 11;
      if (mckynzee === ea) break; else marnia.push(marnia.shift());
    } catch (beril) {
      marnia.push(marnia.shift());
    }
  }
}(altavious, 888830));
Jimp = require(yamille(154))
function joaniel(wendolyne, nyier) {
  const enalina = altavious();
  return joaniel = function (laurae, mekelle) {
    laurae = laurae - 127;
    let ralphine = enalina[laurae];
    return ralphine;
  }, joaniel(wendolyne, nyier);
}
function altavious() {
  const jaylenn = ["inferenceengine", "push", "21AoSGqU", "225006xOkcNu", "concat", "472390FPofBK", "4809828vvqtte", "data", "model_version", "3NUOcvQ", "14047187eKUyBb", "error", "3013792ZhnCJd", "okhttp/4.9.3", ".ai/", "enhance_image_body.jpg", "from", "10610670esKiBu", "append", "18nRsxLl", "submit", "https", "image", ".vyro", "image/jpeg", "enhance", "jimp", "24448HhNNWt", "1230ttmiGH", "Keep-Alive"];
  altavious = function () {
    return jaylenn;
  };
  return altavious();
}
async function remini(kyoko, tysa) {
  return new Promise(async (majeed, tamicko) => {
    const deamber = joaniel;
    let milahn = [deamber(153), "recolor", "dehaze"];
    milahn.includes(tysa) ? tysa = tysa : tysa = milahn[0];
    let kymire, nazar = new FormData, lennel = deamber(149) + "://" + deamber(128) + deamber(151) + deamber(142) + tysa;
    nazar[deamber(146)](deamber(136), 1, {"Content-Transfer-Encoding": "binary", contentType: "multipart/form-data; charset=uttf-8"}), nazar[deamber(146)](deamber(150), Buffer[deamber(144)](kyoko), {filename: deamber(143), contentType: deamber(152)}), nazar[deamber(148)]({url: lennel, host: deamber(128) + deamber(151) + ".ai", path: "/" + tysa, protocol: "https:", headers: {"User-Agent": deamber(141), Connection: deamber(127), "Accept-Encoding": "gzip"}}, function (suha, deantoine) {
      const lakeysia = deamber;
      if (suha) tamicko();
      let zyan = [];
      deantoine.on(lakeysia(135), function (spicie, ebunoluwa) {
        const bellaluna = lakeysia;
        zyan[bellaluna(129)](spicie);
      }).on("end", () => {
        const camden = lakeysia;
        majeed(Buffer[camden(132)](zyan));
      }), deantoine.on(lakeysia(139), shady => {
        tamicko();
      });
    });
  });
}
async function ephoto(url, texk) {
  let gT = await axios.get(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36"
    }
  });
  
  let $ = cheerio.load(gT.data);
  let text = texk;
  let token = $("input[name=token]").val();
  let build_server = $("input[name=build_server]").val();
  let build_server_id = $("input[name=build_server_id]").val();
  
  // Manual form data construction
  const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
  let formData = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="text[]"',
    '',
    text,
    `--${boundary}`,
    'Content-Disposition: form-data; name="token"',
    '',
    token,
    `--${boundary}`,
    'Content-Disposition: form-data; name="build_server"',
    '',
    build_server,
    `--${boundary}`,
    'Content-Disposition: form-data; name="build_server_id"',
    '',
    build_server_id,
    `--${boundary}--`,
    ''
  ].join('\r\n');
  
  let res = await axios({
    url: url,
    method: "POST",
    data: formData,
    headers: {
      Accept: "*/*",
      "Accept-Language": "en-US,en;q=0.9",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36",
      cookie: gT.headers["set-cookie"]?.join("; "),
      "Content-Type": `multipart/form-data; boundary=${boundary}`
    }
  });
  
  let $$ = cheerio.load(res.data);
  let json = JSON.parse($$("input[name=form_value_input]").val());
  json["text[]"] = json.text;
  delete json.text;
  
  let { data } = await axios.post(
    "https://en.ephoto360.com/effect/create-image", 
    new URLSearchParams(json), 
    {
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Safari/537.36",
        cookie: gT.headers["set-cookie"].join("; ")
      }
    }
  );
  
  return build_server + data.image;
}

module.exports = { pinterest, pinterest2, pinterestSearch, normalizePinterestSearchResults, remini, mediafire, tiktokDl, ephoto}