console.log('=== Bobcat Doctor ===');
const fs = require('fs');
const path = require('path');

function ok(x){console.log('✔',x)}
function bad(x){console.log('✖',x)}

function mustExist(p, type='file'){
  const exists = fs.existsSync(p);
  if(!exists){ bad(`Manquant: ${p}`); return false; }
  const st = fs.statSync(p);
  if(type==='dir' && !st.isDirectory()){ bad(`Devrait être un dossier: ${p}`); return false; }
  if(type==='file' && !st.isFile()){ bad(`Devrait être un fichier: ${p}`); return false; }
  ok(`Trouvé: ${p}`);
  return true;
}

try {
  // 1) Node & package.json
  ok(`Node ${process.version}`);
  mustExist('package.json','file');

  // 2) Dossiers attendus
  const allGood =
    mustExist('utils','dir') &
    mustExist('views','dir') &
    mustExist('public','dir') &
    mustExist(path.join('public','css'),'dir') &
    mustExist(path.join('public','images'),'dir') &
    mustExist(path.join('public','uploads'),'dir');

  // 3) Fichiers essentiels
  mustExist('index.js','file');
  mustExist(path.join('utils','db.js'),'file');
  ['login.ejs','register.ejs','dashboard.ejs','admin.ejs'].forEach(f=>{
    mustExist(path.join('views',f),'file');
  });
  mustExist(path.join('public','css','style.css'),'file');
  mustExist(path.join('public','images','logo-bobcat.svg'),'file');

  // 4) Dépendances
  let express;
  try { express = require('express'); ok('Module express OK'); } catch(e){ bad('express manquant: npm install'); }
  try { require('ejs'); ok('Module ejs OK'); } catch(e){ bad('ejs manquant: npm install'); }
  try { require('express-session'); ok('express-session OK'); } catch(e){ bad('express-session manquant'); }
  try { require('connect-flash'); ok('connect-flash OK'); } catch(e){ bad('connect-flash manquant'); }
  try { require('multer'); ok('multer OK'); } catch(e){ bad('multer manquant'); }
  try { require('bcrypt'); ok('bcrypt OK'); } catch(e){ bad('bcrypt manquant'); }
  let usingBetter = true;
  try { require('better-sqlite3'); ok('better-sqlite3 OK'); } catch(e){ usingBetter = false; bad('better-sqlite3 manquant'); }
  if(!usingBetter){
    try { require('sqlite3'); ok('sqlite3 OK (fallback)'); } catch(e){ bad('sqlite3 manquant aussi'); }
  }

  // 5) Test DB require
  try {
    require('./utils/db');
    ok('Chargement ./utils/db OK');
  } catch(e){
    bad('Erreur au chargement utils/db.js :'); console.error(e);
  }

  // 6) Test serveur express (port libre ?)
  if (express){
    const app = express();
    const PORT = 3000;
    const srv = app.listen(PORT, ()=>{
      ok(`Port ${PORT} disponible (serveur test lancé puis fermé)`);
      srv.close(()=>{
        ok('Test serveur arrêté proprement');
        console.log('=== Fin Bobcat Doctor ===');
      });
    });
    srv.on('error', (err)=>{
      bad(`Port ${PORT} indisponible: ${err.code || err.message}`);
      console.log('=== Fin Bobcat Doctor ===');
    });
  } else {
    console.log('=== Fin Bobcat Doctor (express absent) ===');
  }
} catch (e) {
  bad('Doctor a rencontré une erreur inattendue:');
  console.error(e);
}
