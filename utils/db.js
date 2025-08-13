// utils/db.js
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const db = new sqlite3.Database('data.sqlite');

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { if (err) reject(err); else resolve(this); });
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
  });
}

// ---------- Migrations sûres ----------
async function safeAddColumn(table, columnDef) {
  const colName = columnDef.trim().split(/\s+/, 1)[0];
  const cols = await all(`PRAGMA table_info(${table})`);
  const exists = cols.some(c => String(c.name).toLowerCase() === colName.toLowerCase());
  if (!exists) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  }
}

// ---------- INIT & MIGRATIONS ----------
async function migrate() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identifiant TEXT UNIQUE NOT NULL,
    nomRP TEXT NOT NULL,
    matricule TEXT NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT,
    isAdmin INTEGER DEFAULT 0
  )`);

  await run(`CREATE TABLE IF NOT EXISTS service_status (
    userId INTEGER PRIMARY KEY,
    enService INTEGER DEFAULT 0,
    enPause INTEGER DEFAULT 0,
    typeMission TEXT DEFAULT NULL,
    zone TEXT DEFAULT NULL,
    opStatus TEXT DEFAULT "disponible",
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);
  await safeAddColumn('service_status', 'zone TEXT DEFAULT NULL');
  await safeAddColumn('service_status', 'opStatus TEXT DEFAULT "disponible"');

  await run(`CREATE TABLE IF NOT EXISTS service_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    mission_type TEXT,
    start_time TEXT NOT NULL,
    end_time TEXT,
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS service_pauses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    logId INTEGER NOT NULL,
    pause_start TEXT NOT NULL,
    pause_end TEXT,
    FOREIGN KEY(logId) REFERENCES service_logs(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS sanctions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('rappel','blame1','blame2','suspension')),
    active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);
  await safeAddColumn('sanctions', 'required_hours REAL');
  await safeAddColumn('sanctions', 'worked_hours REAL DEFAULT 0');
  await safeAddColumn('sanctions', 'required_minutes INTEGER');
  await safeAddColumn('sanctions', 'worked_minutes INTEGER DEFAULT 0');

  await run(`UPDATE sanctions
             SET required_minutes = CAST(required_hours * 60 AS INTEGER)
           WHERE required_minutes IS NULL AND required_hours IS NOT NULL`);
  await run(`UPDATE sanctions
             SET worked_minutes = CAST(worked_hours * 60 AS INTEGER)
           WHERE (worked_minutes IS NULL OR worked_minutes = 0) AND worked_hours IS NOT NULL`);

  await run(`CREATE TABLE IF NOT EXISTS dispatch_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('assistance','blinde'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS dispatch_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    groupId INTEGER NOT NULL,
    userId INTEGER NOT NULL,
    UNIQUE(groupId, userId),
    FOREIGN KEY(groupId) REFERENCES dispatch_groups(id),
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);

  await run(`CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    userId INTEGER NOT NULL,
    message TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    closed_at TEXT,
    FOREIGN KEY(userId) REFERENCES users(id)
  )`);

  const admin = await get('SELECT id FROM users WHERE identifiant=?', ['admin']);
  if (!admin) {
    const hash = await bcrypt.hash('Bobcat2025Bob', 10);
    await run(`INSERT INTO users (identifiant, nomRP, matricule, password, avatar, isAdmin)
               VALUES (?,?,?,?,?,1)`, ['admin','Admin Bobcat','ADM-001',hash,null]);
    const row = await get('SELECT id FROM users WHERE identifiant=?', ['admin']);
    await run(`INSERT OR IGNORE INTO service_status
               (userId,enService,enPause,typeMission,zone,opStatus) VALUES (?,?,?,?,?,?)`,
               [row.id,0,0,null,null,'disponible']);
    console.log('[DB] Admin initial créé (admin / Bobcat2025Bob)');
  }
}
migrate().catch(console.error);

// ---------- Utilitaires temps ----------
async function durationMinutes(start, end) {
  const r = await get(`SELECT CAST((julianday(?) - julianday(?)) * 24 * 60 AS INTEGER) AS m`, [end, start]);
  return r?.m || 0;
}
async function pauseMinutesForLog(logId) {
  const r = await get(`SELECT COALESCE(SUM((julianday(pause_end)-julianday(pause_start))*24*60),0) AS m
                       FROM service_pauses WHERE logId=? AND pause_end IS NOT NULL`, [logId]);
  return r?.m || 0;
}

// ---------- EXPORTS ----------
module.exports = {
  // Users
  getUserByIdentifiant(identifiant){ return get('SELECT * FROM users WHERE identifiant=?',[identifiant]); },
  async createUser({ identifiant, nomRP, matricule, password, avatar }) {
    const res = await run('INSERT INTO users (identifiant,nomRP,matricule,password,avatar,isAdmin) VALUES (?,?,?,?,?,0)',
      [identifiant, nomRP, matricule, password, avatar]);
    await run('INSERT OR IGNORE INTO service_status (userId,enService,enPause,typeMission,zone,opStatus) VALUES (?,?,?,?,?,?)',
      [res.lastID,0,0,null,null,'disponible']);
    return res;
  },
  getAllUsers(){
    return all(`SELECT u.*, s.enService, s.enPause, s.typeMission, s.zone, s.opStatus
                FROM users u LEFT JOIN service_status s ON u.id=s.userId
                ORDER BY u.isAdmin DESC, u.nomRP ASC`);
  },

  // Liste live
  getUsersEnService(){
    return all(`SELECT u.id,u.identifiant,u.nomRP,u.matricule,u.avatar,
                       s.enService,s.enPause,s.typeMission,s.zone,s.opStatus
                FROM users u JOIN service_status s ON u.id=s.userId
                WHERE s.enService=1
                ORDER BY u.nomRP ASC`);
  },

  // Logs & pauses
  getActiveLog(userId){
    return get('SELECT * FROM service_logs WHERE userId=? AND end_time IS NULL ORDER BY id DESC LIMIT 1', [Number(userId)]);
  },
  async startService(userId, mission){
    await run(`INSERT INTO service_status (userId,enService,enPause,typeMission)
               VALUES (?,?,?,?)
               ON CONFLICT(userId) DO UPDATE SET enService=1,enPause=0,typeMission=excluded.typeMission`,
               [Number(userId),1,0,mission]);
    const open = await this.getActiveLog(userId);
    if (!open) {
      await run('INSERT INTO service_logs (userId,mission_type,start_time) VALUES (?,?,datetime("now","localtime"))',
                [Number(userId), mission]);
    }
  },
  async pauseService(userId){
    const log = await this.getActiveLog(userId);
    if (!log) return;
    const openPause = await get('SELECT id FROM service_pauses WHERE logId=? AND pause_end IS NULL ORDER BY id DESC LIMIT 1',[log.id]);
    if (openPause) return;
    await run('INSERT INTO service_pauses (logId,pause_start) VALUES (?, datetime("now","localtime"))',[log.id]);
    await run('UPDATE service_status SET enPause=1 WHERE userId=?',[Number(userId)]);
  },
  async resumeService(userId){
    const log = await this.getActiveLog(userId);
    if (!log) return;
    const openPause = await get('SELECT id FROM service_pauses WHERE logId=? AND pause_end IS NULL ORDER BY id DESC LIMIT 1',[log.id]);
    if (!openPause) return;
    await run('UPDATE service_pauses SET pause_end=datetime("now","localtime") WHERE id=?',[openPause.id]);
    await run('UPDATE service_status SET enPause=0 WHERE userId=?',[Number(userId)]);
  },
  async endService(userId){
    const log = await this.getActiveLog(userId);
    if (log) {
      const openPause = await get('SELECT id FROM service_pauses WHERE logId=? AND pause_end IS NULL ORDER BY id DESC LIMIT 1',[log.id]);
      if (openPause) await run('UPDATE service_pauses SET pause_end=datetime("now","localtime") WHERE id=?',[openPause.id]);
      await run('UPDATE service_logs SET end_time=datetime("now","localtime") WHERE id=?',[log.id]);

      const fresh = await get('SELECT id,start_time,end_time FROM service_logs WHERE id=?',[log.id]);
      if (fresh && fresh.end_time) {
        const total = await durationMinutes(fresh.start_time, fresh.end_time);
        const p = await pauseMinutesForLog(fresh.id);
        const net = Math.max(0, total - p);
        await this._applyWorkedMinutesToBlame(userId, net);
      }
    }
    await run('UPDATE service_status SET enService=0,enPause=0,typeMission=NULL WHERE userId=?',[Number(userId)]);
  },

  // Sanctions (minutes exactes)
  async isSuspended(userId){
    const row = await get(`SELECT 1 FROM sanctions WHERE userId=? AND active=1 AND type='suspension'`,[Number(userId)]);
    return !!row;
  },
  async setSanction(userId, type, requiredMinutes = null){
    await run(`UPDATE sanctions SET active=0 WHERE userId=? AND active=1`,[Number(userId)]);
    await run(`INSERT INTO sanctions (userId,type,required_minutes,worked_minutes,active)
               VALUES (?,?,?,?,1)`,
               [Number(userId), String(type),
                requiredMinutes != null ? Math.max(0, parseInt(requiredMinutes,10)) : null, 0]);
  },
  async clearSanction(userId){ await run(`UPDATE sanctions SET active=0 WHERE userId=? AND active=1`,[Number(userId)]); },
  async _applyWorkedMinutesToBlame(userId, minutes){
    const sc = await get(`SELECT * FROM sanctions WHERE userId=? AND active=1 AND type IN ('blame1','blame2')`,
                         [Number(userId)]);
    if (!sc) return;
    const newWorked = (sc.worked_minutes || 0) + Math.max(0, parseInt(minutes,10));
    await run(`UPDATE sanctions SET worked_minutes=? WHERE id=?`, [newWorked, sc.id]);
    if (sc.required_minutes != null && newWorked >= sc.required_minutes) {
      await run(`UPDATE sanctions SET active=0 WHERE id=?`, [sc.id]);
    }
  },

  // Rapport heures (semaine)
  async getWeeklyMinutesThisWeek(){
    const now = new Date();
    const d = now.getDay();
    const diffMon = (d === 0 ? -6 : 1 - d);
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffMon); monday.setHours(0,0,0,0);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6); sunday.setHours(23,59,59,999);
    const startIso = monday.toISOString().slice(0,19).replace('T',' ');
    const endIso   = sunday.toISOString().slice(0,19).replace('T',' ');

    const logs = await all(`
      SELECT l.id,l.userId,l.start_time,l.end_time,u.nomRP,u.matricule
      FROM service_logs l JOIN users u ON u.id=l.userId
      WHERE l.end_time IS NOT NULL AND l.start_time >= ? AND l.end_time <= ?
      ORDER BY u.nomRP ASC
    `,[startIso,endIso]);

    const per = new Map();
    for (const log of logs) {
      const total = await durationMinutes(log.start_time, log.end_time);
      const p = await pauseMinutesForLog(log.id);
      const mins = Math.max(0, total - p);
      if (!per.has(log.userId)) per.set(log.userId,{ nomRP:log.nomRP, matricule:log.matricule, minutes:0 });
      per.get(log.userId).minutes += mins;
    }
    return Array.from(per.values()).sort((a,b)=>a.nomRP.localeCompare(b.nomRP));
  },

  // Zones & statut
  setZone(userId, zone){ return run('UPDATE service_status SET zone=? WHERE userId=?',[zone || null, Number(userId)]); },
  setOpStatus(userId, status){
    const allowed = ['disponible','intervention','occupe'];
    const s = allowed.includes(String(status)) ? String(status) : 'disponible';
    return run('UPDATE service_status SET opStatus=? WHERE userId=?', [s, Number(userId)]);
  },

  // Dispatch
  getDispatch(){
    return all(`SELECT g.id,g.name,g.type,
                       json_group_array(
                         CASE WHEN u.id IS NULL THEN NULL
                              ELSE json_object('userId',u.id,'nomRP',u.nomRP,'matricule',u.matricule)
                         END
                       ) AS members
                FROM dispatch_groups g
                LEFT JOIN dispatch_assignments da ON da.groupId=g.id
                LEFT JOIN users u ON u.id=da.userId
                GROUP BY g.id
                ORDER BY g.type ASC, g.name ASC`);
  },
  createGroup(name, type){ return run('INSERT INTO dispatch_groups (name,type) VALUES (?,?)',[name, type]); },
  renameGroup(groupId, name){ return run('UPDATE dispatch_groups SET name=? WHERE id=?',[name, Number(groupId)]); },
  async deleteGroup(groupId){
    await run('DELETE FROM dispatch_assignments WHERE groupId=?',[Number(groupId)]);
    await run('DELETE FROM dispatch_groups WHERE id=?',[Number(groupId)]);
  },
  assignUser(groupId, userId){ return run('INSERT OR IGNORE INTO dispatch_assignments (groupId,userId) VALUES (?,?)',[Number(groupId),Number(userId)]); },
  unassignUser(groupId, userId){ return run('DELETE FROM dispatch_assignments WHERE groupId=? AND userId=?',[Number(groupId),Number(userId)]); },

  // Employés + sanction active (minutes)
  getEmployeesCompact(){
    return all(`
      SELECT
        u.id, u.nomRP, u.matricule,
        s.type AS sanction_type,
        s.required_minutes,
        s.worked_minutes,
        CASE
          WHEN s.required_minutes IS NULL THEN NULL
          ELSE MAX(s.required_minutes - COALESCE(s.worked_minutes,0), 0)
        END AS remaining_minutes
      FROM users u
      LEFT JOIN sanctions s
        ON s.userId = u.id AND s.active = 1
      ORDER BY u.nomRP ASC
    `);
  },

  // Alerts
  createAlert(userId, message){
    return run('INSERT INTO alerts (userId,message,status) VALUES (?,?, "open")', [Number(userId), String(message||'')]);
  },
  getOpenAlerts(){
    return all(`SELECT a.id, a.userId, a.message, a.status, a.created_at,
                       u.nomRP, u.matricule
                FROM alerts a
                JOIN users u ON u.id=a.userId
                WHERE a.status='open'
                ORDER BY a.id DESC`);
  },
  closeAlert(alertId){
    return run(`UPDATE alerts SET status='closed', closed_at=datetime('now','localtime') WHERE id=?`, [Number(alertId)]);
  },
  // Dernière alerte ouverte NON VIDE (pour la banderole)
  getLatestOpenAlert(){
    return get(`
      SELECT a.id, a.message, a.created_at
      FROM alerts a
      WHERE a.status='open' AND a.message IS NOT NULL AND TRIM(a.message) <> ''
      ORDER BY a.id DESC
      LIMIT 1
    `);
  },

  // === AJOUTS: filtres matricule + reset heures ===
  _weekBounds: async function(){
    const now = new Date();
    const d = now.getDay(); // 0=dim
    const diffMon = (d === 0 ? -6 : 1 - d);
    const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diffMon);
    monday.setHours(0,0,0,0);
    const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
    sunday.setHours(23,59,59,999);
    const startIso = monday.toISOString().slice(0,19).replace('T',' ');
    const endIso   = sunday.toISOString().slice(0,19).replace('T',' ');
    return { startIso, endIso };
  },

  resetHoursThisWeek: async function(){
    const { startIso, endIso } = await this._weekBounds();
    await run(`DELETE FROM service_pauses WHERE logId IN (
                 SELECT id FROM service_logs WHERE start_time >= ? AND end_time <= ?
               )`, [startIso, endIso]);
    await run(`DELETE FROM service_logs WHERE start_time >= ? AND end_time <= ?`, [startIso, endIso]);
  },

  resetHoursAll: async function(){
    await run(`DELETE FROM service_pauses`);
    await run(`DELETE FROM service_logs`);
  },

  searchUsersByMatricule: function(q){
    const like = `%${String(q||'').trim()}%`;
    return all(`SELECT u.*, s.enService, s.enPause, s.typeMission, s.zone, s.opStatus
                FROM users u LEFT JOIN service_status s ON u.id = s.userId
                WHERE u.matricule LIKE ?
                ORDER BY u.isAdmin DESC, u.nomRP ASC`, [like]);
  },

  getEmployeesCompactByMatricule: function(q){
    const like = `%${String(q||'').trim()}%`;
    return all(`
      SELECT
        u.id, u.nomRP, u.matricule,
        s.type AS sanction_type,
        s.required_minutes,
        s.worked_minutes,
        CASE
          WHEN s.required_minutes IS NULL THEN NULL
          ELSE MAX(s.required_minutes - COALESCE(s.worked_minutes,0), 0)
        END AS remaining_minutes
      FROM users u
      LEFT JOIN sanctions s
        ON s.userId = u.id AND s.active = 1
      WHERE u.matricule LIKE ?
      ORDER BY u.nomRP ASC
    `, [like]);
  }
};

