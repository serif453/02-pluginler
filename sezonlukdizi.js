/*
 * Sezonluk Dizi katalog plugini (02 IPTV, 2026-11-23; 1.0.1: teşhis satırı; 1.0.2: Cloudflare adımı teşhiste; 1.0.3: afiş kutusu düzeltildi; 1.0.4: kapanmayan seçenekler, boş kutuda bağlantılardan seçenek; 1.0.5: kutular kimlik ve benzer adla bulunuyor; 1.0.6: sitenin süslü kutuları (Semantic UI)). Yalnızca dizi listesini ve filtrelerini okur; hiçbir video adresi
 * vermez. Uygulama afişe basınca diziyi TMDB'de bulur, kaynaklar kullanıcının kendi eklentilerinden gelir.
 *
 * getFilters(): sitenin "Gelişmiş Dizi Arama" kutularındaki seçenekler (sayfadan okunur: site yeni tür ya da kanal eklerse
 * kendiliğinden gelir).
 * getCatalog(sorgu, sayfa): diziler.asp?...&s=<sayfa> sonuçları (ad, yıl, afiş, IMDb ve SDP puanı).
 *
 * Site adresi değişirse yalnızca BASE değişir; eski adres yeni adrese yönlendiriyorsa kendiliğinden izlenir.
 */
var BASE = 'https://sezonlukdizi.cc';
var origin = null;
// Son isteğin özeti (uygulamanın testinde ve boş listede görünür): cevap kodu, boyut, sayfa başlığı, sunucu.
var last = { status: 0, size: 0, title: '', host: '', server: '', cf: '' };

var LABELS = { adi: 'Dizi adı', kat: 'Kategori', tur: 'Tür', ulke: 'Ülke', tv: 'TV kanalı', durum: 'Dizi durumu', dil: 'Dil' };
var SELECT_ORDER = ['kat', 'tur', 'ulke', 'tv', 'durum', 'dil'];
// Açılır kutu okunamazsa kategori kodları (sitenin bilinen adresleri).
var KAT_FALLBACK = [
  { value: '1', label: 'Yabancı Diziler' }, { value: '2', label: 'Yerli Diziler' }, { value: '3', label: 'Asya Dizileri' },
  { value: '4', label: 'Animasyonlar' }, { value: '5', label: 'Animeler' }, { value: '6', label: 'Belgeseller' }
];
var EMPTY_LABEL = /^(fark etmez|hepsi|tümü|seç|seçiniz|kategori seç|ülke seçimi|tv kanalı|dizi türleri)$/i;

function root() { return origin || BASE; }

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

function debugLine(extra) {
  return 'kod ' + last.status + ' · ' + Math.round(last.size / 1024) + ' KB · ' + (last.host || '?') +
    (last.server ? ' · sunucu ' + last.server : '') + (last.cf ? ' · ' + last.cf : '') + ' · başlık "' + (last.title || '-') + '"' +
    (extra ? ' · ' + extra : '');
}

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
  if (/^https?:\/\//i.test(url)) return url;
  if (url.indexOf('//') === 0) return 'https:' + url;
  try { return new URL(url, root() + '/').href; } catch (e) { return null; }
}

/** Sayfadaki açılır kutular: ad -> { multiple, options }. */
function readSelects(html) {
  var out = {};
  var re = /<select([^>]*)>([\s\S]*?)<\/select>/gi, m;
  while ((m = re.exec(html))) {
    var attrs = m[1];
    // Ad yoksa kimlik (bazı kutuların değerini sayfanın kodu adrese yazar, kutunun adı olmaz).
    var name = (/\bname=["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || (/\bid=["']?([^"'\s>]+)/i.exec(attrs) || [])[1];
    if (!name) continue;
    name = name.replace(/\[\]$/, '');
    // Seçenekler kapanış etiketi olmadan da yazılabilir (<option value=1>Yabancı): yazı bir sonraki etikete kadar okunur.
    var options = [], om, ore = /<option([^>]*)>([^<]*)/gi;
    while ((om = ore.exec(m[2]))) {
      var value = (/\bvalue=["']([^"']*)["']/i.exec(om[1]) || /\bvalue=([^\s>]+)/i.exec(om[1]) || [])[1];
      var label = plain(om[2]);
      if (value === undefined) value = label;
      value = decode(value).trim();
      if (!value || !label || EMPTY_LABEL.test(label)) continue;
      options.push({ value: value, label: label });
    }
    out[name] = { multiple: /\bmultiple\b/i.test(attrs), options: options };
  }
  return readDropdowns(html, out);
}

/**
 * Sitenin süslü kutuları (Semantic UI "ui dropdown", 1.0.6): değer gizli alanda (<input type="hidden" name="ulke">),
 * seçenekler altındaki listede (<div class="item" data-value="abd">ABD</div>). Gizli alandan sonraki ilk gizli alana kadar
 * olan bölümdeki seçenekler o kutunundur.
 */
function readDropdowns(html, out) {
  var re = /<input([^>]*\btype=["']?hidden["']?[^>]*)>/gi, m, marks = [];
  while ((m = re.exec(html))) {
    var name = (/\bname=["']?([^"'\s>]+)/i.exec(m[1]) || [])[1];
    if (name) marks.push({ name: name.replace(/\[\]$/, ''), at: m.index, end: re.lastIndex });
  }
  marks.forEach(function (mark, i) {
    if (out[mark.name] && out[mark.name].options.length) return;
    var stop = i + 1 < marks.length ? marks[i + 1].at : mark.end + 60000;
    var part = html.slice(mark.end, Math.min(stop, mark.end + 60000));
    var options = [], seen = {}, im, ire = /<(div|a|li)([^>]*\bdata-value=["']([^"']*)["'][^>]*)>([\s\S]*?)<\/\1>/gi;
    while ((im = ire.exec(part))) {
      if (!/\bitem\b/i.test(im[2])) continue;
      var value = decode(im[3]).trim();
      var label = plain(im[4]);
      if (!value || !label || seen[value] || EMPTY_LABEL.test(label)) continue;
      seen[value] = true;
      options.push({ value: value, label: label });
    }
    if (!options.length) return;
    // Çoklu seçim kutusu: gizli alandan hemen önceki kutunun sınıfında "multiple".
    var before = html.slice(Math.max(0, mark.at - 400), mark.at);
    out[mark.name] = { multiple: /class=["'][^"']*\bmultiple\b[^"']*["'][^>]*>\s*$/i.test(before) || /\bmultiple\b/i.test(before.slice(-200)), options: options };
  });
  return out;
}

/** Adres adı -> kutunun sayfadaki olası adları (adı ya da kimliği bunlardan biriyle başlıyorsa o kutu). */
var ALIASES = {
  kat: ['kat', 'kategori'],
  tur: ['tur', 'tür', 'genre'],
  ulke: ['ulke', 'ülke', 'country'],
  tv: ['tv', 'kanal', 'network'],
  durum: ['durum', 'status'],
  dil: ['dil', 'lang']
};

function findSelect(selects, key) {
  if (selects[key]) return selects[key];
  var names = Object.keys(selects);
  for (var i = 0; i < names.length; i++) {
    var n = names[i].toLowerCase().replace(/[^a-zçğıöşü]/g, '');
    if (/siralama|sirala|ps$/.test(n)) continue;
    if (ALIASES[key].some(function (a) { return n.indexOf(a) === 0; })) return selects[names[i]];
  }
  return null;
}

/** Sıralama sekmeleri (IMDb, SDP, Alfabetik, Yıl...): siralama_tipi=... bağlantıları ya da açılır kutusu. */
function readSorts(html, selects) {
  var seen = {}, sorts = [];
  function add(value, label) {
    if (!value || seen[value] || !label) return;
    seen[value] = true;
    sorts.push({ value: value, label: label });
  }
  if (selects.siralama_tipi) selects.siralama_tipi.options.forEach(function (o) { add(o.value, o.label); });
  var re = /<(?:a|button|li|div|span)[^>]*?(?:href=["'][^"']*siralama_tipi=([a-z_]+)[^"']*["']|data-[a-z_-]*=["']([a-z_]+)["'][^>]*siralama)[^>]*>([\s\S]{0,300}?)<\/(?:a|button|li|div|span)>/gi, m;
  while ((m = re.exec(html))) add(m[1] || m[2], plain(m[3]));
  if (!sorts.length) {
    add('imdb', 'IMDb'); add('id', 'Son eklenen');
  }
  return sorts;
}

/**
 * Kutu boşsa (seçenekleri sayfanın kodu sonradan dolduruyorsa) sayfadaki bağlantılardan toplanır: `diziler.asp?ulke=abd`
 * gibi bağlantıların değeri ve yazısı.
 */
function harvest(html, name) {
  var out = [], seen = {}, m;
  var re = new RegExp('<a[^>]+href=["\'][^"\']*[?&;]' + name + '=([^&"\'#]+)[^"\']*["\'][^>]*>([\\s\\S]{0,200}?)<\\/a>', 'gi');
  while ((m = re.exec(html))) {
    var value = decode(decodeURIComponent(m[1].replace(/\+/g, ' '))).trim();
    var label = plain(m[2]);
    if (!value || !label || seen[value] || label.length > 40) continue;
    seen[value] = true;
    out.push({ value: value, label: label });
  }
  return out;
}

/** Kutuların okunan seçenek sayıları (teşhis satırı için). */
function selectSummary(html) {
  var selects = readSelects(html);
  var found = SELECT_ORDER.map(function (name) { var sel = findSelect(selects, name); return name + ' ' + (sel ? sel.options.length : '-'); }).join(', ');
  var all = Object.keys(selects).map(function (n) { return n + '(' + selects[n].options.length + ')'; }).join(' ');
  return found + ' · sayfadaki kutular: ' + (all || 'yok');
}

async function getFilters() {
  var html = await getPage('/diziler.asp');
  var selects = readSelects(html);
  var filters = [{ id: 'adi', label: LABELS.adi, kind: 'text' }];
  SELECT_ORDER.forEach(function (name) {
    var sel = findSelect(selects, name);
    var options = sel && sel.options.length ? sel.options : harvest(html, name);
    if (!options.length && name === 'kat') options = KAT_FALLBACK;
    if (!options.length) return;
    var multi = name === 'tur' || (sel && sel.multiple);
    filters.push({ id: name, label: LABELS[name] || name, kind: multi ? 'multi' : 'single', options: options });
  });
  var year = new Date().getFullYear();
  filters.push({ id: 'yil', label: 'Yıl', kind: 'range', min: 1950, max: year });
  filters.push({ id: 'minImdb', label: 'En düşük IMDb puanı', kind: 'number', min: 0, max: 10 });
  return {
    filters: filters,
    sorts: readSorts(html, selects),
    orders: [{ value: 'desc', label: 'Azalan' }, { value: 'asc', label: 'Artan' }]
  };
}

function number(text) {
  var m = /([0-9]+[.,][0-9])/.exec(text || '');
  return m ? m[1].replace(',', '.') : '';
}

/**
 * Afiş görünümündeki kartlar: `div.afis` bütün afişleri saran kutudur (1.0.3; 1.0.2 her afişi ayrı kutu sanıyordu), her dizi
 * içindeki bir bağlantıdır (resim data-src, ad div.description, rozetlerde SDP / IMDb ve yıl).
 */
function readCards(html) {
  var items = [];
  var start = html.search(/<div[^>]*class=["'][^"']*\bafis\b[^"']*["'][^>]*>/i);
  if (start < 0) return items;
  var area = html.slice(start, start + 600000);
  var end = area.search(/class=["'][^"']*\b(pagination|sayfalama)\b/i);
  if (end > 0) area = area.slice(0, end);
  var re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, m, seen = {};
  while ((m = re.exec(area))) {
    var inner = m[2];
    if (!/description|<img/i.test(inner)) continue;
    var title = plain((/class=["'][^"']*\bdescription\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(inner) || [])[1]) ||
      decode((/<img[^>]*\balt=["']([^"']+)["']/i.exec(inner) || [])[1] || '').trim();
    if (!title || seen[m[1]]) continue;
    seen[m[1]] = true;
    var poster = (/data-src=["']([^"']+)["']/i.exec(inner) || /<img[^>]*\bsrc=["']([^"']+)["']/i.exec(inner) || [])[1];
    var text = plain(inner);
    items.push({
      title: title,
      year: (/\b(19[3-9]\d|20[0-4]\d)\b/.exec(text) || [])[1] || '',
      poster: absolute(poster),
      rating: number((/IMDb\s*:?\s*([0-9]+[.,][0-9])/i.exec(text) || [])[0]),
      score: number((/SDP\s*:?\s*([0-9]+[.,][0-9])/i.exec(text) || [])[0]),
      scoreLabel: 'SDP',
      imdb: ((/(tt\d{5,10})/.exec(inner) || [])[1]) || null
    });
  }
  return items;
}

/** Yedek yol (görünüm "Liste" ise ya da düzen değiştiyse): resimli ve dizi sayfasına giden bağlantılar. */
function readLinks(html) {
  var items = [], seen = {};
  var re = /<a[^>]+href=["']([^"'#?]+)["'][^>]*>([\s\S]{0,2500}?)<\/a>/gi, m;
  while ((m = re.exec(html))) {
    var inner = m[2];
    if (!/<img/i.test(inner)) continue;
    var href = m[1];
    if (/\.(asp|php|html?)$|^\/?$|forum|uye|giris|kayit|iletisim/i.test(href)) continue;
    var title = decode((/<img[^>]*\balt=["']([^"']+)["']/i.exec(inner) || [])[1] || '').trim() || plain(inner);
    if (!title || title.length > 120 || seen[href]) continue;
    seen[href] = true;
    var poster = (/data-src=["']([^"']+)["']/i.exec(inner) || /<img[^>]*\bsrc=["']([^"']+)["']/i.exec(inner) || [])[1];
    var text = plain(inner);
    items.push({
      title: title,
      year: (/\b(19[3-9]\d|20[0-4]\d)\b/.exec(text) || [])[1] || '',
      poster: absolute(poster),
      rating: number((/IMDb\s*:?\s*([0-9]+[.,][0-9])/i.exec(text) || [])[0]),
      score: number((/SDP\s*:?\s*([0-9]+[.,][0-9])/i.exec(text) || [])[0]),
      scoreLabel: 'SDP',
      imdb: null
    });
  }
  return items;
}

async function getCatalog(query, page) {
  var values = (query && query.values) || {};
  function first(id) { var v = values[id]; return v && v.length ? String(v[0]) : ''; }
  var params = new URLSearchParams();
  params.append('adi', first('adi'));
  params.append('kat', first('kat'));
  var tur = values.tur || [];
  if (tur.length) tur.forEach(function (t) { params.append('tur', String(t)); }); else params.append('tur', '');
  ['ulke', 'tv'].forEach(function (id) {
    var list = values[id] || [];
    if (list.length) list.forEach(function (v) { params.append(id, String(v)); }); else params.append(id, '');
  });
  params.append('durum', first('durum'));
  var yil = values.yil || [];
  params.append('minYil', yil[0] ? String(yil[0]) : '');
  params.append('maxYil', yil[1] ? String(yil[1]) : '');
  params.append('minImdb', first('minImdb'));
  params.append('dil', first('dil'));
  params.append('ps', '50');
  params.append('siralama_tipi', (query && query.sort) || 'imdb');
  params.append('siralama_turu', (query && query.order) || 'desc');
  params.append('s', String(page || 1));
  var html;
  try {
    html = await getPage('/diziler.asp?' + params.toString());
  } catch (e) {
    return { items: [], hasMore: false, total: -1, debug: 'bağlantı: ' + String((e && e.message) || e).slice(0, 150) };
  }
  var items = readCards(html);
  var how = 'afiş ' + items.length + ' · kutular: ' + selectSummary(html);
  if (!items.length) { items = readLinks(html); how += ' · yedek ' + items.length; }
  var next = String((page || 1) + 1);
  var hasMore = new RegExp('[?&;]s=' + next + '(?![0-9])').test(html.replace(/&amp;/g, '&'));
  var total = -1;
  var tm = /([0-9][0-9.]*)\s*(?:adet\s*)?dizi\s*(?:bulundu|listelendi)/i.exec(plain(html));
  if (tm) total = parseInt(tm[1].replace(/\./g, ''), 10);
  // Afiş geldiyse kısa satır (uygulama satırı 300 harfte keser; kutu adları sona sığsın).
  var debug = items.length ? 'kod ' + last.status + ' · ' + (last.cf ? last.cf + ' · ' : '') + how : debugLine(how);
  return { items: items, hasMore: hasMore || items.length >= 50, total: total, debug: debug };
}

module.exports = { getFilters: getFilters, getCatalog: getCatalog };
