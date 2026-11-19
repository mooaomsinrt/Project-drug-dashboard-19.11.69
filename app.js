const el = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('th-TH', { maximumFractionDigits: 4 });
const percent = new Intl.NumberFormat('th-TH', { style: 'percent', maximumFractionDigits: 1 });
const thaiDate = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const thaiTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
const narrow = matchMedia('(max-width: 820px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const normalize = (value) => String(value ?? '').normalize('NFKC').trim().toLowerCase();
const units = new Map([['tablet', 'เม็ด'], ['capsule', 'แคปซูล'], ['bottle', 'ขวด'], ['tube', 'หลอด'], ['sachet', 'ซอง'], ['inhaler', 'อัน']]);
const statusLabels = new Map([['active', 'ใช้งาน'], ['written_off', 'ตัดออก'], ['quarantine', 'กักกัน'], ['dispense', 'จ่ายยา'], ['void', 'ยกเลิก']]);
const kindLabels = { catalog: 'ทะเบียนยา', stock: 'สต็อก', events: 'ประวัติการจ่าย' };
const expected = {
  catalog: ['sku', 'generic_name', 'strength', 'dosage_form', 'unit', 'category', 'atc_code'],
  stock: ['sku', 'stock_id', 'lot', 'status'],
  events: ['sku', 'dispense_id', 'lot', 'datetime', 'type'],
};
const ids = { catalog: 'sku', stock: 'stock_id', events: 'dispense_id' };
const tables = {
  catalog: ['ชื่อสามัญ / SKU', 'ความแรง', 'รูปแบบยา', 'หมวดหมู่', 'ATC', 'จุดสั่งซื้อซ้ำ'],
  stock: ['ยา / SKU', 'ล็อต', 'หมดอายุ', 'คงเหลือ', 'สถานะ'],
  events: ['ยา / SKU', 'รหัสรายการ / วันเวลา (ไทย)', 'ล็อต', 'จำนวน', 'ประเภท'],
};
let datasets = {};
let model = {};
let view = 'catalog';
let page = 1;
let issueFilter = '';
let syncChart = () => {};
let chartObserver;
let generation = 0;
const pageSize = 12;
const metricAnimations = new Map();

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dayLabel(value) {
  return validDate(value) ? thaiDate.format(new Date(value + 'T00:00:00Z')) : 'ไม่ระบุ';
}

function eventTime(value) {
  return validDate(value.slice(0, 10)) && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
}

function parseDataset(raw, name) {
  const doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (!Array.isArray(doc?.items)) throw Error('ต้องมี items เป็นรายการข้อมูล');
  const first = doc.items[0];
  const file = name.toLowerCase();
  const kind = first?.stock_id !== undefined || /stock/.test(file) ? 'stock'
    : first?.dispense_id !== undefined || /dispense/.test(file) ? 'events'
    : first?.generic_name !== undefined || /drugs/.test(file) ? 'catalog' : '';
  if (!kind) throw Error('ระบุประเภทไฟล์ไม่ได้');
  const seen = new Set();
  for (const [i, row] of doc.items.entries()) {
    const invalid = expected[kind].find((key) => typeof row?.[key] !== 'string' || !row[key].trim());
    if (invalid) throw Error(`รายการ ${i + 1} ขาด ${invalid}`);
    const identity = kind === 'catalog' ? normalize(row[ids[kind]]) : row[ids[kind]];
    if (seen.has(identity)) throw Error(`พบ ${ids[kind]} ซ้ำที่รายการ ${i + 1}`);
    seen.add(identity);
    const quantityKey = { catalog: 'reorder_level', stock: 'qty_on_hand', events: 'qty' }[kind];
    if (!Number.isFinite(row[quantityKey])) throw Error(`รายการ ${i + 1} มี ${quantityKey} ที่ไม่ใช่ตัวเลข`);
    if (kind === 'catalog' && (!Number.isSafeInteger(row.reorder_level) || row.reorder_level < 0)) {
      throw Error(`รายการ ${i + 1} มีจุดสั่งซื้อซ้ำไม่ถูกต้อง`);
    }
  }
  return { kind, name, items: doc.items, meta: doc.meta ?? {} };
}

const lotKey = (row) => JSON.stringify([normalize(row.sku), row.lot]);

function buildModel() {
  const catalog = datasets.catalog?.items ?? [];
  const materials = new Map(catalog.map((product) => [normalize(product.sku), product]));
  const stock = datasets.stock?.items ?? [];
  const lots = new Map();
  for (const row of stock) {
    const key = lotKey(row);
    const matches = lots.get(key) ?? [];
    matches.push(row);
    lots.set(key, matches);
  }
  const snapshot = datasets.stock?.meta.as_of;
  const period = String(datasets.events?.meta.period ?? '').match(/\d{4}-\d{2}-\d{2}/g) ?? [];
  const result = {
    snapshot,
    catalog: catalog.map((row) => ({ row, product: row, issues: [] })),
    stock: stock.map((row) => {
      const issues = [];
      const product = materials.get(normalize(row.sku));
      if (datasets.catalog && !product) issues.push('unknown-sku');
      if (lots.get(lotKey(row)).length > 1) issues.push('ambiguous-lot');
      if (!validDate(row.expiry)) issues.push('missing-expiry');
      else if (validDate(snapshot) && row.expiry < snapshot && row.qty_on_hand > 0) issues.push('expired-stock');
      if (row.qty_on_hand < 0) issues.push('negative-stock');
      return { row, product, issues };
    }),
    events: (datasets.events?.items ?? []).map((row) => {
      const issues = [];
      const product = materials.get(normalize(row.sku));
      const matches = lots.get(lotKey(row)) ?? [];
      const [lot] = matches;
      const timestamp = eventTime(row.datetime);
      if (datasets.catalog && !product) issues.push('unknown-sku');
      if (datasets.stock && !matches.length) issues.push('missing-lot');
      if (matches.length > 1) issues.push('ambiguous-lot');
      if (!Number.isFinite(timestamp)) issues.push('invalid-time');
      else {
        const eventDate = new Date(timestamp + 7 * 3600000).toISOString().slice(0, 10);
        if (period.length === 2 && (eventDate < period[0] || eventDate > period[1])) issues.push('outside-period');
        if (row.type === 'dispense' && matches.length === 1 && validDate(lot.expiry) && eventDate > lot.expiry) {
          issues.push('after-expiry');
        }
      }
      if (row.type === 'dispense' && !Number.isInteger(row.qty)) issues.push('fractional-qty');
      if (row.type === 'dispense' && row.qty <= 0) issues.push('nonpositive-issue');
      return { row, product, issues };
    }),
  };
  return result;
}

const issueLabels = {
  'unknown-sku': 'SKU ไม่พบในทะเบียน', 'ambiguous-lot': 'คู่ SKU และล็อตซ้ำ',
  'missing-expiry': 'วันหมดอายุขาดหรือไม่ถูกต้อง', 'expired-stock': 'ล็อตหมดอายุที่ยังมียอด',
  'negative-stock': 'ยอดติดลบ', 'missing-lot': 'หาล็อตในไฟล์สต็อกไม่พบ', 'invalid-time': 'วันเวลาไม่ถูกต้อง',
  'outside-period': 'วันที่อยู่นอกช่วงที่ระบุ', 'after-expiry': 'วันที่จ่ายหลังวันหมดอายุ',
  'fractional-qty': 'จำนวนจ่ายเป็นทศนิยม', 'nonpositive-issue': 'จำนวนจ่ายไม่มากกว่า 0',
};

function statusOf(row) {
  return view === 'stock' ? row.status : view === 'events' ? row.type : '';
}

function quantity(value, product) {
  return [number.format(value), units.get(product?.unit) ?? product?.unit].filter(Boolean).join(' ');
}

function cells({ row, product, issues }) {
  const name = product?.generic_name ?? row.sku;
  const identity = name === row.sku ? name : `${name} · ${row.sku}`;
  const alerts = issues.map((issue) => issueLabels[issue]).join(' · ');
  if (view === 'catalog') {
    return { values: [identity, row.strength, row.dosage_form, row.category, row.atc_code, quantity(row.reorder_level, product)],
      summary: name, subtitle: `${row.sku} · ${row.strength}`, alerts };
  }
  if (view === 'stock') {
    return { values: [identity, row.lot, dayLabel(row.expiry), quantity(row.qty_on_hand, product), statusLabels.get(row.status) ?? row.status],
      summary: name, subtitle: `${row.lot} · ${quantity(row.qty_on_hand, product)}`, alerts };
  }
  const dateTime = eventTime(row.datetime);
  const time = Number.isFinite(dateTime) ? thaiTime.format(new Date(dateTime)) : 'ไม่ระบุ';
  return { values: [identity, `${row.dispense_id} · ${time}`, row.lot, quantity(row.qty, product), statusLabels.get(row.type) ?? row.type],
    summary: name, subtitle: `${row.dispense_id} · ${time}`, alerts };
}

function makeTableRow(item) {
  const row = node('tr');
  const { values, alerts } = cells(item);
  values.forEach((value, index) => {
    const cell = node('td', value);
    if (view === 'catalog' && index === 4) cell.classList.add('row-code');
    if (index === 0 && alerts) cell.append(node('span', alerts, 'row-issue'));
    row.append(cell);
  });
  return row;
}

function makeMobileRow(item) {
  const row = node('li');
  const details = node('details');
  const { values, summary, subtitle, alerts } = cells(item);
  const title = node('summary', summary);
  title.append(node('small', subtitle));
  if (alerts) title.append(node('span', alerts, 'row-issue'));
  const body = node('dl');
  values.slice(1).forEach((value, i) => {
    const group = node('div');
    group.append(node('dt', tables[view][i + 1]), node('dd', value));
    body.append(group);
  });
  details.append(title, body);
  row.append(details);
  return row;
}

function renderRecords() {
  const query = normalize(el('search').value);
  const category = el('category').value;
  const status = el('status').value;
  const matches = model[view].filter(({ row, product, issues }) => (
    (!category || product?.category === category)
    && (!status || statusOf(row) === status)
    && (!issueFilter || issues.includes(issueFilter))
    && (!query || [row.sku, row.lot, row.dispense_id, row.stock_id, product?.atc_code, product?.generic_name]
      .some((value) => normalize(value).includes(query)))
  ));
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  page = Math.min(page, pages);
  const start = (page - 1) * pageSize;
  const visible = matches.slice(start, start + pageSize);
  const header = node('tr');
  for (const label of tables[view]) {
    const cell = node('th', label);
    cell.scope = 'col';
    header.append(cell);
  }
  el('table-head').replaceChildren(header);
  el('table-region').hidden = narrow.matches || !visible.length;
  el('mobile-records').hidden = !narrow.matches || !visible.length;
  el('table-body').replaceChildren(...(narrow.matches ? [] : visible.map(makeTableRow)));
  el('mobile-records').replaceChildren(...(narrow.matches ? visible.map(makeMobileRow) : []));
  el('empty-records').hidden = !!matches.length;
  el('empty-records').textContent = 'ไม่พบรายการที่ตรงกับตัวกรอง';
  const count = matches.length
    ? `แสดง ${number.format(start + 1)}–${number.format(start + visible.length)} จาก ${number.format(matches.length)} รายการ`
    : 'พบ 0 รายการ';
  el('result-count').textContent = issueFilter ? `${issueLabels[issueFilter]} · ${count}` : count;
  el('page-number').textContent = `${page} / ${pages}`;
  el('previous').disabled = page === 1;
  el('next').disabled = page >= pages;
  el('pagination').hidden = !matches.length;
  syncChart(category);
}

function setView(name, issue = '') {
  view = name;
  issueFilter = issue;
  page = 1;
  for (const button of el('view-choices').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === name));
    button.disabled = !datasets[button.dataset.view];
  }
  for (const button of el('source-shortcuts').querySelectorAll('button')) {
    button.setAttribute('aria-current', String(button.dataset.source === name));
  }
  const statuses = [...new Set(model[view].map(({ row }) => statusOf(row)).filter(Boolean))];
  el('status').replaceChildren(new Option('ทุกสถานะ', ''), ...statuses.map((value) => new Option(statusLabels.get(value) ?? value, value)));
  el('status-field').hidden = !statuses.length;
  const notes = {
    catalog: datasets.catalog?.meta.version ? `ทะเบียนยาเวอร์ชัน ${datasets.catalog.meta.version}` : 'รายการอ้างอิงตาม SKU',
    stock: `ยอดคงเหลือ ณ ${dayLabel(model.snapshot)} ตามไฟล์สต็อก`,
    events: `จ่ายยา ${number.format(model.events.filter(({ row }) => row.type === 'dispense').length)} · ยกเลิก ${number.format(model.events.filter(({ row }) => row.type === 'void').length)} เหตุการณ์`,
  };
  el('view-note').textContent = notes[view];
  renderRecords();
}

function renderChecks() {
  const buttons = [];
  for (const kind of ['stock', 'events']) {
    const counts = new Map();
    for (const { issues } of model[kind]) {
      for (const issue of issues) counts.set(issue, (counts.get(issue) ?? 0) + 1);
    }
    for (const [issue, count] of counts) {
      const button = node('button', `${issueLabels[issue]} · ${kindLabels[kind]}`);
      button.type = 'button';
      button.prepend(node('strong', number.format(count)));
      button.addEventListener('click', () => {
        el('search').value = el('category').value = '';
        setView(kind, issue);
        el('result-count').focus();
      });
      buttons.push(button);
    }
  }
  el('check-list').replaceChildren(...(buttons.length ? buttons : [node('p', 'ยังไม่มีรายการที่ต้องตรวจสอบจากไฟล์ที่โหลด')]));
  const shortcut = el('review-shortcut');
  shortcut.hidden = !buttons.length;
  shortcut.textContent = buttons.length ? `ดู ${number.format(buttons.length)} ประเภทที่ควรตรวจ` : '';
}

function mountCharts() {
  chartObserver?.disconnect();
  const chart = el('bars');
  const ring = el('ring');
  chart.replaceChildren();
  for (const target of [ring, chart]) target.classList.remove('animate');
  const categories = new Map();
  for (const { row } of model.catalog) categories.set(row.category, (categories.get(row.category) ?? 0) + 1);
  const ranked = [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'th'));
  const palette = ['#003c33', '#347d6c', '#ff7759', '#1863dc', '#a2629d', '#bc8029', '#667ca6', '#668449',
    '#b14f63', '#347981', '#969558', '#88663c', '#5260a6', '#e88d60', '#447b96', '#8f8466'];
  const total = model.catalog.length;
  let end = 0;
  let hovered = '';
  let selected = '';
  const slices = ranked.map(([label, count], index) => {
    const start = end;
    end += 360 * count / total;
    return { label, count, start, end, color: palette[index % palette.length] };
  });
  const buttons = new Map();
  el('replay').hidden = !total;
  el('chart-note').textContent = total ? 'เลือกหมวดจากวงแหวนหรือกราฟแท่งเพื่อกรองรายการ' : 'โหลดทะเบียนยาเพื่อดูกราฟตามหมวด';
  ring.style.removeProperty('--slices');

  function draw() {
    const current = slices.find(({ label }) => label === (hovered || selected));
    el('ring-number').textContent = total ? number.format(current?.count ?? total) : '—';
    el('ring-unit').textContent = current ? percent.format(current.count / total) : 'SKU';
    el('ring-caption').textContent = current ? current.label : total ? `รวม ${number.format(slices.length)} หมวด` : 'ยังไม่มีทะเบียนยา';
    if (!total) return;
    const spans = slices.flatMap((slice) => {
      const stop = slice.end - Math.min(.75, (slice.end - slice.start) * .12);
      const color = current && current !== slice ? slice.color + '60' : slice.color;
      return [`${color} ${slice.start}deg ${stop}deg`, `white ${stop}deg ${slice.end}deg`];
    });
    ring.style.setProperty('--slices', `conic-gradient(${spans.join(',')})`);
  }

  function choose(label) {
    hovered = '';
    el('category').value = el('category').value === label ? '' : label;
    page = 1;
    renderRecords();
  }

  function hit(event) {
    const box = ring.getBoundingClientRect();
    const x = event.clientX - box.left - box.width / 2;
    const y = event.clientY - box.top - box.height / 2;
    const radius = Math.hypot(x, y) / (box.width / 2);
    const angle = (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360;
    return radius >= .64 && radius <= 1
      ? slices.find((slice) => angle >= slice.start && angle < slice.end)?.label : '';
  }

  ring.onclick = (event) => { const label = hit(event); if (label) choose(label); };
  ring.onpointermove = (event) => {
    if (event.pointerType !== 'mouse') return;
    const label = hit(event) ?? '';
    ring.style.cursor = label ? 'pointer' : '';
    if (hovered !== label) { hovered = label; draw(); }
  };
  ring.onpointerleave = () => { hovered = ''; draw(); };
  slices.forEach(({ label, color, count }, index) => {
    const button = node('button', undefined, 'bar');
    button.type = 'button';
    button.setAttribute('aria-label', `${label} ${number.format(count)} SKU (${percent.format(count / total)})`);
    button.style.setProperty('--color', color);
    button.style.setProperty('--delay', `${Math.min(index * 36, 450)}ms`);
    const heading = node('span', undefined, 'bar-label');
    heading.append(node('span', label), node('strong', number.format(count), 'mono'));
    const track = node('span', undefined, 'bar-track');
    track.setAttribute('aria-hidden', 'true');
    const fill = node('span', undefined, 'bar-fill');
    fill.style.width = `${count / slices[0].count * 100}%`;
    track.append(fill);
    button.append(heading, track);
    button.addEventListener('click', () => choose(label));
    button.addEventListener('pointerenter', (event) => {
      if (event.pointerType === 'mouse') { hovered = label; draw(); }
    });
    button.addEventListener('pointerleave', () => { hovered = ''; draw(); });
    buttons.set(label, button);
    chart.append(button);
  });

  chartObserver = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting) { target.classList.add('animate'); chartObserver.unobserve(target); }
    }
  }, { threshold: .12 });
  for (const target of [ring, chart]) if (total) chartObserver.observe(target);
  el('replay').onclick = () => {
    for (const target of [ring, chart]) {
      chartObserver.unobserve(target);
      target.classList.remove('animate');
      void target.offsetWidth;
      target.classList.add('animate');
    }
  };
  draw();
  return (category) => {
    selected = category;
    for (const [label, button] of buttons) button.setAttribute('aria-pressed', String(label === category));
    draw();
  };
}

function setMetric(id, value) {
  const metric = el(id);
  const display = metric.firstElementChild;
  const finalText = value === undefined ? '—' : number.format(value);
  metric.lastElementChild.textContent = finalText;
  const pending = metricAnimations.get(id);
  if (pending) {
    cancelAnimationFrame(pending.frame);
    clearTimeout(pending.timer);
    metricAnimations.delete(id);
  }
  const previous = Number(display.dataset.count || 0);
  if (value === undefined || previous === value || reducedMotion.matches || document.hidden) {
    display.textContent = finalText;
    display.dataset.count = value ?? 0;
    return;
  }
  const start = performance.now();
  const animation = {};
  const finish = () => {
    cancelAnimationFrame(animation.frame);
    clearTimeout(animation.timer);
    display.textContent = finalText;
    display.dataset.count = value;
    metricAnimations.delete(id);
  };
  const draw = (now) => {
    const progress = Math.min(1, Math.max(0, (now - start) / 700));
    const count = Math.round(previous + (value - previous) * (1 - (1 - progress) ** 3));
    display.textContent = number.format(count);
    display.dataset.count = count;
    if (progress < 1) animation.frame = requestAnimationFrame(draw);
    else finish();
  };
  animation.frame = requestAnimationFrame(draw);
  animation.timer = setTimeout(finish, 800);
  metricAnimations.set(id, animation);
}

function showData() {
  model = buildModel();
  const categories = [...new Set(model.catalog.map(({ row }) => row.category))].sort((a, b) => a.localeCompare(b, 'th'));
  for (const [id, value] of [
    ['metric-skus', datasets.catalog && model.catalog.length],
    ['metric-categories', datasets.catalog && categories.length],
    ['metric-lots', datasets.stock && model.stock.length],
    ['metric-events', datasets.events && model.events.length],
  ]) setMetric(id, value);
  el('snapshot').textContent = datasets.stock
    ? `สต็อก ณ ${dayLabel(model.snapshot)} · ประวัติการจ่ายแสดงแยก`
    : 'เพิ่มไฟล์สต็อกเพื่อดูยอดคงเหลือตามวันที่ในไฟล์';
  el('sources').replaceChildren(...Object.values(datasets).map(({ name, items }) =>
    node('li', `${name} · ${number.format(items.length)} รายการ`)));
  el('sources').hidden = false;
  const count = Object.keys(datasets).length;
  el('source-status').textContent = `โหลดแล้ว ${number.format(count)} / 3 ประเภท`;
  el('source-status').parentElement.classList.toggle('is-ready', count > 0);
  for (const button of el('source-shortcuts').querySelectorAll('button')) {
    button.disabled = !datasets[button.dataset.source];
  }
  el('category').replaceChildren(new Option('ทุกหมวด', ''), ...categories.map((name) => new Option(name, name)));
  el('category').disabled = !categories.length;
  el('search').value = '';
  el('dashboard').hidden = el('navigation').hidden = false;
  syncChart = mountCharts();
  setView(datasets[view] ? view : Object.keys(datasets)[0]);
  renderChecks();
}

async function load(sources, replace = false) {
  const attempt = ++generation;
  el('load-error').hidden = true;
  el('load-status').textContent = 'กำลังอ่านไฟล์ JSON…';
  try {
    const files = await Promise.all(sources.map(async ({ name, read }) => {
      try { return parseDataset(await read(), name); } catch (error) { throw Error(`${name} · ${error.message}`); }
    }));
    const incoming = {};
    for (const data of files) {
      const existing = incoming[data.kind];
      if (existing) {
        if (data.kind !== 'catalog') throw Error(`เลือกไฟล์${kindLabels[data.kind]}ครั้งละหนึ่งไฟล์`);
        if (existing.items.length > data.items.length) continue;
      }
      incoming[data.kind] = data;
    }
    if (generation !== attempt) return;
    datasets = replace ? incoming : { ...datasets, ...incoming };
    showData();
    el('load-status').textContent = 'โหลดไฟล์แล้ว';
  } catch (error) {
    if (generation !== attempt) return;
    el('load-error').textContent = error.message;
    el('load-error').hidden = false;
    el('load-status').textContent = '';
  }
}

function loadDemo() {
  return load(['drugs_update.json', 'stock.json', 'dispense-log.json'].map((name) => ({
    name,
    read: async () => {
      const response = await fetch(`./data/${name}`);
      if (!response.ok) throw Error(`โหลดไม่ได้ (HTTP ${response.status})`);
      return response.text();
    },
  })), true);
}

function loadLocalFiles(files) {
  if (files.length) load(files.map((file) => ({
    name: file.name,
    read: () => file.size <= 10_000_000 ? file.text() : Promise.reject(Error('ไฟล์ใหญ่เกิน 10 MB')),
  })));
}

el('file-input').addEventListener('change', (event) => {
  const files = Array.from(event.target.files);
  event.target.value = '';
  loadLocalFiles(files);
});

const dropZone = el('drop-zone');
let dragDepth = 0;
function setDragging(active) {
  dropZone.classList.toggle('is-dragging', active);
  el('drop-title').textContent = active ? 'วางไฟล์เพื่อโหลดข้อมูล' : 'ลากไฟล์ JSON มาวาง';
}

dropZone.addEventListener('dragenter', (event) => {
  if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  setDragging(true);
});
dropZone.addEventListener('dragover', (event) => {
  if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});
dropZone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) setDragging(false);
});
dropZone.addEventListener('drop', (event) => {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length) event.preventDefault();
  dragDepth = 0;
  setDragging(false);
  loadLocalFiles(files);
});
el('source-shortcuts').addEventListener('click', (event) => {
  const name = event.target.dataset.source;
  if (!name || !datasets[name]) return;
  el('search').value = el('category').value = '';
  setView(name);
  el('result-count').focus();
});
el('load-demo').addEventListener('click', loadDemo);
el('view-choices').addEventListener('click', (event) => {
  const name = event.target.dataset.view;
  if (name && datasets[name]) setView(name);
});
el('filters').addEventListener('submit', (event) => event.preventDefault());
el('filters').addEventListener('reset', (event) => {
  event.preventDefault();
  el('search').value = el('category').value = el('status').value = '';
  issueFilter = '';
  page = 1;
  renderRecords();
  el('search').focus();
});
for (const [id, event] of [['search', 'input'], ['category', 'change'], ['status', 'change']]) {
  el(id).addEventListener(event, () => { page = 1; renderRecords(); });
}
el('previous').addEventListener('click', () => { page -= 1; renderRecords(); });
el('next').addEventListener('click', () => { page += 1; renderRecords(); });
narrow.addEventListener('change', () => { if (model[view]) renderRecords(); });
if (location.protocol === 'http:' || location.protocol === 'https:') {
  el('load-demo').hidden = false;
  loadDemo();
} else {
  el('load-status').textContent = 'เลือกทะเบียนยา สต็อก และประวัติการจ่ายพร้อมกันหรือทีละไฟล์จากโฟลเดอร์ data';
}
