/*
 * Dizilla katalog plugini (02 IPTV, 2026-11-24, 1.0.3). "Ne izlesem?" sayfasının listesini ve filtrelerini okur; hiçbir video
 * adresi vermez. Uygulama afişe basınca diziyi TMDB'de bulur, kaynaklar kullanıcının kendi eklentilerinden gelir.
 *
 * Adres: /ne-izlesem?imdb=6.5&ulke=İngiltere&tur=Komedi&yil=y20,y2526&yayin=on,bitti&sure=orta,uzun&sayfa=2
 * (çoklu seçim virgülle; ülke ve tür düz ad). "Daha fazla yükle" yapısı: sayfa arttıkça sonraki diziler gelir.
 * Site adresi değişirse yalnızca BASE değişir; eski adres yeni adrese yönlendiriyorsa kendiliğinden izlenir.
 */
var BASE = 'https://dizilla.la';
var origin = null;
var last = { status: 0, size: 0, title: '', host: '', server: '', cf: '' };

var TURLER = ['Aksiyon', 'Aile', 'Animasyon', 'Anime', 'Belgesel', 'Bilim Kurgu', 'Biyografi', 'Dram', 'Fantastik', 'Game-Show',
  'Gerçeklik', 'Gerilim', 'Gizem', 'Kısa', 'Komedi', 'Korku', 'Macera', 'Müzik', 'Müzikal', 'Pembe Dizi', 'Reality-TV',
  'Romantik', 'Savaş', 'Spor', 'Suç', 'Talk-Show', 'Tarih', 'Western'];
var ULKELER = ['Amerika', 'Güney Kore', 'İngiltere', 'Türkiye', 'Japonya'];

function root() { return origin || BASE; }

function decode(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function plain(html) {
  return decode(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function absolute(url) {
  if (!url) return null;
  url = decode(url).trim();
  if (/^data:/i.test(url)) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.indexOf('//') === 0) return 'https:' + url;
  try { return new URL(url, root() + '/').href; } catch (e) { return null; }
}

async function getPage(path) {
  var res = await fetch(root() + path, {
    headers: { 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'tr-TR,tr;q=0.9' }
  });
  try { if (res.url) origin = new URL(res.url).origin; } catch (e) {}
  var text = await res.text();
  last.status = res.status;
  last.size = text.length;
  last.title = plain((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(text) || [])[1] || '').slice(0, 80);
  try { last.host = new URL(res.url || root()).hostname; } catch (e) { last.host = ''; }
  last.server = (res.headers && res.headers.get('server')) || '';
  last.cf = (res.headers && res.headers.get('x-02-cf')) || '';
  return text;
}

function opts(list) { return list.map(function (v) { return { value: v, label: v }; }); }

/** Sayfadaki ülke seçenekleri ("Daha fazla" dahil): ulke=... bağlantıları ya da seçenek düğmeleri; yoksa bilinen beş ülke. */
function readCountries(html) {
  var out = [], seen = {}, m, re = /[?&;]ulke=([^&"'#<\s]+)/g;
  var flat = html.replace(/&amp;/g, '&');
  while ((m = re.exec(flat))) {
    var v = '';
    try { v = decodeURIComponent(m[1].replace(/\+/g, ' ')); } catch (e) { continue; }
    v.split(',').forEach(function (one) {
      one = one.trim();
      if (one && !seen[one] && one.length < 30) { seen[one] = true; out.push(one); }
    });
  }
  ULKELER.forEach(function (c) { if (!seen[c]) { seen[c] = true; out.unshift(c); } });
  return out;
}

async function getFilters() {
  var html = '';
  try { html = await getPage('/ne-izlesem'); } catch (e) {}
  return {
    filters: [
      { id: 'ulke', label: 'Ülke', kind: 'multi', options: opts(readCountries(html)) },
      { id: 'tur', label: 'Tür', kind: 'multi', options: opts(TURLER) },
      { id: 'imdb', label: 'IMDb puanı', kind: 'single', options: opts(['6.5', '7', '7.5', '8']).map(function (o) { o.label = o.value.replace('.', ',') + '+'; return o; }) },
      { id: 'yil', label: 'Yıl / dönem', kind: 'multi', options: [
        { value: 'y2526', label: '2025–2026' }, { value: 'y20', label: "2020'ler" }, { value: 'y10', label: "2010'lar" }, { value: 'y00', label: "2000'ler" }] },
      { id: 'yayin', label: 'Yayın durumu', kind: 'multi', options: [{ value: 'on', label: 'Devam ediyor' }, { value: 'bitti', label: 'Bitti' }] },
      { id: 'sure', label: 'Bölüm süresi', kind: 'multi', options: [
        { value: 'kisa', label: "30 dk'ya kadar" }, { value: 'orta', label: '31–50 dk' }, { value: 'uzun', label: '50 dk üstü' }] }
    ],
    sorts: [],
    orders: []
  };
}

/** Sonuç kartları: dizi sayfasına giden, resimli bağlantılar (ad h2/h3 ya da resmin alt yazısı, rozette IMDb puanı). */
function readCards(html) {
  var items = [], seen = {};
  // Kartlar "N sonuç" yazısından sonra başlar (üstteki menü ve filtre bağlantıları atlanır).
  var at = html.search(/\d[\d.]*\s*sonu[çc]/i);
  var area = at > 0 ? html.slice(at) : html;
  var re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,15000}?)<\/a>/gi, m;
  while ((m = re.exec(area))) {
    var href = m[1], inner = m[2];
    if (!/<img|<picture|srcset=|background-image/i.test(inner)) continue;
    if (/ne-izlesem|\/(oyuncu|dizi-turu|kategori|takvim|reels|akis|giris|kayit|uye)\b/i.test(href)) continue;
    var title = plain((/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(inner) || [])[1]) ||
      decode((/<img[^>]*\balt=["']([^"']+)["']/i.exec(inner) || [])[1] || '').trim();
    if (!title || title.length > 150 || seen[href]) continue;
    seen[href] = true;
    var poster = (/data-src=["']([^"']+)["']/i.exec(inner) || /<img[^>]*\bsrc=["']([^"']+)["']/i.exec(inner) ||
      /background-image:\s*url\(["']?([^"')]+)/i.exec(inner) || [])[1];
    var srcset = (/srcset=["']([^"' ]+)/i.exec(inner) || [])[1];
    var text = plain(inner);
    var rating = (/(?:^|\s)(\d{1,2}[.,]\d)(?:\s|$)/.exec(text) || [])[1] || '';
    items.push({
      title: title,
      year: (/\b(19[3-9]\d|20[0-4]\d)\b/.exec(text) || [])[1] || '',
      poster: absolute(poster) || absolute(srcset),
      rating: rating.replace(',', '.'),
      score: '',
      scoreLabel: '',
      imdb: ((/(tt\d{5,10})/.exec(inner) || [])[1]) || null
    });
  }
  return items;
}

/** Veri bloğundaki kaçışları çözer (\\" -> "). */
function unescapeData(html) {
  return html.replace(/\\\\"/g, '"').replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\u0026/g, '&');
}

/**
 * Yedek yol (1.0.2): sonuçlar sayfanın içindeki veri bloğunda (Next.js self.__next_f). Her "poster..." alanının hemen
 * yakınındaki ad, yıl, puan ve IMDb numarası alınır (alan adları tahmin edilmez, en yakın uygun alan seçilir).
 */
function readData(html) {
  var text = unescapeData(html);
  var items = [], seen = {}, m;
  var re = /"([A-Za-z_]*(?:poster|Poster)[A-Za-z_]*)"\s*:\s*"([^"]{4,400})"/g;
  while ((m = re.exec(text))) {
    var at = m.index, from = Math.max(0, at - 1500), win = text.slice(from, at + 1500);
    var pairs = [], pm, pre = /"([A-Za-z_][A-Za-z0-9_]{0,40})"\s*:\s*(?:"([^"]{0,300})"|(-?\d+(?:\.\d+)?))/g;
    while ((pm = pre.exec(win))) pairs.push({ key: pm[1], str: pm[2], num: pm[3], pos: from + pm.index });
    function nearest(test) {
      var best = null;
      pairs.forEach(function (p) { if (test(p) && (!best || Math.abs(p.pos - at) < Math.abs(best.pos - at))) best = p; });
      return best;
    }
    // Önce "başlık" alanları (tür, ülke gibi iç nesnelerin "name" alanı daha yakın olabilir), sonra "ad" alanları.
    var t = nearest(function (p) {
      return p.str && /^(title|original_?title|title_?tr|tr_?title|baslik|dizi_?adi)$/i.test(p.key);
    }) || nearest(function (p) {
      return p.str && /^(name|original_?name|name_?tr|adi?)$/i.test(p.key) && p.pos < at;
    }) || nearest(function (p) { return p.str && /title|name|baslik/i.test(p.key) && !/slug|url|image|poster|genre|country|ulke|tur|network|kanal|actor|oyuncu|user/i.test(p.key); });
    if (!t) continue;
    var title = decode(t.str).trim();
    if (!title || seen[title] || title.length > 150) continue;
    seen[title] = true;
    var y = nearest(function (p) { return /year|yil|first_?air|release|start|date|tarih/i.test(p.key) && /^(19|20)\d\d/.test(p.str || p.num || ''); });
    var r = nearest(function (p) {
      var v = parseFloat(p.str || p.num); return /imdb|rating|puan|vote|score/i.test(p.key) && !/count|votes$/i.test(p.key) && v > 0 && v <= 10;
    });
    var imdb = (/(tt\d{5,10})/.exec(text.slice(at - 1500, at + 1500)) || [])[1] || null;
    var poster = m[2];
    if (/^\//.test(poster) && /tmdb|poster_path/i.test(m[1])) poster = 'https://image.tmdb.org/t/p/w342' + poster;
    items.push({
      title: title,
      year: y ? String(y.str || y.num).slice(0, 4) : '',
      poster: absolute(poster),
      rating: r ? String(parseFloat(r.str || r.num)) : '',
      score: '', scoreLabel: '', imdb: imdb
    });
  }
  return items;
}

/**
 * 1.0.3: "poster" alan adı değil, resim adresinin içinde (…/poster/x.webp). Her böyle adresin yakınındaki ad alanı
 * (title/name) ya da resmin alt yazısı alınır.
 */
function readPosterUrls(html) {
  var text = unescapeData(html);
  var items = [], seen = {}, seenUrl = {}, m;
  var re = /(https?:\/\/[^"'\s\\<>()]*poster[^"'\s\\<>()]*|\/[^"'\s\\<>()]*poster[^"'\s\\<>()]*\.(?:webp|jpe?g|png|avif))/gi;
  while ((m = re.exec(text))) {
    var url = m[1], at = m.index;
    if (seenUrl[url]) continue;
    seenUrl[url] = true;
    var from = Math.max(0, at - 1500), win = text.slice(from, at + 1500);
    var best = null, bestDist = 1e9, pm;
    var pre = /"(title|original_?title|title_?tr|name|original_?name|baslik)"\s*:\s*"([^"]{1,150})"|\balt=["']([^"']{1,150})["']/gi;
    while ((pm = pre.exec(win))) {
      var d = Math.abs(from + pm.index - at);
      // "name" alanında tür / ülke adı olabilir: başlık alanları ve alt yazı öne alınır.
      if (pm[1] && /^name|original_?name$/i.test(pm[1])) d += 400;
      if (d < bestDist) { bestDist = d; best = pm[2] || pm[3]; }
    }
    if (!best) continue;
    var title = decode(best).trim();
    if (!title || seen[title] || /dizilla|logo/i.test(title)) continue;
    seen[title] = true;
    var near = text.slice(Math.max(0, at - 800), at + 800);
    var y = (/"[A-Za-z_]*(?:year|yil|date|tarih)[A-Za-z_]*"\s*:\s*"?((?:19|20)\d\d)/i.exec(near) || [])[1] || '';
    var r = (/"[A-Za-z_]*(?:imdb|rating|puan|score)[A-Za-z_]*"\s*:\s*"?(\d(?:\.\d)?)/i.exec(near) || [])[1] || '';
    items.push({ title: title, year: y, poster: absolute(url), rating: r, score: '', scoreLabel: '', imdb: (/(tt\d{5,10})/.exec(near) || [])[1] || null });
  }
  return items;
}

/** İlk "poster" geçen yerin çevresi (teşhis için; sitenin herkese açık katalog verisi). */
function posterSnippet(html) {
  var text = unescapeData(html);
  var at = text.search(/poster/i);
  if (at < 0) return 'yok';
  return text.slice(Math.max(0, at - 110), at + 70).replace(/\s+/g, ' ');
}

/** İlk "poster" alanının yakınındaki alan adları (yalnızca adlar; teşhis satırı için). */
function keysNearPoster(html) {
  var text = unescapeData(html);
  var at = text.search(/"[A-Za-z_]*[Pp]oster[A-Za-z_]*"\s*:/);
  if (at < 0) return 'poster alanı yok';
  var win = text.slice(Math.max(0, at - 600), at + 600), seen = {}, out = [], m, re = /"([A-Za-z_][A-Za-z0-9_]{0,30})"\s*:/g;
  while ((m = re.exec(win))) if (!seen[m[1]]) { seen[m[1]] = true; out.push(m[1]); }
  return out.slice(0, 30).join(' ');
}

/** Sayfanın yapısı (teşhis satırı): bağlantı, resim ve veri bloğu sayıları. */
function structure(html) {
  function count(re) { return (html.match(re) || []).length; }
  return 'a ' + count(/<a\b/gi) + ', img ' + count(/<img\b/gi) + ', picture ' + count(/<picture\b/gi) +
    ', next_data ' + count(/__NEXT_DATA__/g) + ', next_f ' + count(/self\.__next_f/g) + ', poster ' + count(/poster/gi) +
    ', h2 ' + count(/<h2\b/gi) + ', h3 ' + count(/<h3\b/gi);
}

async function getCatalog(query, page) {
  var values = (query && query.values) || {};
  var params = [];
  ['imdb', 'ulke', 'tur', 'yil', 'yayin', 'sure'].forEach(function (id) {
    var list = (values[id] || []).filter(function (v) { return String(v).trim(); });
    if (list.length) params.push(id + '=' + encodeURIComponent(list.join(',')));
  });
  page = page || 1;
  if (page > 1) params.push('sayfa=' + page);
  var html;
  try {
    html = await getPage('/ne-izlesem' + (params.length ? '?' + params.join('&') : ''));
  } catch (e) {
    return { items: [], hasMore: false, total: -1, debug: 'bağlantı: ' + String((e && e.message) || e).slice(0, 150) };
  }
  var items = readCards(html), how = 'kart';
  if (!items.length) { items = readData(html); how = 'veri'; }
  if (!items.length) { items = readPosterUrls(html); how = 'resim adresi'; }
  // Sayfa arttıkça önceki diziler de geliyorsa (birikerek), yalnızca bu sayfanınkiler alınır.
  if (page > 1 && items.length > 40) {
    var per = Math.round(items.length / page);
    if (per > 0 && items.length >= per * (page - 0.5)) items = items.slice(per * (page - 1));
  }
  var total = -1;
  var tm = /(\d[\d.]*)\s*sonu[çc]/i.exec(plain(html));
  if (tm) total = parseInt(tm[1].replace(/\./g, ''), 10);
  var debug = 'kod ' + last.status + ' · ' + Math.round(last.size / 1024) + ' KB · ' + (last.host || '?') +
    (last.cf ? ' · ' + last.cf : '') +
    ' · afiş ' + items.length + ' (' + how + ') · toplam ' + total + (how === 'kart' && items.length ? '' : ' · çevre: ' + posterSnippet(html));
  return { items: items, hasMore: items.length > 0 && (total < 0 || page * items.length < total), total: total, debug: debug };
}

module.exports = { getFilters: getFilters, getCatalog: getCatalog };
