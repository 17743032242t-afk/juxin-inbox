// 打包脚本：node build.mjs [--demo] [--single]
// 正式版输出到 dist/；--demo 输出只含演示数据、完全不联网的 dist-demo/；
// --single 再把演示版合成一个可以单独分享的 dist-demo/demo.html
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const single = process.argv.includes('--single');
const demo = single || process.argv.includes('--demo');
const out = path.join(root, demo ? 'dist-demo' : 'dist');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const demoStub = {
  name: 'demo-stub',
  setup(b) {
    b.onResolve({ filter: /mtcute-backend\.ts$/ }, () => ({ path: path.join(root, 'src/core/demo-stub.ts') }));
  },
};

await build({
  entryPoints: { app: path.join(root, 'src/main.tsx') },
  outdir: out,
  bundle: true,
  format: 'esm',
  splitting: !single,
  chunkNames: 'chunk-[hash]',
  minify: true,
  sourcemap: false,
  target: ['chrome109', 'safari16', 'firefox115'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { __REAL_BACKEND__: demo ? 'false' : 'true', __EMBED__: single ? 'true' : 'false' },
  plugins: demo ? [demoStub] : [],
  legalComments: 'none',
  logLevel: 'info',
});

await cp(path.join(root, 'public'), out, { recursive: true });
await cp(path.join(root, 'src/styles.css'), path.join(out, 'app.css'));
if (!demo) {
  const wasm = path.join(root, 'node_modules/@mtcute/wasm');
  await cp(path.join(wasm, 'mtcute.wasm'), path.join(out, 'mtcute.wasm'));
  await cp(path.join(wasm, 'mtcute-simd.wasm'), path.join(out, 'mtcute-simd.wasm'));
}

// 离线缓存清单 + 版本号（内容一变版本号就变）
const files = (await readdir(out)).filter((f) => f !== 'sw.js').sort();
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(await readFile(path.join(out, f)));
const buildId = hash.digest('hex').slice(0, 12);
const sw = (await readFile(path.join(out, 'sw.js'), 'utf8'))
  .replace('__BUILD_ID__', buildId)
  .replace('__FILES__', JSON.stringify(['./', ...files.map((f) => `./${f}`)]));
await writeFile(path.join(out, 'sw.js'), sw);

// 校验清单：部署后可以核对线上文件有没有被改动
const sums = [];
for (const f of [...files, 'sw.js'].sort()) {
  sums.push(`${createHash('sha256').update(await readFile(path.join(out, f))).digest('hex')}  ${f}`);
}
await writeFile(path.join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`已输出到 ${path.relative(root, out)}/（版本 ${buildId}，${files.length + 1} 个文件）`);

if (single) {
  // 单文件演示：样式、脚本、图标全部内嵌，不引用任何外部文件
  const js = (await readFile(path.join(out, 'app.js'), 'utf8')).replaceAll('</script', '<\\/script');
  const css = await readFile(path.join(out, 'app.css'), 'utf8');
  const icon = `data:image/svg+xml;base64,${(await readFile(path.join(out, 'icon.svg'))).toString('base64')}`;
  const embedCss = `
html, body, #root { height: 100%; }
.app { height: 100%; }
.gate { min-height: 100%; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.list-head { padding-left: 16px; padding-right: 16px; }
.dialog { padding-left: 12px; padding-right: 16px; }
.messages { padding-left: 16px; padding-right: 16px; }
.chat-head { padding-left: 16px; padding-right: 16px; }
.composer { padding-left: 16px; padding-right: 16px; }
`;
  const html = `<title>聚信多账号收件箱</title>
<style>
${css}
${embedCss}
</style>
<div id="root"></div>
<script type="module">
${js.replaceAll('./icon.svg', icon)}
</script>
`;
  await writeFile(path.join(out, 'demo.html'), html);
  console.log(`单文件演示：${path.relative(root, path.join(out, 'demo.html'))}（${(html.length / 1024).toFixed(0)} KB）`);
}
