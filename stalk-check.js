(()=>{'use strict';
const BOOT={};
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const initialText=s=>String(s||'X').trim().split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'X';
const safeHttp=value=>{try{const u=new URL(String(value||''));return ['http:','https:'].includes(u.protocol)?u.href:'#'}catch{return '#'}};
const platformKey=String(BOOT.platform||'').toLowerCase();
document.body.dataset.platform=platformKey;
const themes={instagram:['#f65fa8','#ffb657'],tiktok:['#19d9e8','#f24c91'],youtube:['#ff4747','#ff9b54'],telegram:['#38bdf8','#827cff'],roblox:['#a9bbff','#738cff'],mlbb:['#ffb84a','#f56e89']};
const theme=themes[platformKey]||['#8b7cff','#42d9ff'];
document.documentElement.style.setProperty('--accent',theme[0]);document.documentElement.style.setProperty('--accent2',theme[1]);document.documentElement.style.setProperty('--glow',theme[0]+'35');
const platformName=String(BOOT.platformName||'Social Profile');
const platformBrand={
 youtube:['YouTube','CHANNEL PROFILE','OPEN CHANNEL'],
 tiktok:['TikTok','CREATOR PROFILE','OPEN TIKTOK'],
 instagram:['Instagram','SOCIAL PROFILE','OPEN INSTAGRAM'],
 telegram:['Telegram','PUBLIC PROFILE','OPEN TELEGRAM'],
 roblox:['Roblox','PLAYER PROFILE','OPEN ROBLOX'],
 mlbb:['Mobile Legends','PLAYER LOOKUP','OPEN MLBB']
}[platformKey]||[platformName,'SOCIAL PROFILE','OPEN PROFILE'];
$('brandTitle').textContent=platformBrand[0];
$('brandSubtitle').textContent=platformBrand[1];
const displayName=String(BOOT.displayName||BOOT.username||'Unknown profile');
const username=String(BOOT.username||'Username tidak tersedia');
$('coverPlatform').textContent=platformName.toUpperCase()+' / PROFILE CARD';
$('platformChip').textContent='✦ '+platformName.toUpperCase();
$('brandIcon').textContent=(platformName.replace(/[^A-Za-z0-9]/g,'')[0]||'X').toUpperCase();
$('name').textContent=displayName;
if(BOOT.verified){const v=document.createElement('span');v.className='verified';v.textContent='✓';v.setAttribute('aria-label','Terverifikasi');$('name').appendChild(v)}
$('handle').textContent=username.startsWith('@')?username:'@'+username;
$('bio').textContent=String(BOOT.bio||'Tidak ada deskripsi publik yang disediakan oleh platform.');
$('fallback').textContent=initialText(displayName||username);
const safeImage=value=>{const v=String(value||'');if(/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+\/=]+$/.test(v))return v;return safeHttp(v)};
const avatarUrl=safeImage(BOOT.avatar||BOOT.avatarUrl||BOOT.avatar_url||BOOT.profilePhoto||BOOT.photoURL);
if(avatarUrl!=='#'){$('avatar').src=avatarUrl;$('avatar').onload=()=>{$('fallback').style.display='none';$('avatar').style.display='block'};$('avatar').onerror=()=>{$('avatar').style.display='none';$('fallback').style.display='grid'}}
const summaryItems=[['◈',platformName],['◎',BOOT.verified?'Verified profile':'Public profile'],...(Array.isArray(BOOT.badges)?BOOT.badges.slice(0,3).map(b=>['◆',String(b)]):[])];
$('summary').innerHTML=summaryItems.map(([icon,label])=>`<span class="pill"><span class="pill-icon">${esc(icon)}</span>${esc(label)}</span>`).join('');
const iconFor=label=>{const x=String(label||'').toLowerCase();if(/follower|subscriber/.test(x))return'♙';if(/following|friends/.test(x))return'♧';if(/post|video|content/.test(x))return'▧';if(/like|heart/.test(x))return'♡';if(/user.?id|zone.?id/.test(x))return'⌘';if(/created|dibuat|joined|bergabung/.test(x))return'◷';if(/status|verified/.test(x))return'✓';if(/rank|role|game/.test(x))return'✧';return'◈'};
const stats=Array.isArray(BOOT.stats)?BOOT.stats.filter(x=>Array.isArray(x)):[];
$('stats').innerHTML=(stats.length?stats:[['Informasi','Tidak tersedia']]).map((pair,i)=>{const label=String(pair[0]||'Informasi'),value=String(pair[1]??'Tidak tersedia');return `<article class="stat"><div class="stat-top"><span class="stat-icon">${esc(iconFor(label))}</span><span class="stat-index">DATA ${(i+1).toString().padStart(2,'0')}</span></div><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value||'Tidak tersedia')}</div></article>`}).join('');
const profileUrl=safeHttp(BOOT.url);
$('open').href=profileUrl;
$('open').innerHTML='<span>↗</span> '+esc(platformBrand[2]);
if(profileUrl==='#'){$('open').setAttribute('aria-disabled','true');$('open').style.opacity='.55';$('open').style.pointerEvents='none'}
const query=encodeURIComponent((platformName+' '+username).replace(/^@/,''));$('search').href='https://www.google.com/search?q='+query;
$('note').textContent=String(BOOT.note||'Data publik dapat berubah sewaktu-waktu. Akun privat atau pembatasan dari platform dapat membuat sebagian informasi tidak tersedia.');
})();
