console.log('TEST: Node exécute bien un script.');
const express = require('express');
const app = express();
app.get('/', (req,res)=>res.send('Hello Bobcat'));
const PORT = 3000;
app.listen(PORT, ()=>console.log('TEST: écoute sur http://localhost:'+PORT));
