/**
 * ============================================================================
 *  dsh-mobile-remote — 手机远程访问（宿主半）
 * ============================================================================
 *  让手机用 DSH 自己的端口访问电脑：
 *
 *     手机浏览器  →  http://<电脑局域网IP>:<DSH端口>/
 *                     ├─ /             DeepSeek Harness（手机自适应 UI）
 *                     └─ /files/       文件浏览（照片 / 文本 / 视频 / 下载）
 *
 *  为什么能同端口：DSH 只绑定 127.0.0.1:<port>（拒绝 0.0.0.0），
 *  本插件绑定 <局域网IP>:<port>——同一端口的不同地址，互不冲突。
 *
 *  认证：插件运行在 DSH 进程内，直接向 connection 服务取 launchToken，
 *       换成本机 cookie 后注入反代请求，手机端无需关心 token。
 *
 *  作者：AURORAL-极光实验室
 *  联系：1907927628@qq.com
 *  许可：MIT
 *
 *  挂载：profiles/web/cordis.patch.yml
 *    - insert:
 *        - id: mobile-remote
 *          name: dsh-mobile-remote
 *          config:
 *            port: 0            # 0 = 与 DSH 同端口
 *            bindHost: ""       # 空 = 自动检测局域网 IP
 *            filesPort: 8789    # 内部文件服务端口（仅本机）
 *            enabled: true
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

/* ------------------------------------------------------------------ */
/*  常量与身份                                                          */
/* ------------------------------------------------------------------ */
const PLUGIN_NAME = 'mobile-remote'
const INFO_ROUTE = '/dsh-mobile-remote/info'
const ASSET_DIR = path.join(import.meta.dirname, 'mobile-remote-assets')
const FILES_SERVER = path.join(ASSET_DIR, 'server.py')
const MOBILE_JS_PATH = path.join(ASSET_DIR, 'mobile.js')
/** 文件日志：DSH 控制台看不到时用来排查（plugin.log） */
const LOG_FILE = path.join(import.meta.dirname, 'mobile-remote.log')

export const name = PLUGIN_NAME
export const inject = ['webServer']

const AUTHOR = 'AURORAL-极光实验室'
const EMAIL = '1907927628@qq.com'
const VERSION = '1.0.0'
const QR_ROUTE = '/dsh-mobile-remote/qr.svg'

/** 电脑端右下角「手机扫码」浮层样式（注入到 index） */
const FAB_CSS = `
#mbr-fab{position:fixed;right:16px;bottom:16px;z-index:8000;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
#mbr-fab .mbr-fab-card{position:relative;background:rgba(22,28,40,.96);border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:12px 12px 10px;box-shadow:0 16px 44px rgba(0,0,0,.5);text-align:center;-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);min-width:176px}
#mbr-fab .mbr-fab-title{color:#e9eefb;font-size:12px;font-weight:600;line-height:18px}
#mbr-fab .mbr-fab-qr{width:148px;height:148px;display:block;margin:8px auto 6px;background:#fff;border-radius:10px;padding:6px;box-sizing:border-box}
#mbr-fab .mbr-fab-url{color:#8ea4c4;font-size:11px;line-height:16px;font-family:ui-monospace,Consolas,monospace;word-break:break-all}
#mbr-fab .mbr-fab-tip{color:#6d82a3;font-size:10.5px;line-height:15px;margin-top:4px}
#mbr-fab .mbr-fab-close{position:absolute;top:4px;right:6px;border:0;background:0 0;color:#8ea4c4;font-size:16px;line-height:1;cursor:pointer;padding:4px}
#mbr-fab .mbr-fab-close:hover{color:#e9eefb}
@media (max-width:760px){#mbr-fab{display:none}}
`

/** 电脑端注入脚本：只在非手机 UA 下显示扫码浮层 */
const FAB_JS = `(function(){
try{
  if(/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent||''))return;
  if(localStorage.getItem('dsh-mobile-remote:fab')==='hidden')return;
  var done=false;
  function show(){
    if(done||document.getElementById('mbr-fab'))return;
    fetch('/dsh-mobile-remote/info',{cache:'no-store'}).then(function(r){return r.json()}).then(function(info){
      if(!info||!info.running||!info.url||done)return;
      done=true;
      var box=document.createElement('div');
      box.id='mbr-fab';
      var qr='/dsh-mobile-remote/qr.svg?text='+encodeURIComponent(info.url);
      box.innerHTML='<div class="mbr-fab-card">'
        +'<div class="mbr-fab-title">📱 手机扫码访问</div>'
        +'<img class="mbr-fab-qr" src="'+qr+'" alt="手机访问二维码">'
        +'<div class="mbr-fab-url">'+String(info.url).replace(/^https?:\\/\\//,'')+'</div>'
        +'<div class="mbr-fab-tip">同一 Wi-Fi · AI 首页 / files 文件</div>'
        +'<button class="mbr-fab-close" title="收起">×</button>'
        +'</div>';
      document.body.appendChild(box);
      box.querySelector('.mbr-fab-close').addEventListener('click',function(e){
        e.stopPropagation();
        localStorage.setItem('dsh-mobile-remote:fab','hidden');
        box.remove();
      });
    }).catch(function(){});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show);
  else show();
}catch(e){}
})();`

/** 对外暴露给浏览器端 UI 的状态（也是 /dsh-mobile-remote/info 的响应）。 */
const state = {
  plugin: PLUGIN_NAME,
  version: VERSION,
  author: AUTHOR,
  email: EMAIL,
  running: false,
  bindHost: '',
  port: 0,
  url: '',
  filesUrl: '',
  error: '',
  mobileTheme: '',
}

const log = (...args) => {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
  console.log(`[${PLUGIN_NAME}]`, ...args)
  try {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`)
  } catch (err) { /* 日志失败不影响功能 */ }
}

/* ------------------------------------------------------------------ */
/*  工具                                                               */
/* ------------------------------------------------------------------ */
function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function text(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

/** 本机第一个可用的局域网 IPv4（优先 192.168 / 10. / 172.）。 */
function lanIp() {
  const list = []
  for (const items of Object.values(os.networkInterfaces())) {
    for (const it of items || []) {
      if (it.family === 'IPv4' && !it.internal) list.push(it.address)
    }
  }
  const score = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3)
  list.sort((a, b) => score(a) - score(b))
  return list[0] || ''
}

/** 读手机端注入脚本（每次请求现读，改完刷新页面就生效）。 */
function readMobileJs() {
  try {
    return fs.readFileSync(MOBILE_JS_PATH, 'utf8')
  } catch (err) {
    return `/* mobile.js 缺失: ${err.message} */`
  }
}

/** 用 DSH 进程内的 launchToken 换一个本机 authority 的 cookie。 */
function exchangeToken(dshHost, dshPort, token) {
  return new Promise((resolve) => {
    const req = http.request({
      host: dshHost,
      port: dshPort,
      method: 'GET',
      path: `/?token=${encodeURIComponent(token)}`,
      headers: { host: `${dshHost}:${dshPort}`, 'user-agent': 'dsh-mobile-remote/1.0' },
      timeout: 5000,
    }, (res) => {
      const sc = res.headers['set-cookie']
      res.resume()
      resolve(res.statusCode === 303 && sc && sc.length ? String(sc[0]).split(';')[0] : '')
    })
    req.on('timeout', () => { req.destroy(); resolve('') })
    req.on('error', () => resolve(''))
    req.end()
  })
}

/** 兜底：从 Edge / Chrome 历史里找 dsh web 启动 URL 的 token，换 cookie。 */
async function cookieFromBrowserHistory(dshHost, dshPort) {
  try {
    let DatabaseSync = null
    try { ({ DatabaseSync } = await import('node:sqlite')) } catch (err) { /* 无内置 sqlite */ }
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    const bases = [
      path.join(local, 'Microsoft', 'Edge', 'User Data'),
      path.join(local, 'Google', 'Chrome', 'User Data'),
    ]
    const seen = new Set()
    for (const base of bases) {
      let profiles = []
      try {
        profiles = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
      } catch (err) { continue }
      for (const name of profiles) {
        const hist = path.join(base, name, 'History')
        if (!fs.existsSync(hist)) continue
        try {
          const tmp = path.join(os.tmpdir(), `dsh-mob-hist-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
          fs.copyFileSync(hist, tmp)
          let urls = []
          try {
            if (!DatabaseSync) throw new Error('no sqlite')
            const db = new DatabaseSync(tmp)
            urls = db.prepare("SELECT url FROM urls WHERE url LIKE '%token=%' AND url LIKE '%3080%' ORDER BY last_visit_time DESC LIMIT 40").all().map((r) => r.url)
            db.close()
          } catch (err) {
            urls = []
          }
          try { fs.unlinkSync(tmp) } catch (err) { /* ignore */ }
          for (const url of urls) {
            if (seen.has(url)) continue
            seen.add(url)
            try {
              const token = new URL(url).searchParams.get('token')
              if (!token) continue
              const ck = await exchangeToken(dshHost, dshPort, token)
              if (ck) return ck
            } catch (err) { /* ignore */ }
          }
        } catch (err) { /* ignore */ }
      }
    }
  } catch (err) { /* ignore */ }
  return ''
}

/** 轮询一个本机端口直到可用。 */function waitForPort(host, port, timeoutMs = 15000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(port, host)
      sock.setTimeout(800)
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - started > timeoutMs) resolve(false)
        else setTimeout(attempt, 400)
      })
      sock.once('timeout', () => { sock.destroy(); if (Date.now() - started > timeoutMs) resolve(false); else setTimeout(attempt, 400) })
    }
    attempt()
  })
}

/** 等一个本机端口彻底释放（重绑文件服务前用，避免新进程 EADDRINUSE）。 */
function waitForPortGone(host, port, timeoutMs = 5000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const attempt = () => {
      const sock = net.connect(port, host)
      sock.setTimeout(600)
      sock.once('connect', () => {
        sock.destroy()
        if (Date.now() - started > timeoutMs) resolve(false)
        else setTimeout(attempt, 300)
      })
      sock.once('error', () => { sock.destroy(); resolve(true) })
      sock.once('timeout', () => {
        sock.destroy()
        if (Date.now() - started > timeoutMs) resolve(false)
        else setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

/* ------------------------------------------------------------------ */
/*  插件主体                                                            */
/* ------------------------------------------------------------------ */
export function apply(ctx, config = {}) {
  log('apply called, config=' + JSON.stringify(config))
  const cfg = {
    enabled: config.enabled !== false,
    port: Number(config.port) || 0,
    bindHost: String(config.bindHost || ''),
    filesPort: Number(config.filesPort) || 8789,
    mobileTheme: String(config.mobileTheme || ''),
  }
  if (!cfg.enabled) {
    log('已按配置禁用')
    return
  }
  state.mobileTheme = cfg.mobileTheme
  log(`移动端主题: ${cfg.mobileTheme || '跟随系统'}`)

  ctx.inject(['webServer'], (c) => {
    log('webServer 已注入')
    const dshPort = c.webServer.port
    const dshHost = c.webServer.host || '127.0.0.1'
    log(`DSH 监听 ${dshHost}:${dshPort}`)

    /* 浏览器端 UI 查询用的信息路由（注册在 DSH 自己的 webServer 上） */
    c.effect(() => c.webServer.register({
      kind: 'exact',
      path: INFO_ROUTE,
      handler: (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed')
        json(res, 200, state)
      },
    }), `${PLUGIN_NAME}: info 路由`)

    /* 注意：二维码路由与「手机扫码」浮层由独立插件 mobile-remote-qr 提供。
       这里不能重复注册 /dsh-mobile-remote/qr.svg —— webserver 的同路径
       重复注册会抛错，导致整个插件 fiber 启动失败（联调时踩过）。 */

    /* 对外服务 + 内部文件服务的生命周期 */
    c.effect(() => {
      let cleanup = () => { /* noop */ }
      let stopped = false
      start(c, dshHost, dshPort).then((fn) => {
        if (stopped) { fn(); return }
        cleanup = fn
      }).catch((err) => {
        state.error = err && err.message ? err.message : String(err)
        state.running = false
        log('启动失败：', state.error)
      })
      return () => {
        stopped = true
        try { cleanup() } catch (err) { /* 释放期异常忽略 */ }
        state.running = false
      }
    }, `${PLUGIN_NAME}: 对外服务生命周期`)

    async function start(c2, dshHost2, dshPort2) {
      /* 1. 绑定地址与端口在 boot() 内决定：与 DSH 同端口、不同地址。
            局域网 IP 变化后自动重绑（见末尾的「IP 跟随」定时器）。 */
      let liveServer = null
      let livePy = null
      let watchTimer = null
      let filesStopped = false      // 主动停止（重绑/清理）时不触发守护重启
      let filesRestarts = 0         // 文件服务意外退出后的重启次数
      let rebinding = false
      const dsh = { host: dshHost2, port: dshPort2, hostHeader: `${dshHost2}:${dshPort2}` }

      /* 2. 认证 cookie：实时获取 + 后台重试（启动时 connection 服务可能尚未就绪） */
      let authCookie = ''
      let authCookieAt = 0
      let authPromise = null
      const ensureAuthCookie = async (force = false) => {
        const now = Date.now()
        if (!force && authCookie && now - authCookieAt < 5 * 60 * 1000) return authCookie
        if (authPromise) return authPromise
        authPromise = (async () => {
          // 1) 进程内 launchToken（每次实时向 connection 服务取，不缓存连接对象）
          try {
            const conn = (typeof c2.get === 'function' ? c2.get('connection') : null) || c2.connection
            const token = conn && conn.browserAuth && conn.browserAuth.launchToken
            if (token) {
              const ck = await exchangeToken(dshHost2, dshPort2, token)
              if (ck) {
                authCookie = ck
                authCookieAt = Date.now()
                log('已获取 DSH cookie（launchToken）')
                return ck
              }
            }
          } catch (err) { /* ignore */ }
          // 2) 浏览器历史 token 兜底
          try {
            const ck = await cookieFromBrowserHistory(dshHost2, dshPort2)
            if (ck) {
              authCookie = ck
              authCookieAt = Date.now()
              log('已获取 DSH cookie（浏览器历史）')
              return ck
            }
          } catch (err) { /* ignore */ }
          return ''
        })()
        const result = await authPromise
        authPromise = null
        return result
      }
      // 后台预取：connection 可能稍后才就绪（最多重试 30 次 × 2 秒）
      ;(async () => {
        for (let i = 0; i < 30; i++) {
          if (await ensureAuthCookie(true)) return
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
        log('警告：仍未获取到 DSH cookie，AI 页面可能短暂返回等待页（会自动重试）')
      })()

      /* 3-4. 对外服务 + 内部文件服务：由 boot() 建立，IP 变化时可反复重绑 */
      // 优先用插件内置的便携 Python（别人拿到不用装环境），没有才回退系统 python
      const bundledPython = path.join(ASSET_DIR, 'python', 'python.exe')
      const pythonBin = process.env.PYTHON || (fs.existsSync(bundledPython) ? bundledPython : 'python')

      async function boot(host) {
        const port = host === dshHost2 ? dshPort2 + 1 : (cfg.port || dshPort2)
        const publicUrl = `http://${host}:${port}/`

        /* 3. 内部文件服务（Python + Pillow）——带守护：意外退出自动重启 */
        let py = null
        filesStopped = false
        filesRestarts = 0
        const startPy = async () => {
          await waitForPortGone('127.0.0.1', cfg.filesPort, 5000)
          py = spawn(pythonBin, [
            FILES_SERVER,
            '--port', String(cfg.filesPort),
            '--bind', '127.0.0.1',
            '--no-banner', '--no-qr', '--no-browser',
            '--public-url', publicUrl,
            '--parent-pid', String(process.pid),
          ], { cwd: ASSET_DIR, windowsHide: true, stdio: 'ignore' })
          py.on('error', (err) => log('文件服务启动失败：', err.message))
          py.on('exit', (code) => {
            log('文件服务已退出', code)
            if (filesStopped) return
            filesRestarts++
            if (filesRestarts > 8) {
              log('文件服务多次重启失败，停止守护（重启 DSH 可恢复）')
              return
            }
            const delay = Math.min(30000, 800 * Math.pow(2, filesRestarts - 1))
            log(`文件服务将在 ${delay}ms 后自动重启（第 ${filesRestarts} 次）`)
            setTimeout(async () => {
              if (filesStopped) return
              try {
                await startPy()
                livePy = py
                log('文件服务已自动恢复')
              } catch (err) {
                log('文件服务自动重启失败：', err && err.message)
              }
            }, delay)
          })
          const filesReady = await waitForPort('127.0.0.1', cfg.filesPort, 15000)
          if (!filesReady) log('警告：文件服务未就绪，/files/ 可能不可用')
        }
        await startPy()

        /* 4. 对外 HTTP 服务（同端口，局域网地址） */
        const srv = http.createServer((req, res) => {
          try { route(req, res) } catch (err) {
            log('请求处理异常：', err && err.message)
            try { text(res, 500, 'internal error') } catch (e) { /* ignore */ }
          }
        })
        srv.on('upgrade', (req, socket, head) => {
          try { upgrade(req, socket, head) } catch (err) { try { socket.destroy() } catch (e) { /* ignore */ } }
        })

        await new Promise((resolve, reject) => {
          srv.once('error', reject)
          srv.listen(port, host, () => resolve())
        })

        liveServer = srv
        livePy = py
        state.running = true
        state.bindHost = host
        state.port = port
        state.url = publicUrl
        state.filesUrl = publicUrl + 'files/'
        state.error = ''
        log(`手机访问已就绪：${publicUrl}   （文件：${state.filesUrl}）`)
        log(`作者：${AUTHOR} <${EMAIL}>`)
      }

      /** 关掉当前对外服务与文件服务（重绑前调用）。 */
      async function teardown() {
        state.running = false
        filesStopped = true
        const srv = liveServer
        liveServer = null
        if (srv) {
          await new Promise((resolve) => {
            let done = false
            const finish = () => { if (!done) { done = true; resolve() } }
            try { srv.close(finish) } catch (err) { finish() }
            setTimeout(finish, 1500)
          })
        }
        const py = livePy
        livePy = null
        if (py) { try { py.kill() } catch (err) { /* ignore */ } }
      }

      /* 首次绑定：config 指定优先，否则自动检测局域网 IP */
      const firstHost = cfg.bindHost || lanIp()
      if (!firstHost) throw new Error('没有检测到局域网 IP，请在插件 config 里设置 bindHost')
      await boot(firstHost)

      /* ---------------- 路由分流 ---------------- */
      function route(req, res) {
        const pathname = (req.url || '/').split('?')[0]
        // 访问日志：记录文档/注入脚本请求（排查多设备与缓存问题）
        try {
          if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/__mobile/mobile.js')) {
            const rawIp = req.headers['cf-connecting-ip'] || req.socket.remoteAddress || ''
            const ip = String(rawIp).replace(/^::ffff:/, '')
            const ua = String(req.headers['user-agent'] || '').slice(0, 90)
            const ref = String(req.headers['referer'] || '').slice(0, 80)
            log(`访问 ${pathname} from ${ip} UA=${ua} REF=${ref}`)
          }
        } catch (err) { /* ignore */ }

        // 手机端注入脚本
        if (pathname === '/__mobile/mobile.js') {
          return text(res, 200, readMobileJs(), 'text/javascript; charset=utf-8')
        }
        if (pathname === '/__mobile/health') {
          return json(res, 200, { ok: state.running, url: state.url, files: state.filesUrl })
        }

        // 文件浏览：/files/... → 内部 Python（/files/fapi/... → /api/...）
        if (pathname === '/files') {
          res.writeHead(302, { location: '/files/', 'cache-control': 'no-store' })
          return res.end()
        }
        if (pathname.startsWith('/files/')) {
          let upstream = req.url.slice('/files'.length)
          if (upstream.startsWith('/fapi/')) upstream = '/api/' + upstream.slice('/fapi/'.length)
          else if (upstream === '/fmanifest.webmanifest' || upstream.startsWith('/fmanifest.webmanifest?')) {
            upstream = '/manifest.webmanifest' + upstream.slice('/fmanifest.webmanifest'.length)
          }
          return proxyFiles(req, res, upstream)
        }

        // 其余全部是 DSH
        return proxyDsh(req, res)
      }

      /* ---------------- 文件服务反代 ---------------- */
      function proxyFiles(req, res, upstreamPath) {
        const headers = { ...req.headers, host: `127.0.0.1:${cfg.filesPort}` }
        delete headers['accept-encoding']
        const up = http.request({
          host: '127.0.0.1',
          port: cfg.filesPort,
          method: req.method,
          path: upstreamPath,
          headers,
        }, (upRes) => {
          const h = { ...upRes.headers }
          delete h['transfer-encoding']
          res.writeHead(upRes.statusCode, h)
          upRes.pipe(res)
        })
        up.on('error', () => {
          if (res.headersSent) return
          text(res, 502, '文件服务未就绪，请稍后刷新')
        })
        req.pipe(up)
      }

      /* ---------------- DSH 反代 ---------------- */
      function upstreamHeaders(req, cookie) {
        const h = { ...req.headers }
        h.host = dsh.hostHeader
        delete h.cookie
        if (cookie) h.cookie = cookie
        if (h.origin) h.origin = `http://${dsh.hostHeader}`
        if (h.referer) h.referer = String(h.referer).replace(/^https?:\/\/[^/]+/, `http://${dsh.hostHeader}`)
        h['sec-fetch-site'] = 'same-origin'
        return h
      }

      /** 认证等待页：DSH cookie 还没就绪时给用户一个自动重试的页面。 */
      function waitingPage(res, retryAfter = 3) {
        res.writeHead(503, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'retry-after': String(retryAfter),
        })
        res.end('<!doctype html><html><head><meta charset="utf-8">'
          + '<meta name="viewport" content="width=device-width,initial-scale=1">'
          + `<meta http-equiv="refresh" content="${retryAfter}">`
          + '<title>正在连接 DSH…</title></head>'
          + '<body style="font-family:system-ui,-apple-system,sans-serif;padding:40px 24px;max-width:560px;margin:auto;line-height:1.8">'
          + '<h2>⏳ 正在连接 DSH…</h2>'
          + '<p>插件正在获取 DSH 认证，请稍候（页面会自动刷新）。</p>'
          + '<p style="color:#888;font-size:14px">如果长时间停留在这里，请重启一次 DSH 后刷新。</p>'
          + '</body></html>')
      }

      async function proxyDsh(req, res, retried = false) {
        try {
          const pathname = (req.url || '/').split('?')[0]
          const isDocument = req.method === 'GET' && (pathname === '/' || pathname === '/index.html')
          const cookie = await ensureAuthCookie()
          const upHeaders = upstreamHeaders(req, cookie)
          if (isDocument) delete upHeaders['accept-encoding']

          const proxyReq = http.request({
            host: dsh.host,
            port: dsh.port,
            method: req.method,
            path: req.url,
            headers: upHeaders,
          }, (proxyRes) => {
            // cookie 失效：强制刷新后自动重试一次（只对 GET/HEAD，避免请求体丢失）
            if (proxyRes.statusCode === 401 && (req.method === 'GET' || req.method === 'HEAD')) {
              proxyRes.resume()
              if (!retried) {
                authCookie = ''
                authCookieAt = 0
                log('DSH 返回 401，刷新 cookie 后重试')
                ensureAuthCookie(true).finally(() => setTimeout(() => proxyDsh(req, res, true), 150))
                return
              }
              // 重试后仍 401：返回自动刷新等待页，而不是 DSH 的错误页
              waitingPage(res, 3)
              return
            }

            const headers = { ...proxyRes.headers }
            delete headers['set-cookie']
            delete headers['strict-transport-security']

            // 页面文档注入手机端脚本（并强制不缓存，避免手机/平板拿到旧页面）
            if (isDocument && /text\/html/i.test(String(headers['content-type'] || ''))) {
              headers['cache-control'] = 'no-store, no-cache, must-revalidate'
              headers['pragma'] = 'no-cache'
              delete headers.etag
              delete headers['last-modified']
              const chunks = []
              proxyRes.on('data', (chunk) => chunks.push(chunk))
              proxyRes.on('end', () => {
                let html = Buffer.concat(chunks).toString('utf8')
                const tag = '<script src="/__mobile/mobile.js" defer></script>'
                html = html.includes('</body>') ? html.replace('</body>', tag + '</body>') : html + tag
                const buf = Buffer.from(html, 'utf8')
                headers['content-length'] = String(buf.length)
                delete headers['transfer-encoding']
                delete headers['content-encoding']
                res.writeHead(proxyRes.statusCode, headers)
                res.end(buf)
              })
              proxyRes.on('error', () => { try { res.destroy() } catch (e) { /* ignore */ } })
              return
            }

            res.writeHead(proxyRes.statusCode, headers)
            proxyRes.pipe(res)
          })

          proxyReq.on('error', (err) => {
            if (res.headersSent) return
            text(res, 502, '无法连接 DSH 服务：' + err.message)
          })
          req.pipe(proxyReq)
        } catch (err) {
          log('DSH 反代异常：', err && err.message)
          if (!res.headersSent) {
            try { text(res, 500, '代理异常：' + (err && err.message)) } catch (e) { /* ignore */ }
          }
        }
      }

      /* ---------------- WebSocket 反代 ---------------- */

      /* ---------------- WebSocket 反代 ---------------- */
      function upgrade(req, socket, head) {
        const upstream = net.connect(dsh.port, dsh.host, () => {
          const h = upstreamHeaders(req, authCookie)
          delete h.connection
          delete h.upgrade
          delete h['sec-websocket-key']
          delete h['sec-websocket-version']
          delete h['sec-websocket-extensions']
          delete h['sec-websocket-protocol']

          const lines = [`GET ${req.url} HTTP/1.1`]
          for (const [key, value] of Object.entries(h)) {
            if (Array.isArray(value)) value.forEach((v) => lines.push(`${key}: ${v}`))
            else if (value !== undefined) lines.push(`${key}: ${value}`)
          }
          lines.push('Connection: Upgrade')
          lines.push('Upgrade: websocket')
          lines.push(`Sec-WebSocket-Key: ${req.headers['sec-websocket-key']}`)
          lines.push('Sec-WebSocket-Version: 13')
          if (req.headers['sec-websocket-protocol']) {
            lines.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`)
          }
          upstream.write(lines.join('\r\n') + '\r\n\r\n')
          if (head && head.length) upstream.write(head)
          upstream.pipe(socket)
          socket.pipe(upstream)
        })
        upstream.on('error', () => { try { socket.destroy() } catch (e) { /* ignore */ } })
        socket.on('error', () => { try { upstream.destroy() } catch (e) { /* ignore */ } })
        socket.on('close', () => { try { upstream.destroy() } catch (e) { /* ignore */ } })
        upstream.on('close', () => { try { socket.destroy() } catch (e) { /* ignore */ } })
      }

      /* ---------------- 5. 局域网 IP 跟随 ---------------- */
      /* 换网络 / 路由器重启后 DHCP 会换地址；这里每 6 秒核对一次，
         一变就在几秒内把对外服务重绑到新地址，手机 URL / 二维码随之更新。 */
      if (!cfg.bindHost) {
        watchTimer = setInterval(async () => {
          if (rebinding) return
          const nowIp = lanIp()
          if (!nowIp || nowIp === state.bindHost) return
          rebinding = true
          const prevIp = state.bindHost
          log(`检测到局域网 IP 变化：${prevIp || '(未绑定)'} → ${nowIp}，开始自动重绑`)
          try {
            await teardown()
            await boot(nowIp)
            log(`自动重绑完成：${state.url}`)
          } catch (err) {
            state.error = err && err.message ? err.message : String(err)
            state.running = false
            log('自动重绑失败：', state.error)
          } finally {
            rebinding = false
          }
        }, 6000)
        if (typeof watchTimer.unref === 'function') watchTimer.unref()
      }

      /* ---------------- 清理句柄 ---------------- */
      return () => {
        filesStopped = true
        if (watchTimer) { clearInterval(watchTimer); watchTimer = null }
        if (liveServer) { try { liveServer.close() } catch (err) { /* ignore */ } liveServer = null }
        if (livePy) { try { livePy.kill() } catch (err) { /* ignore */ } livePy = null }
        state.running = false
        log('对外服务已停止')
      }
    }
  })
}

export default { name, inject, apply }
