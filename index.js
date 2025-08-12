// index.js — Bobcat Security (ReadyToPaste, corrigé)
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');

const db = require('./utils/db');

const app = express();

// ====== VIEW + STATIC ======
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); // pour POST /alert en AJAX

// ====== SESSION + FLASH ======
app.use(session({
  secret: 'bobcat_super_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*12 }
}));
app.use(flash());

app.use((req, res, next) => {
  res.locals.flashError = req.flash('error');
  res.locals.flashSuccess = req.flash('success');
  res.locals.user = req.session.user || null;
  next();
});

// ====== UPLOAD AVATAR ======
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'uploads')),
  filename: (req, file, cb) => {
    const name = Date.now() + '-' + Math.round(Math.random()*1e9);
    const ext = (file.originalname.split('.').pop() || 'png').toLowerCase();
    cb(null, `${name}.${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2*1024*1024 },
  fileFilter: (req, file, cb) => {
    const ok = /image\/png|image\/jpeg/.test(file.mimetype || '');
    cb(ok ? null : new Error('Format image non supporté (PNG/JPG uniquement)'), ok);
  }
});

// ====== HELPERS AUTH ======
function checkAuth(req, res, next){
  if (!req.session.user) {
    req.flash('error','Veuillez vous connecter.');
    return res.redirect('/login');
  }
  next();
}
function checkAdmin(req, res, next){
  if (!req.session.user || !req.session.user.isAdmin) {
    req.flash('error','Accès administrateur requis.');
    return res.redirect('/dashboard');
  }
  next();
}

// ====== ROUTES AUTH ======
app.get('/', (req,res)=> res.redirect(req.session.user ? '/dashboard' : '/login'));

app.get('/login', (req,res)=>{
  if (req.session.user) return res.redirect('/dashboard');
  res.render('login');
});

app.post('/login',
  body('identifiant').trim().notEmpty(),
  body('password').isLength({ min: 1 }),
  async (req,res)=>{
    const errors = validationResult(req);
    if (!errors.isEmpty()){
      req.flash('error','Identifiants invalides.');
      return res.redirect('/login');
    }
    try{
      const { identifiant, password } = req.body;
      const user = await db.getUserByIdentifiant(identifiant.trim());
      if (!user) {
        req.flash('error','Identifiant ou mot de passe incorrect.');
        return res.redirect('/login');
      }
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) {
        req.flash('error','Identifiant ou mot de passe incorrect.');
        return res.redirect('/login');
      }
      req.session.user = { id:user.id, identifiant:user.identifiant, nomRP:user.nomRP, matricule:user.matricule, isAdmin: !!user.isAdmin };
      req.flash('success','Connexion réussie.');
      res.redirect('/dashboard');
    }catch(e){
      console.error('[LOGIN ERROR]', e);
      req.flash('error','Erreur serveur.');
      res.redirect('/login');
    }
  }
);

app.get('/register', (req,res)=>{
  if (req.session.user) return res.redirect('/dashboard');
  res.render('register');
});

app.post('/register',
  upload.single('avatar'),
  body('identifiant').trim().notEmpty(),
  body('nomRP').trim().notEmpty(),
  body('matricule').trim().notEmpty(),
  body('password').isLength({ min: 6 }),
  async (req,res)=>{
    const errors = validationResult(req);
    if (!errors.isEmpty()){
      if (req.file) {
        try { fs.unlinkSync(req.file.path); } catch(_) {}
      }
      req.flash('error','Vérifiez les champs (mot de passe ≥ 6).');
      return res.redirect('/register');
    }
    try{
      const { identifiant, nomRP, matricule, password } = req.body;
      const exists = await db.getUserByIdentifiant(identifiant.trim());
      if (exists){
        if (req.file) {
          try { fs.unlinkSync(req.file.path); } catch(_) {}
        }
        req.flash('error','Identifiant déjà utilisé.');
        return res.redirect('/register');
      }
      const hash = await bcrypt.hash(password, 10);
      await db.createUser({
        identifiant: identifiant.trim(),
        nomRP: nomRP.trim(),
        matricule: matricule.trim(),
        password: hash,
        avatar: req.file ? path.basename(req.file.path) : null
      });
      req.flash('success','Compte créé. Vous pouvez vous connecter.');
      res.redirect('/login');
    }catch(e){
      console.error('[REGISTER ERROR]', e);
      req.flash('error','Erreur serveur.');
      res.redirect('/register');
    }
  }
);

app.get('/logout', (req,res)=>{
  req.session.destroy(()=> res.redirect('/login'));
});

// ====== DASHBOARD ======
app.get('/dashboard', checkAuth, async (req,res)=>{
  try{
    const usersEnService = await db.getUsersEnService();
    res.render('dashboard', { usersEnService });
  }catch(e){
    console.error('[DASHBOARD ERROR]', e);
    req.flash('error','Erreur chargement dashboard.');
    res.redirect('/login');
  }
});

app.post('/service/action', checkAuth, async (req,res)=>{
  try{
    const { action, typeMission } = req.body;
    const userId = req.session.user.id;

    if (action === 'prendre'){
      const suspended = await db.isSuspended(userId);
      if (suspended){
        req.flash('error',"Vous êtes suspendu, prise de service impossible.");
        return res.redirect('/dashboard');
      }
      await db.startService(userId, typeMission || null);
      req.flash('success','Service démarré.');
    }
    else if (action === 'pause'){
      await db.pauseService(userId);
      req.flash('success','Pause démarrée.');
    }
    else if (action === 'reprendre'){
      await db.resumeService(userId);
      req.flash('success','Pause terminée.');
    }
    else if (action === 'finir'){
      await db.endService(userId);
      req.flash('success','Fin de service.');
    }
    res.redirect('/dashboard');
  }catch(e){
    console.error('[SERVICE ACTION ERROR]', e);
    req.flash('error','Action impossible.');
    res.redirect('/dashboard');
  }
});

// Changer le statut (disponible/intervention/occupé)
app.post('/service/status', checkAuth, async (req,res)=>{
  try{
    const { status } = req.body;
    await db.setOpStatus(req.session.user.id, status);
    req.flash('success','Statut mis à jour.');
  }catch(e){
    console.error('[STATUS ERROR]', e);
    req.flash('error','Impossible de changer le statut.');
  }
  res.redirect('/dashboard');
});

// ====== ADMIN ======
app.get('/admin', checkAdmin, async (req,res)=>{
  try{
    const q = (req.query && req.query.q) ? String(req.query.q).trim() : '';
    const users = q ? await db.searchUsersByMatricule(q) : await db.getAllUsers();
    res.render('admin', { users, q });
  }catch(e){
    console.error('[ADMIN PAGE ERROR]', e);
    req.flash('error','Erreur chargement admin.');
    res.redirect('/dashboard');
  }
});

app.get('/admin/employes', checkAdmin, async (req,res)=>{
  try{
    const q = (req.query && req.query.q) ? String(req.query.q).trim() : '';
    const rows = q ? await db.getEmployeesCompactByMatricule(q) : await db.getEmployeesCompact();
    res.render('admin_employees', { rows, q });
  }catch(e){
    console.error('[EMPLOYES PAGE ERROR]', e);
    req.flash('error','Erreur chargement employés.');
    res.redirect('/admin');
  }
});

app.get('/admin/heures', checkAdmin, async (req,res)=>{
  try{
    const rows = await db.getWeeklyMinutesThisWeek();
    const display = rows.map(r=>{
      const h = Math.floor(r.minutes/60);
      const m = r.minutes%60;
      return { nomRP:r.nomRP, matricule:r.matricule, heures:`${h}h ${String(m).padStart(2,'0')}min` };
    });
    res.render('admin_hours', { rows: display });
  }catch(e){
    console.error('[HEURES PAGE ERROR]', e);
    req.flash('error','Erreur calcul heures.');
    res.redirect('/admin');
  }
});

// (NOUVEAU) reset heures (semaine / tout)
app.post('/admin/heures/reset', checkAdmin, async (req,res)=>{
  try{
    const { scope } = req.body; // 'week' | 'all'
    if (scope === 'all'){
      await db.resetHoursAll();
      req.flash('success','Toutes les heures ont été remises à zéro.');
    } else {
      await db.resetHoursThisWeek();
      req.flash('success','Heures de la semaine remises à zéro.');
    }
  }catch(e){
    console.error('[HEURES RESET ERROR]', e);
    req.flash('error','Impossible de remettre les heures à zéro.');
  }
  res.redirect('/admin/heures');
});

app.post('/admin/action', checkAdmin, async (req,res)=>{
  try{
    const { userId, action, typeMission } = req.body;
    if (action === 'changer_mission'){
      await db.changerTypeMission(userId, typeMission || null);
      req.flash('success','Mission modifiée.');
    } else if (action === 'forcer_pause'){
      await db.pauseService(userId);
      req.flash('success','Pause forcée.');
    } else if (action === 'forcer_fin'){
      await db.endService(userId);
      req.flash('success','Fin de service forcée.');
    } else if (action === 'supprimer'){
      await db.supprimerUser(userId);
      req.flash('success','Utilisateur supprimé.');
    }
    res.redirect('/admin');
  }catch(e){
    console.error('[ADMIN ACTION ERROR]', e);
    req.flash('error','Action admin impossible.');
    res.redirect('/admin');
  }
});

// ====== DISPATCH ======
// Lecture seule pour tous les connectés
app.get('/dispatch', checkAuth, async (req,res)=>{
  try{
    const [groups, enService, allUsers, alerts] = await Promise.all([
      db.getDispatch(),
      db.getUsersEnService(),
      db.getAllUsers(),
      db.getOpenAlerts()
    ]);
    res.render('dispatch', { groups, enService, allUsers, alerts });
  }catch(e){
    console.error('[DISPATCH GET ERROR]', e);
    req.flash('error','Erreur chargement dispatch.');
    res.redirect('/dashboard');
  }
});

// Modifs dispatch: ADMIN uniquement
app.post('/dispatch/group', checkAdmin, async (req,res)=>{
  try{
    const { op, type, name, groupId } = req.body;
    if (op === 'create'){
      if (!name || !type) { req.flash('error','Nom et type requis.'); return res.redirect('/dispatch'); }
      await db.createGroup(String(name).trim(), String(type).trim());
      req.flash('success','Groupe créé.');
    } else if (op === 'rename'){
      await db.renameGroup(groupId, String(name||'').trim());
      req.flash('success','Groupe renommé.');
    } else if (op === 'delete'){
      await db.deleteGroup(groupId);
      req.flash('success','Groupe supprimé.');
    }
    res.redirect('/dispatch');
  }catch(e){
    console.error('[DISPATCH GROUP ERROR]', e);
    req.flash('error','Erreur groupe.');
    res.redirect('/dispatch');
  }
});

app.post('/dispatch/assign', checkAdmin, async (req,res)=>{
  try{
    const { op, groupId, userId } = req.body;
    if (op === 'add'){
      await db.assignUser(groupId, userId);
      req.flash('success','Agent ajouté au groupe.');
    } else if (op === 'remove'){
      await db.unassignUser(groupId, userId);
      req.flash('success','Agent retiré du groupe.');
    }
    res.redirect('/dispatch');
  }catch(e){
    console.error('[DISPATCH ASSIGN ERROR]', e);
    req.flash('error','Erreur affectation.');
    res.redirect('/dispatch');
  }
});

app.post('/dispatch/zone', checkAdmin, async (req,res)=>{
  try{
    const { userId, zone } = req.body;
    await db.setZone(userId, zone && zone.trim() ? zone.trim() : null);
    req.flash('success','Zone enregistrée.');
    res.redirect('/dispatch');
  }catch(e){
    console.error('[DISPATCH ZONE ERROR]', e);
    req.flash('error','Erreur zone.');
    res.redirect('/dispatch');
  }
});

// Appliquer / lever une sanction (Admin)
app.post('/admin/sanction', checkAdmin, async (req,res)=>{
  try{
    const { userId, action, type, requiredHours } = req.body;

    if (action === 'apply') {
      let minutes = null;
      if (type === 'blame1' || type === 'blame2') {
        const h = Number(requiredHours);
        if (!isNaN(h) && h >= 0) minutes = Math.round(h * 60);
      }
      await db.setSanction(userId, type, minutes);
      req.flash('success','Sanction appliquée.');
    } else if (action === 'clear') {
      await db.clearSanction(userId);
      req.flash('success','Sanction levée.');
    } else {
      req.flash('error','Action sanction inconnue.');
    }
  } catch(e){
    console.error('[SANCTION ERROR]', e);
    req.flash('error','Impossible de modifier la sanction.');
  }
  res.redirect('/admin/employes');
});


// ====== ALERTES ======
// Envoi alerte (admin) — JSON si AJAX, sinon redirect vers la page d’origine
app.post('/alert', checkAdmin, async (req,res)=>{
  try{
    const { message } = req.body || {};
    await db.createAlert(req.session.user.id, String(message || ''));

    const wantsJSON =
      (req.headers['accept'] && req.headers['accept'].includes('application/json')) ||
      req.headers['x-requested-with'] === 'fetch' ||
      (req.headers['content-type'] || '').includes('application/json');

    if (wantsJSON) return res.json({ ok: true });

    req.flash('success','Alerte envoyée.');
    res.redirect(req.get('referer') || '/dashboard');
  }catch(e){
    console.error('[ALERT CREATE ERROR]', e);

    const wantsJSON =
      (req.headers['accept'] && req.headers['accept'].includes('application/json')) ||
      req.headers['x-requested-with'] === 'fetch' ||
      (req.headers['content-type'] || '').includes('application/json');

    if (wantsJSON) return res.status(500).json({ ok: false, error: 'server' });

    req.flash('error','Impossible d’envoyer l’alerte.');
    res.redirect(req.get('referer') || '/dashboard');
  }
});

// Fermer une alerte (admin)
app.post('/alert/close', checkAdmin, async (req,res)=>{
  try{
    const { alertId } = req.body;
    await db.closeAlert(alertId);
    req.flash('success','Alerte fermée.');
  }catch(e){
    console.error('[ALERT CLOSE ERROR]', e);
    req.flash('error','Impossible de fermer l’alerte.');
  }
  res.redirect(req.get('referer') || '/dashboard');
});

// Poll JSON: renvoie SEULEMENT une alerte plus récente que sinceId et non vide
app.get('/alerts/poll', checkAuth, async (req,res)=>{
  try{
    const since = Number(req.query.sinceId || 0);
    const a = await db.getLatestOpenAlert();
    if (!a || !(a.id > since) || !a.message || !a.message.trim()) return res.json({});
    return res.json({ id:a.id, message:a.message.trim(), created_at:a.created_at });
  }catch(e){
    return res.json({});
  }
});

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[OK] Serveur Bobcat Security sur http://localhost:${PORT}`);
});

