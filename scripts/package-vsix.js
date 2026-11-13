// 打包 .vsix —— 不需要 npm / vsce，只用 Node（可用 VS Code 自带的 Electron 运行）：
//   $env:ELECTRON_RUN_AS_NODE=1
//   & "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe" scripts/package-vsix.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const root = path.resolve(__dirname, '..');
const extDir = path.join(root, 'vscode-extension');
const outFile = path.join(root, 'llm-tuner-0.1.0.vsix');

function rimraf(p) {
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if (e.isDirectory()) rimraf(q);
    else fs.unlinkSync(q);
  }
  fs.rmdirSync(p);
}

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (filter && !filter(e.name, path.join(src, e.name))) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else fs.copyFileSync(s, d);
  }
}

/* ---------- 1. 把网页同步进扩展 ---------- */
const webDst = path.join(extDir, 'web');
rimraf(webDst);
fs.mkdirSync(webDst, { recursive: true });
for (const f of ['index.html', 'styles.css']) {
  fs.copyFileSync(path.join(root, f), path.join(webDst, f));
}
copyDir(path.join(root, 'src'), path.join(webDst, 'src'));
console.log('web assets synced ->', path.relative(root, webDst));

/* ---------- 2. 生成 vsix 结构 ---------- */
const tmp = path.join(root, '.vsix-tmp');
rimraf(tmp);
fs.mkdirSync(tmp, { recursive: true });

const pkg = JSON.parse(fs.readFileSync(path.join(extDir, 'package.json'), 'utf8'));

const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".css" ContentType="text/css"/>
  <Default Extension=".html" ContentType="text/html"/>
  <Default Extension=".svg" ContentType="image/svg+xml"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
`;

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}" />
    <DisplayName>${pkg.displayName}</DisplayName>
    <Description xml:space="preserve">${pkg.description}</Description>
    <Tags>serial,tuner,vofa,plot,waveform</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
  </Assets>
</PackageManifest>
`;

fs.writeFileSync(path.join(tmp, '[Content_Types].xml'), contentTypes);
fs.writeFileSync(path.join(tmp, 'extension.vsixmanifest'), manifest);

const extOut = path.join(tmp, 'extension');
fs.mkdirSync(extOut, { recursive: true });
for (const name of ['package.json', 'extension.js', 'README.md']) {
  const p = path.join(extDir, name);
  if (fs.existsSync(p)) fs.copyFileSync(p, path.join(extOut, name));
}
copyDir(path.join(extDir, 'media'), path.join(extOut, 'media'));
fs.cpSync(webDst, path.join(extOut, 'web'), { recursive: true });

/* ---------- 3. 手写 ZIP（不依赖第三方库） ---------- */
function collect(dir, base, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const name = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) collect(full, name, out);
    else out.push({ name, data: fs.readFileSync(full) });
  }
  return out;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f),
    date: (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f),
  };
}

const files = collect(tmp, '', []);
const localParts = [];
const centralParts = [];
let offset = 0;
const { time, date } = dosTime(new Date());

for (const f of files) {
  const nameBuf = Buffer.from(f.name, 'utf8');
  const crc = crc32(f.data);
  const comp = zlib.deflateRawSync(f.data, { level: 9 });
  const useDeflate = comp.length < f.data.length;
  const payload = useDeflate ? comp : f.data;
  const method = useDeflate ? 8 : 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(f.data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  localParts.push(local, nameBuf, payload);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(f.data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(offset, 42);

  centralParts.push(central, nameBuf);
  offset += local.length + nameBuf.length + payload.length;
}

const centralDir = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralDir.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);

fs.writeFileSync(outFile, Buffer.concat([...localParts, centralDir, end]));
rimraf(tmp);

const kb = (fs.statSync(outFile).size / 1024).toFixed(1);
console.log(`vsix 已生成: ${path.relative(root, outFile)}  (${files.length} 个文件, ${kb} KB)`);
