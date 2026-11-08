# 闪贴

手机和电脑之间传文字、图片和小文件。不用注册。内容在发出前加密，大约十五分钟不用会自动清掉。

## 部署到自己的服务器

需要 Node.js 22。域名解析到这台机器，并用 Nginx 提供 HTTPS。

```bash
npm ci
export VITE_PUBLIC_HOSTNAME=你的域名
export VITE_AUTH_ENABLED=false
export NITRO_PRESET=node-server
npm run build
export PORT=3000
export HOST=127.0.0.1
node .output/server/index.mjs
```

Nginx 反代到 `127.0.0.1:3000`，并带上：

```nginx
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto https;
```

不设置 `DATABASE_URL` 时，数据只留在内存里。进程重启后清空。这适合这种短时传送。

电脑和手机都打开 `https://你的域名`。
