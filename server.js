// Низоми давомот ва хориҷшавии донишҷуён — танҳо бо модулҳои дарунсохти Node.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DB_FILE = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = ['Бо хоҳиши худ', 'Интиқол ба донишгоҳи дигар', 'Ихроҷ (қарзи академӣ)', 'Сабабҳои оилавӣ/саломатӣ'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };
const uuid = () => crypto.randomUUID();
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const wday = (date) => new Date(date + 'T00:00:00').getDay(); // 0=Яш ... 6=Шб
const DEFAULT_SCHEDULE = () => ({ days: [1, 3, 5], start: '08:30', end: '10:00' });
function parseSchedule(b) {
  const days = [...new Set((Array.isArray(b.days) ? b.days : [b.days]).map(Number))].filter((d) => d >= 1 && d <= 6).sort();
  const ok = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
  return days.length && ok(b.start) && ok(b.end) && b.start < b.end ? { days, start: b.start, end: b.end } : null;
}

// ---------- Паролҳо ва сессияҳо ----------
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
function mkUser(username, password, role, fullName, extra = {}) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { id: uuid(), username, salt, hash: hashPw(password, salt), role, fullName, ...extra };
}
function checkPw(user, password) {
  const a = Buffer.from(hashPw(String(password), user.salt), 'hex'), b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPw(u, pw) { u.salt = crypto.randomBytes(16).toString('hex'); u.hash = hashPw(pw, u.salt); }
const sessions = new Map();
const dropSessions = (id) => { for (const [t, s] of sessions) if (s.userId === id) sessions.delete(t); }; // token -> { userId, exp }
const SESSION_MS = 12 * 3600 * 1000;

// ---------- Пойгоҳи додаҳо ----------
function seed() {
  const admin = mkUser('admin', ADMIN_PASSWORD, 'admin', 'Администратор');
  const t1 = mkUser('karimov', 'teacher123', 'teacher', 'Каримов Анвар');
  const t2 = mkUser('nazarova', 'teacher123', 'teacher', 'Назарова Ситора');
  const subjects = [
    { id: uuid(), name: 'Барномасозӣ', teacherId: t1.id, schedule: { days: [1, 3, 5], start: '08:30', end: '10:00' } },
    { id: uuid(), name: 'Математика', teacherId: t2.id, schedule: { days: [2, 4, 6], start: '10:10', end: '11:40' } },
  ];
  const list = [['Рустамов Фарҳод', 'ИТ-21', 3, 'rustamov'], ['Саидова Нигина', 'ИТ-22', 2, 'saidova'], ['Қосимов Беҳрӯз', 'ИҚ-20', 4, 'kosimov']];
  const students = [], users = [admin, t1, t2], attendance = [];
  list.forEach(([fullName, group, course, login]) => {
    const s = { id: uuid(), fullName, group, course, status: 'фаъол' };
    students.push(s);
    users.push(mkUser(login, 'student123', 'student', fullName, { studentId: s.id }));
  });
  for (let d = 1; d <= 28; d++) {
    const date = localDate(new Date(Date.now() - d * 864e5));
    subjects.forEach((sub, si) => {
      if (!sub.schedule.days.includes(wday(date))) return;
      students.forEach((s, i) => {
        const absent = (i + d + si) % 5 === 0;
        attendance.push({ subjectId: sub.id, studentId: s.id, date, status: absent ? 'ғоиб' : 'ҳозир', score: absent ? null : 60 + ((i * 7 + d * 3 + si * 5) % 41) });
      });
    });
  }
  const db = { version: 3, users, students, subjects, attendance, withdrawals: [] };
  save(db);
  return db;
}
function load() {
  try {
    const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (db.version === 3) return db;
    if (db.version === 2) { db.version = 3; db.subjects.forEach((s) => (s.schedule = s.schedule || DEFAULT_SCHEDULE())); save(db); return db; }
    fs.renameSync(DB_FILE, DB_FILE.replace('db.json', 'db.old.json'));
  } catch {}
  return seed();
}
function save(db) {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- Кумакрасонҳо ----------
const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 2e5) { reject(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('json')); } });
  });
}
const clean = (s, max = 500) => String(s ?? '').trim().slice(0, max);
const pub = (u) => ({ id: u.id, role: u.role, fullName: u.fullName, username: u.username, studentId: u.studentId || null });
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d));
const pct = (p, t) => (t ? Math.round((p / t) * 100) : null);
function auth(req, db) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const s = sessions.get(token);
  if (!s || s.exp < Date.now()) { sessions.delete(token); return null; }
  return db.users.find((u) => u.id === s.userId) || null;
}
function validateAccount(db, b) {
  const username = clean(b.username, 30), password = String(b.password || ''), fullName = clean(b.fullName, 100);
  if (fullName.length < 3) return 'Ному насабро дуруст ворид кунед';
  if (!/^[a-zA-Z0-9._-]{3,30}$/.test(username)) return 'Логин: 3–30 аломат (ҳарфи лотинӣ, рақам, . _ -)';
  if (password.length < 6) return 'Парол бояд камаш 6 аломат бошад';
  if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) return 'Ин логин аллакай гирифта шудааст';
  return null;
}

// ---------- API ----------
async function api(req, res, url, q) {
  const db = load();
  const m = req.method;

  if (m === 'POST' && url === '/api/login') {
    const b = await readBody(req);
    const u = db.users.find((x) => x.username.toLowerCase() === clean(b.username, 30).toLowerCase());
    if (!u || !checkPw(u, b.password)) return send(res, 401, { error: 'Логин ё парол нодуруст аст' });
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { userId: u.id, exp: Date.now() + SESSION_MS });
    return send(res, 200, { token, user: pub(u) });
  }

  const user = auth(req, db);
  if (!user) return send(res, 401, { error: 'Лутфан ворид шавед' });
  const need = (...roles) => roles.includes(user.role) || (send(res, 403, { error: 'Дастрасӣ манъ аст' }), false);
  const ownSubject = () => db.subjects.find((s) => s.teacherId === user.id);

  if (m === 'POST' && url === '/api/logout') { sessions.delete((req.headers.authorization || '').replace('Bearer ', '')); return send(res, 200, { ok: true }); }
  if (m === 'GET' && url === '/api/me') return send(res, 200, { user: pub(user), types: TYPES });

  // --- Фанҳо ---
  if (m === 'GET' && url === '/api/subjects') {
    if (!need('admin', 'teacher')) return;
    const list = user.role === 'admin' ? db.subjects : db.subjects.filter((s) => s.teacherId === user.id);
    return send(res, 200, list.map((s) => ({ ...s, teacher: db.users.find((u) => u.id === s.teacherId)?.fullName })));
  }

  // --- Омӯзгорон (админ) ---
  if (m === 'GET' && url === '/api/teachers') {
    if (!need('admin')) return;
    return send(res, 200, db.users.filter((u) => u.role === 'teacher').map((t) => { const sb = db.subjects.find((s) => s.teacherId === t.id); return { ...pub(t), subject: sb?.name || '', subjectId: sb?.id, schedule: sb?.schedule }; }));
  }
  if (m === 'POST' && url === '/api/teachers') {
    if (!need('admin')) return;
    const b = await readBody(req), err = validateAccount(db, b), subjectName = clean(b.subjectName, 80);
    if (err) return send(res, 400, { error: err });
    if (subjectName.length < 2) return send(res, 400, { error: 'Номи фанро нависед' });
    const schedule = parseSchedule(b);
    if (!schedule) return send(res, 400, { error: 'Ҷадвалро дуруст ворид кунед (рӯзҳо ва вақти оғоз/анҷом)' });
    const t = mkUser(clean(b.username, 30), String(b.password), 'teacher', clean(b.fullName, 100));
    db.users.push(t); db.subjects.push({ id: uuid(), name: subjectName, teacherId: t.id, schedule }); save(db);
    return send(res, 201, pub(t));
  }

  // --- Донишҷуён ---
  if (m === 'GET' && url === '/api/students') {
    if (!need('admin', 'teacher')) return;
    return send(res, 200, db.students.map((s) => { const u = db.users.find((x) => x.studentId === s.id); return { ...s, username: u?.username, userId: u?.id }; }));
  }
  if (m === 'POST' && url === '/api/students') {
    if (!need('admin', 'teacher')) return;
    const b = await readBody(req), err = validateAccount(db, b), group = clean(b.group, 20), course = Number(b.course);
    if (err) return send(res, 400, { error: err });
    if (!group || !(course >= 1 && course <= 6)) return send(res, 400, { error: 'Гурӯҳ ё курс нодуруст аст' });
    const s = { id: uuid(), fullName: clean(b.fullName, 100), group, course, status: 'фаъол' };
    db.students.push(s);
    db.users.push(mkUser(clean(b.username, 30), String(b.password), 'student', s.fullName, { studentId: s.id }));
    save(db);
    return send(res, 201, s);
  }

  // --- Журнал: ҳозиру ғоиб ва бал (омӯзгор танҳо фанни худро; рӯзҳои гузаштаро ҳамеша пур кардан мумкин) ---
  if (m === 'GET' && url === '/api/journal') {
    if (!need('admin', 'teacher')) return;
    const sub = user.role === 'teacher' ? ownSubject() : db.subjects.find((s) => s.id === q.get('subjectId'));
    if (!sub) return send(res, 404, { error: 'Фан ёфт нашуд' });
    const month = /^\d{4}-\d{2}$/.test(q.get('month')) ? q.get('month') : localDate().slice(0, 7);
    const [y, mo] = month.split('-').map(Number), dates = [];
    for (let d = 1; d <= new Date(y, mo, 0).getDate(); d++) { const ds = `${month}-${pad(d)}`; if (sub.schedule.days.includes(wday(ds))) dates.push(ds); }
    const marks = {};
    db.attendance.filter((a) => a.subjectId === sub.id && a.date.startsWith(month)).forEach((a) => ((marks[a.studentId] ||= {})[a.date] = { status: a.status ?? null, score: a.score ?? null }));
    return send(res, 200, { subject: sub, month, dates, today: localDate(), now: nowTime(), editable: user.role === 'teacher',
      students: db.students.filter((s) => s.status === 'фаъол').map((s) => ({ id: s.id, fullName: s.fullName, group: s.group })), marks });
  }
  if (m === 'POST' && url === '/api/journal/mark') {
    if (!need('teacher')) return;
    const sub = ownSubject(), b = await readBody(req);
    if (!sub) return send(res, 404, { error: 'Ба шумо фан таъин нашудааст' });
    if (!isDate(b.date) || !sub.schedule.days.includes(wday(b.date))) return send(res, 400, { error: 'Ин рӯз дарси фанни шумо нест' });
    if (b.date > localDate()) return send(res, 400, { error: 'Барои санаи оянда гузоштан мумкин нест' });
    if (b.date === localDate() && nowTime() < sub.schedule.start) return send(res, 400, { error: `Дарс ҳанӯз оғоз нашудааст (аз ${sub.schedule.start})` });
    const entries = Array.isArray(b.entries) ? b.entries : [];
    for (const e of entries) {
      const st = db.students.find((s) => s.id === e.studentId);
      if (!st || st.status !== 'фаъол') return send(res, 400, { error: 'Донишҷӯ ёфт нашуд ё хориҷ шудааст' });
      if ('status' in e && e.status !== null && !['ҳозир', 'ғоиб'].includes(e.status)) return send(res, 400, { error: 'Ҳолат нодуруст аст' });
      if ('score' in e && e.score !== null && !(Number.isInteger(e.score) && e.score >= 0 && e.score <= 100)) return send(res, 400, { error: 'Бал бояд аз 0 то 100 бошад' });
    }
    for (const e of entries) {
      let rec = db.attendance.find((a) => a.subjectId === sub.id && a.studentId === e.studentId && a.date === b.date);
      if (!rec) { rec = { subjectId: sub.id, studentId: e.studentId, date: b.date, status: null, score: null }; db.attendance.push(rec); }
      if ('status' in e) rec.status = e.status;
      if ('score' in e) rec.score = e.score;
      if (rec.status === null && rec.score === null) db.attendance.splice(db.attendance.indexOf(rec), 1);
    }
    save(db);
    return send(res, 200, { saved: entries.length });
  }
  if (m === 'GET' && url === '/api/attendance/summary') {
    if (!need('admin', 'teacher')) return;
    const sub = user.role === 'teacher' ? ownSubject() : db.subjects.find((s) => s.id === q.get('subjectId'));
    if (!sub) return send(res, 404, { error: 'Фан ёфт нашуд' });
    const recs = db.attendance.filter((a) => a.subjectId === sub.id);
    const rows = db.students.map((s) => {
      const all = recs.filter((a) => a.studentId === s.id), mine = all.filter((a) => a.status), present = mine.filter((a) => a.status === 'ҳозир').length, sc = all.filter((a) => a.score != null);
      return { studentId: s.id, fullName: s.fullName, group: s.group, status: s.status, present, absent: mine.length - present, total: mine.length, percent: pct(present, mine.length), avg: sc.length ? Math.round(sc.reduce((x, a) => x + a.score, 0) / sc.length) : null };
    });
    return send(res, 200, { subject: sub, dates: new Set(recs.filter((a) => a.status).map((a) => a.date)).size, rows });
  }

  // --- Давомоти худи донишҷӯ ---
  if (m === 'GET' && url === '/api/my/attendance') {
    if (!need('student')) return;
    const st = db.students.find((s) => s.id === user.studentId);
    const subjects = db.subjects.map((sub) => {
      const all = db.attendance.filter((a) => a.subjectId === sub.id && a.studentId === st.id).sort((a, b) => b.date.localeCompare(a.date));
      const mine = all.filter((a) => a.status), sc = all.filter((a) => a.score != null), present = mine.filter((a) => a.status === 'ҳозир').length;
      return { name: sub.name, teacher: db.users.find((u) => u.id === sub.teacherId)?.fullName, schedule: sub.schedule, total: mine.length, present, absent: mine.length - present, percent: pct(present, mine.length), avg: sc.length ? Math.round(sc.reduce((x, a) => x + a.score, 0) / sc.length) : null, recent: all.slice(0, 40).map((a) => ({ date: a.date, status: a.status ?? null, score: a.score ?? null })) };
    });
    return send(res, 200, { student: st, subjects });
  }

  // --- Дархостҳои хориҷшавӣ ---
  if (m === 'GET' && url === '/api/withdrawals') {
    if (!need('admin', 'student')) return;
    let list = db.withdrawals;
    if (user.role === 'student') list = list.filter((w) => w.studentId === user.studentId);
    list = list.map((w) => ({ ...w, student: db.students.find((s) => s.id === w.studentId) || null }));
    return send(res, 200, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  if (m === 'POST' && url === '/api/withdrawals') {
    if (!need('admin', 'student')) return;
    const b = await readBody(req);
    const student = db.students.find((s) => s.id === (user.role === 'student' ? user.studentId : b.studentId));
    if (!student) return send(res, 404, { error: 'Донишҷӯ ёфт нашуд' });
    if (student.status !== 'фаъол') return send(res, 409, { error: 'Донишҷӯ аллакай хориҷ шудааст' });
    if (db.withdrawals.some((w) => w.studentId === student.id && w.status === 'интизорӣ')) return send(res, 409, { error: 'Дархости кушода вуҷуд дорад' });
    const type = clean(b.type, 60), reason = clean(b.reason, 1000);
    if (!TYPES.includes(type)) return send(res, 400, { error: 'Намуди хориҷшавӣ нодуруст аст' });
    if (reason.length < 5) return send(res, 400, { error: 'Сабабро муфассалтар нависед' });
    const w = { id: uuid(), studentId: student.id, type, reason, status: 'интизорӣ', comment: '', createdAt: new Date().toISOString(), decidedAt: null };
    db.withdrawals.push(w); save(db);
    return send(res, 201, w);
  }
  const dec = url.match(/^\/api\/withdrawals\/([\w-]+)$/);
  if (m === 'PATCH' && dec) {
    if (!need('admin')) return;
    const w = db.withdrawals.find((x) => x.id === dec[1]);
    if (!w) return send(res, 404, { error: 'Дархост ёфт нашуд' });
    if (w.status !== 'интизорӣ') return send(res, 409, { error: 'Дархост аллакай баррасӣ шудааст' });
    const b = await readBody(req);
    if (!['тасдиқшуда', 'рад шуда'].includes(b.status)) return send(res, 400, { error: 'Ҳолат нодуруст аст' });
    w.status = b.status; w.comment = clean(b.comment); w.decidedAt = new Date().toISOString();
    if (w.status === 'тасдиқшуда') { const s = db.students.find((x) => x.id === w.studentId); if (s) { s.status = 'хориҷшуда'; s.exitDate = w.decidedAt; } }
    save(db);
    return send(res, 200, w);
  }

  let x;
  if (m === 'DELETE' && (x = url.match(/^\/api\/students\/([\w-]+)$/))) {
    if (!need('admin')) return;
    const st = db.students.find((s) => s.id === x[1]);
    if (!st) return send(res, 404, { error: 'Донишҷӯ ёфт нашуд' });
    db.users.filter((u) => u.studentId === st.id).forEach((u) => dropSessions(u.id));
    db.students = db.students.filter((s) => s.id !== st.id);
    db.users = db.users.filter((u) => u.studentId !== st.id);
    db.attendance = db.attendance.filter((a) => a.studentId !== st.id);
    db.withdrawals = db.withdrawals.filter((w) => w.studentId !== st.id);
    save(db); return send(res, 200, { ok: true });
  }
  if (m === 'DELETE' && (x = url.match(/^\/api\/teachers\/([\w-]+)$/))) {
    if (!need('admin')) return;
    const t = db.users.find((u) => u.id === x[1] && u.role === 'teacher');
    if (!t) return send(res, 404, { error: 'Омӯзгор ёфт нашуд' });
    const subIds = db.subjects.filter((s) => s.teacherId === t.id).map((s) => s.id);
    dropSessions(t.id);
    db.attendance = db.attendance.filter((a) => !subIds.includes(a.subjectId));
    db.subjects = db.subjects.filter((s) => s.teacherId !== t.id);
    db.users = db.users.filter((u) => u.id !== t.id);
    save(db); return send(res, 200, { ok: true });
  }
  if (m === 'PATCH' && (x = url.match(/^\/api\/subjects\/([\w-]+)$/))) {
    if (!need('admin')) return;
    const sub = db.subjects.find((s) => s.id === x[1]), sch = parseSchedule(await readBody(req));
    if (!sub) return send(res, 404, { error: 'Фан ёфт нашуд' });
    if (!sch) return send(res, 400, { error: 'Ҷадвал нодуруст аст' });
    sub.schedule = sch; save(db); return send(res, 200, sub);
  }
  if (m === 'POST' && (x = url.match(/^\/api\/users\/([\w-]+)\/password$/))) {
    if (!need('admin')) return;
    const u = db.users.find((y) => y.id === x[1]), b = await readBody(req);
    if (!u) return send(res, 404, { error: 'Корбар ёфт нашуд' });
    if (String(b.password || '').length < 6) return send(res, 400, { error: 'Парол бояд камаш 6 аломат бошад' });
    setPw(u, String(b.password)); dropSessions(u.id); save(db); return send(res, 200, { ok: true });
  }
  if (m === 'POST' && url === '/api/me/password') {
    const b = await readBody(req);
    if (!checkPw(user, b.oldPassword)) return send(res, 400, { error: 'Пароли ҳозира нодуруст аст' });
    if (String(b.newPassword || '').length < 6) return send(res, 400, { error: 'Парол бояд камаш 6 аломат бошад' });
    setPw(user, String(b.newPassword)); save(db); return send(res, 200, { ok: true });
  }

  if (m === 'GET' && url === '/api/stats') {
    if (!need('admin')) return;
    const by = (k, arr) => arr.reduce((a, x) => ((a[x[k]] = (a[x[k]] || 0) + 1), a), {});
    return send(res, 200, {
      students: by('status', db.students), withdrawals: by('status', db.withdrawals),
      byType: by('type', db.withdrawals.filter((w) => w.status === 'тасдиқшуда')),
      teachers: { 'Шумора': db.users.filter((u) => u.role === 'teacher').length },
    });
  }
  send(res, 404, { error: 'Роҳ ёфт нашуд' });
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost'), url = u.pathname;
  try {
    if (url.startsWith('/api/')) return await api(req, res, url, u.searchParams);
    const file = path.join(PUBLIC_DIR, url === '/' ? 'index.html' : decodeURIComponent(url));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch { send(res, 400, { error: 'Дархости нодуруст' }); }
}).listen(PORT, () => console.log(`Сервер кор мекунад: http://localhost:${PORT}`));
