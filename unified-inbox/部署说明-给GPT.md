# 聚信 部署说明（给 GPT）

这份说明是写给负责服务器部署的 GPT 的。读完这一份就能独立完成部署，不需要之前的任何聊天记录，也不需要再向老板提问。

## 0. 你要做的事，一句话

把本目录打包出来的 `dist/` 文件夹，原样放到一个 **https 网址**上，让老板的电脑和手机都能打开。然后按第 5 节验收，按第 6 节把结果回报。

**这是一个纯静态网页应用。没有后台程序，没有数据库，没有接口，不需要任何密钥或环境变量。** 服务器只负责把文件发出去。所有账号凭据都在老板自己的设备上加密保存，永远不经过这台服务器。

## 1. 这个软件是什么（背景，了解即可）

- 名字：聚信。多账号 Telegram 聚合收件箱，老板个人使用。
- 形态：可安装的网页应用（PWA）。浏览器打开后可以装到电脑桌面或手机主屏幕。
- 用户的浏览器会**直接**连接官方服务器 `wss://*.web.telegram.org`。这条连接不经过我们的服务器，**不要给它加反向代理或中转**。
- 源码位置：仓库根目录下的 `unified-inbox/`，分支 `claude/dreamy-davinci-gbldjk`。
- 与仓库里的「新游戏入口」交接包没有任何关系，互不依赖，不要混在一起部署。

## 2. 打包

环境：Node.js 22.18 及以上（建议 24），npm 10 及以上。

```bash
cd unified-inbox
```

```bash
npm ci
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run build
```

预期结果：

- `npm test` 输出 `# pass 49`、`# fail 0`。有任何失败就停下来回报，不要部署。
- `npm run build` 生成 `dist/`，里面是 13 个文件：`index.html`、`app.js`、`app.css`、两个 `chunk-*.js`、`mtcute.wasm`、`mtcute-simd.wasm`、`sw.js`、`manifest.webmanifest`、`icon.svg`、三个 `icon-*.png`，外加一份 `SHA256SUMS.txt`。

**必须从源码打包，不要用任何人发来的现成 `dist/`。**

## 3. 部署（两种方式，选一种）

### 方式 A：GitHub Pages（最省事，没有服务器要维护）

仓库里已有流程文件 `.github/workflows/unified-inbox-pages.yml`，只能手动触发。

1. 流程文件必须在仓库默认分支上才能手动触发，所以先把分支 `claude/dreamy-davinci-gbldjk` 合并到默认分支（需要老板同意合并）。
2. 仓库 Settings → Pages → Source 选 **GitHub Actions**。
3. 仓库 Actions → 选「发布聚信到 GitHub Pages」→ Run workflow。
4. 跑完后，流程页面上会显示网址，形如 `https://<用户名>.github.io/<仓库名>/`。

注意：

- 私有仓库使用 Pages 需要付费套餐。如果 Settings 里没有 Pages 选项或提示需要升级，改用方式 B，不要为此把仓库改成公开（仓库里有公司其他源码）。
- Pages 发布出去的只有 `dist/` 里的文件，不包含仓库其他内容。但网址本身是公开可访问的——页面上没有任何数据，别人打开只能看到一个要求设置主密码的空软件。

### 方式 B：自己的服务器

要求：

- 一个域名或子域名，有效的 https 证书。**必须是 https**，http 下浏览器会拒绝提供加密功能，软件会直接提示无法运行。
- 把 `dist/` 里的全部文件放到网站根目录或任意子目录（软件内部全部用相对路径，放子目录也能正常工作，已验证）。
- `.wasm` 文件的 Content-Type 必须是 `application/wasm`。
- `index.html` 和 `sw.js` 不要长期缓存，否则更新发不下去。

Nginx 参考配置（**我没有在真实 Nginx 上运行过这份配置**，请先用 `nginx -t` 检查语法，再按第 5 节验收）：

```nginx
server {
    listen 443 ssl http2;
    server_name inbox.example.com;          # 换成实际域名

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    root /var/www/juxin;                    # dist/ 里的文件放这里
    index index.html;

    types {
        text/html                 html;
        text/css                  css;
        text/javascript           js;
        application/wasm          wasm;
        application/manifest+json webmanifest;
        image/svg+xml             svg;
        image/png                 png;
        text/plain                txt;
    }
    default_type application/octet-stream;
    charset utf-8;

    add_header Strict-Transport-Security "max-age=31536000" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Cross-Origin-Opener-Policy "same-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    add_header Cache-Control "no-cache" always;

    location / {
        try_files $uri $uri/ =404;
    }

    # 不留访问日志里的查询串，不开目录列表
    autoindex off;
}

server {
    listen 80;
    server_name inbox.example.com;
    return 301 https://$host$request_uri;
}
```

如果用 Caddy，更简单（自动申请证书；同样未实际运行过）：

```
inbox.example.com {
    root * /var/www/juxin
    file_server
    header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options "nosniff"
        X-Frame-Options "DENY"
        Referrer-Policy "no-referrer"
        Cross-Origin-Opener-Policy "same-origin"
        Cache-Control "no-cache"
    }
}
```

## 4. 禁止事项（每一条都直接关系到账号安全）

1. **不要改 `index.html` 里的 Content-Security-Policy。** 它限定页面只能运行自带代码、只能连接本站和官方服务器。放宽它等于给盗号开门。
2. **不要往页面里加任何东西**：统计代码、监控脚本、客服插件、广告、外部字体、CDN 加速脚本，一概不要。
3. **不要放在会改写页面内容的 CDN 或代理后面**（自动压缩改写 JS、注入脚本、「加速优化」之类的功能全部关掉）。如果一定要用 CDN，只允许原样转发。
4. **不要给 `wss://*.web.telegram.org` 做反向代理、中转或镜像。** 连接必须从用户浏览器直达官方。
5. **不要在服务器上保存或记录任何用户数据。** 本来也没有数据会到服务器；访问日志保持默认即可，不要加请求体记录。
6. **不要把网址发到公开场合。** 只给老板本人。
7. **不要和别的站点共用同一个域名（同一个 origin）。** 同域名下的其他页面能读到本软件存在浏览器里的加密数据文件。请用独立的子域名，或 GitHub Pages 的独立地址。
8. **不要把分支强推、改历史，也不要在未经老板同意时合并或公开仓库。**
9. **不要试图「优化」登录**：不要改 `src/core/env.ts` 里上报的设备信息，不要把它改成官方客户端的样子，不要填别人的或官方的 api_id。这些做法会让账号被官方判为环境异常。

## 5. 验收（部署完逐条做，全部通过才算完成）

设网址为 `$URL`（以 `/` 结尾）。

**5.1 文件原样、没被改动**

在打包的机器上进入 `dist/`，对线上每个文件核对哈希：

```bash
cd dist && while read -r sum name; do printf '%s  %s\n' "$(curl -fsS "$URL$name" | sha256sum | cut -d' ' -f1)" "$name"; done < SHA256SUMS.txt | diff - SHA256SUMS.txt && echo 全部一致
```

预期输出「全部一致」。有任何差异说明中间有东西改写了文件（见禁止事项第 3 条），必须解决。

**5.2 响应头**

```bash
curl -sI "$URL" | grep -iE "strict-transport|x-content-type|content-type"
```

```bash
curl -sI "${URL}mtcute.wasm" | grep -i content-type
```

预期：首页是 `text/html`；`.wasm` 是 `application/wasm`；有 `X-Content-Type-Options: nosniff`。（GitHub Pages 不能自定义响应头，只需确认 Content-Type 正确。）

**5.3 http 自动跳转 https**

```bash
curl -sI "http://${URL#https://}" | head -3
```

预期 301 或 308 跳到 https。

**5.4 浏览器里实际打开**（电脑 Chrome 或 Edge，打开开发者工具的 Console）

- 页面显示「先设置一个主密码」。
- Console 里没有红色报错，特别是没有 `Content Security Policy` 相关的报错。
- Network 里所有请求都是本站地址，没有任何第三方域名。
- 地址栏右侧出现「安装」图标。

到这一步为止不需要任何账号。**不要自己设置主密码往下走，更不要用任何账号登录**——那是老板本人的操作。验收只做到这里。

**5.5 手机**

用手机浏览器打开同一个网址，能看到同样的界面，页面不会左右晃动。

## 6. 完成后回报给老板的内容

用下面的格式，逐项如实填写，没做的写「没做」和原因：

```
聚信部署结果
- 网址：
- 部署方式：GitHub Pages / 自己的服务器（哪台）
- 打包所用提交：<git rev-parse HEAD 的结果>
- npm test：通过 __ 项，失败 __ 项
- 5.1 文件哈希核对：全部一致 / 有差异（哪些）
- 5.2 响应头：
- 5.3 http 跳转：
- 5.4 浏览器打开：正常 / 有报错（原文）
- 5.5 手机打开：正常 / 有问题
- 没做或没验证的事项：
```

## 7. 以后更新

源码有更新时：重新执行第 2 节打包，把 `dist/` 全部文件覆盖上去，再做一遍第 5 节的 5.1 和 5.4。用户那边刷新页面即可拿到新版，已登录的账号不受影响（数据在用户浏览器里，与服务器上的文件无关）。

**不要删除或更换域名**：浏览器里的加密数据是按域名存放的，换了域名等于换了一台新设备，老板要把所有账号重新登录一遍，而短时间内重新登录大量账号有被官方风控的风险。

## 8. 已知情况（如实告知）

- 开发环境连不上官方服务器，所以**用真实账号登录、收发消息还没有实际跑过**。连接层按接口库的类型定义逐项核对，自动化测试用的是模拟连接。第一次真实登录由老板本人用一个不重要的账号进行；如果报错，把界面上的中文提示原文和 Console 里的报错原文交回给开发方修改，**不要自行修改连接层代码**。
- 用户的设备必须本身能连上官方服务器（和使用官方网页版的条件相同）。这不是服务器能解决的，也不要试图用服务器代理来解决（见禁止事项第 4 条）。
- 第 3 节的 Nginx 和 Caddy 配置是按标准写法写的参考，没有在真实服务器上运行过。
