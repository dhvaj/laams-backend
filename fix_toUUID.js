const fs = require('fs');

let code = fs.readFileSync('server.js', 'utf8');

code = code.replace(/function toUUID\(id\) {/, 'function toUUID(id, prefix) {');
code = code.replace(/if \(\!id\) return id;/, "if (!id) return id;\n  if (prefix && ID_MAP[prefix + '-' + id]) return ID_MAP[prefix + '-' + id];");

// Replace classId and subjectId calls
code = code.replace(/toUUID\(req\.query\.classId\)/g, "toUUID(req.query.classId, 'class')");
code = code.replace(/toUUID\(classId\)/g, "toUUID(classId, 'class')");
code = code.replace(/toUUID\(subjectId\)/g, "toUUID(subjectId, 'subj')");

// We also need to manually patch the assignment / exam endpoints that use req.params.id
// But I can just do a regex replace for the known lines:
code = code.replace(/app\.patch\('\/assignments\/:id', async \(req, res\) => {\s+try {\s+const id = toUUID\(req\.params\.id\);/g, "app.patch('/assignments/:id', async (req, res) => {\n  try {\n    const id = toUUID(req.params.id, 'assign');");
code = code.replace(/app\.get\('\/assignments\/:id\/submissions', async \(req, res\) => {\s+try {\s+const id = toUUID\(req\.params\.id\);/g, "app.get('/assignments/:id/submissions', async (req, res) => {\n  try {\n    const id = toUUID(req.params.id, 'assign');");
code = code.replace(/app\.post\('\/assignments\/:id\/submit', upload\.single\('file'\), async \(req, res\) => {\s+try {\s+const id = toUUID\(req\.params\.id\);/g, "app.post('/assignments/:id/submit', upload.single('file'), async (req, res) => {\n  try {\n    const id = toUUID(req.params.id, 'assign');");

fs.writeFileSync('server.js', code);
console.log('Fixed toUUID and its usages');
