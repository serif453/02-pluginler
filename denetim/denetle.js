/*
 * Katalog pluginlerinin günlük denetimi (2026-11-24). Her plugini gerçek siteye karşı uygulamadaki gibi çalıştırır:
 * filtreler, 1. ve 2. sayfa, her sıralama ve afişlerden bir örnek (uygulamadaki gibi tarayıcı adıyla indirilir).
 * Eşikler denetim/esikler.json'da. Bir eşik tutmazsa çıkış kodu 1 olur, GitHub da depo sahibine e-posta atar.
 *
 * Çalıştırma: node denetim/denetle.js            (hepsi)
 *             node denetim/denetle.js dizilla    (yalnızca biri)
 */
'use strict';
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var BROWSER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
var TIMEOUT_MS = 30000;
var POSTER_SAMPLE = 12;

// Uygulamanın köprüsü gibi: pluginin kendi User-Agent'ı yoksa tarayıcı adı; her istek en çok 30 sn.
var nativeFetch = globalThis.fetch;
globalThis.fetch = function (url, options) {
  options = Object.assign({}, options || {});
  var headers = new Headers(options.headers || {});
  if (!headers.has('user-agent')) headers.set('User-Agent', BROWSER_AGENT);
  options.headers = headers;
  if (!options.signal) options.signal = AbortSignal.timeout(TIMEOUT_MS);
  return nativeFetch(url, options);
};

var manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
var limits = JSON.parse(fs.readFileSync(path.join(__dirname, 'esikler.json'), 'utf8'));
var only = process.argv[2];

async function posterOk(url) {
  try {
    var res = await nativeFetch(url, { headers: { 'User-Agent': BROWSER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    var type = res.headers.get('content-type') || '';
    await res.arrayBuffer();
    return res.ok && /^image\//i.test(type);
  } catch (e) {
    return false;
  }
}

async function check(scraper) {
  var rules = Object.assign({}, limits.varsayilan, limits[scraper.id] || {});
  var rows = [];   // [ad, sonuç, tamam mı]
  function row(name, value, ok) { rows.push([name, String(value), ok]); }

  var plugin = require(path.join(ROOT, scraper.filename));

  var spec;
  try { spec = await plugin.getFilters(); } catch (e) { row('Filtreler', 'hata: ' + e.message, false); return rows; }
  var filters = (spec && spec.filters) || [];
  row('Filtre sayısı', filters.length, filters.length >= rules.enAzFiltre);
  Object.keys(rules.secenek || {}).forEach(function (id) {
    var f = filters.filter(function (x) { return x.id === id; })[0];
    var n = f && f.options ? f.options.length : 0;
    row('Seçenek: ' + id, n, n >= rules.secenek[id]);
  });
  var sorts = (spec && spec.sorts) || [];
  if (rules.enAzSiralama) row('Sıralama sayısı', sorts.length, sorts.length >= rules.enAzSiralama);

  var first;
  try { first = await plugin.getCatalog({ values: {} }, 1); } catch (e) { row('1. sayfa', 'hata: ' + e.message, false); return rows; }
  var items = (first && first.items) || [];
  // Site Cloudflare kontrolü istiyorsa (uygulama görünmez pencereyle geçer, burada geçilemez) sorun sayılmaz, yalnızca not düşülür.
  if (!items.length && rules.cloudflareAtla && /just a moment|cloudflare/i.test((first && first.debug) || '')) {
    row('Cloudflare', 'site kontrol istiyor, buradan denetlenemedi', 'atla');
    return rows;
  }
  row('1. sayfa afiş', items.length + (first.debug ? ' (' + first.debug.slice(0, 120) + ')' : ''), items.length >= rules.enAzAfis);
  row('Toplam sonuç', first.total, first.total !== 0);

  var posters = items.map(function (i) { return i.poster; }).filter(Boolean);
  row('Resimli afiş', posters.length + ' / ' + items.length, items.length > 0 && posters.length / items.length >= rules.acilanAfisOrani);
  var sample = posters.slice(0, POSTER_SAMPLE);
  var opened = 0;
  for (var i = 0; i < sample.length; i++) if (await posterOk(sample[i])) opened++;
  row('Açılan afiş (örnek)', opened + ' / ' + sample.length, sample.length > 0 && opened / sample.length >= rules.acilanAfisOrani);

  if (first.hasMore) {
    try {
      var second = await plugin.getCatalog({ values: {} }, 2);
      var keys = {};
      items.forEach(function (x) { keys[x.title + '|' + x.year] = true; });
      var fresh = ((second && second.items) || []).filter(function (x) { return !keys[x.title + '|' + x.year]; });
      row('2. sayfada yeni afiş', fresh.length, fresh.length > 0);
    } catch (e) {
      row('2. sayfa', 'hata: ' + e.message, false);
    }
  }

  for (var s = 0; s < sorts.length; s++) {
    try {
      var sorted = await plugin.getCatalog({ values: {}, sort: sorts[s].value }, 1);
      var n = ((sorted && sorted.items) || []).length;
      row('Sıralama: ' + sorts[s].label, n, n >= rules.enAzAfis);
    } catch (e) {
      row('Sıralama: ' + sorts[s].label, 'hata: ' + e.message, false);
    }
  }
  return rows;
}

(async function () {
  var scrapers = manifest.scrapers.filter(function (s) {
    return s.enabled !== false && (s.supportedTypes || []).indexOf('catalog') >= 0 && (!only || s.id === only);
  });
  var failed = 0;
  var report = ['# Plugin denetimi', '', new Date().toISOString(), ''];
  for (var k = 0; k < scrapers.length; k++) {
    var sc = scrapers[k];
    var rows;
    try { rows = await check(sc); } catch (e) { rows = [['Çalıştırma', 'hata: ' + e.message, false]]; }
    var bad = rows.filter(function (r) { return !r[2]; }).length;
    var skipped = rows.some(function (r) { return r[2] === 'atla'; });
    failed += bad;
    report.push('## ' + sc.name + ' ' + sc.version + (bad ? ' — ' + bad + ' sorun' : skipped ? ' — denetlenemedi' : ' — tamam'), '', '| Kontrol | Sonuç | |', '|---|---|---|');
    rows.forEach(function (r) { report.push('| ' + r[0] + ' | ' + r[1].replace(/\|/g, '/') + ' | ' + (r[2] === 'atla' ? '⚠️' : r[2] ? '✅' : '❌') + ' |'); });
    report.push('');
  }
  var text = report.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  process.exit(failed ? 1 : 0);
})();
