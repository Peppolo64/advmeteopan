// Rende "pulita" l'app Android: niente backup automatico (Google Drive / trasferimento dispositivo),
// niente traffico in chiaro. Idempotente. Uso: node scripts/harden-manifest.js [cartella-android]
const fs = require('fs');
const path = require('path');

function harden(androidDir) {
  const manifestPath = path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml');
  if (!fs.existsSync(manifestPath)) throw new Error('Manifest non trovato: ' + manifestPath + ' (esegui prima "npx cap add android")');
  let xml = fs.readFileSync(manifestPath, 'utf8');

  const m = xml.match(/<application\b[^>]*>/);
  if (!m) throw new Error('Tag <application> non trovato nel manifest');
  let tag = m[0];

  const wanted = {
    'android:allowBackup': 'false',
    'android:fullBackupContent': 'false',
    'android:dataExtractionRules': '@xml/data_extraction_rules',
    'android:usesCleartextTraffic': 'false',
  };
  for (const [attr, value] of Object.entries(wanted)) {
    const re = new RegExp(attr.replace(':', '\\:') + '\\s*=\\s*"[^"]*"');
    tag = re.test(tag) ? tag.replace(re, `${attr}="${value}"`) : tag.replace(/<application\b/, `<application\n        ${attr}="${value}"`);
  }
  xml = xml.replace(m[0], tag);
  fs.writeFileSync(manifestPath, xml);

  // Android 12+: regole esplicite "non copiare nulla" sia nel backup cloud sia nel trasferimento tra dispositivi
  const xmlDir = path.join(androidDir, 'app', 'src', 'main', 'res', 'xml');
  fs.mkdirSync(xmlDir, { recursive: true });
  fs.writeFileSync(path.join(xmlDir, 'data_extraction_rules.xml'),
`<?xml version="1.0" encoding="utf-8"?>
<data-extraction-rules>
    <cloud-backup>
        <exclude domain="root" />
        <exclude domain="file" />
        <exclude domain="database" />
        <exclude domain="sharedpref" />
        <exclude domain="external" />
    </cloud-backup>
    <device-transfer>
        <exclude domain="root" />
        <exclude domain="file" />
        <exclude domain="database" />
        <exclude domain="sharedpref" />
        <exclude domain="external" />
    </device-transfer>
</data-extraction-rules>
`);
  return manifestPath;
}

module.exports = { harden };

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'android'));
  console.log('Manifest rafforzato:', harden(dir));
}
