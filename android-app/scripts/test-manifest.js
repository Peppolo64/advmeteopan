// Test di harden-manifest.js su un manifest nello stile del template Capacitor
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { harden } = require('./harden-manifest.js');

const TEMPLATE = `<?xml version="1.0" encoding="utf-8" ?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme">
        <activity android:name=".MainActivity" android:exported="true"></activity>
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-manifest-'));
const mpath = path.join(dir, 'app', 'src', 'main', 'AndroidManifest.xml');
fs.mkdirSync(path.dirname(mpath), { recursive: true });
fs.writeFileSync(mpath, TEMPLATE);

harden(dir);
let x = fs.readFileSync(mpath, 'utf8');
assert(/android:allowBackup="false"/.test(x) && !/allowBackup="true"/.test(x), 'allowBackup deve essere false');
assert(/android:fullBackupContent="false"/.test(x));
assert(/android:dataExtractionRules="@xml\/data_extraction_rules"/.test(x));
assert(/android:usesCleartextTraffic="false"/.test(x));
assert(/android:icon="@mipmap\/ic_launcher"/.test(x), 'gli altri attributi restano');
assert(/android.permission.INTERNET/.test(x));
assert(fs.existsSync(path.join(dir, 'app', 'src', 'main', 'res', 'xml', 'data_extraction_rules.xml')));
console.log('ok - manifest rafforzato, attributi esistenti preservati');

harden(dir);
const y = fs.readFileSync(mpath, 'utf8');
assert.strictEqual(y, x, 'seconda esecuzione identica');
assert.strictEqual((y.match(/allowBackup/g) || []).length, 1);
console.log('ok - idempotente');

fs.rmSync(dir, { recursive: true, force: true });
assert.throws(() => harden(path.join(os.tmpdir(), 'non-esiste-sg')), /Manifest non trovato/);
console.log('ok - errore chiaro senza progetto Android');
console.log('\n3 test superati');
