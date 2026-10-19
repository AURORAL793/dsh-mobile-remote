/**
 * ============================================================================
 *  mobile-remote-qr — 手机扫码入口（独立宿主插件）
 * ============================================================================
 *  配合 dsh-mobile-remote 主插件使用，只负责两件事：
 *    1. 往 DSH 的 index.html 注入右下角「手机扫码」浮层（电脑端可见，手机端隐藏）
 *    2. 注册 /dsh-mobile-remote/qr.svg 二维码路由（转发内部文件服务的 /qr.svg，同源）
 *
 *  为什么单独一个文件：宿主插件放在 profiles/web/plugins/ 下时，
 *  Cordis HMR 会监听该目录并热重载——改完立即生效，不用重启 dsh。
 *
 *  作者：AURORAL-极光实验室 <1907927628@qq.com>
 *  许可：MIT
 */
import http from 'node:http'

const FILES_PORT = 8789
const QR_ROUTE = '/dsh-mobile-remote/qr.svg'

/** 右下角浮层样式 */
const FAB_CSS = [
  '#mbr-fab{position:fixed;right:16px;bottom:16px;z-index:8000;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
  '#mbr-fab .mbr-fab-card{position:relative;background:rgba(22,28,40,.96);border:1px solid rgba(255,255,255,.14);border-radius:16px;padding:12px 12px 10px;box-shadow:0 16px 44px rgba(0,0,0,.5);text-align:center;-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);min-width:176px}',
  '#mbr-fab .mbr-fab-title{color:#e9eefb;font-size:12px;font-weight:600;line-height:18px}',
  '#mbr-fab .mbr-fab-qr{width:148px;height:148px;display:block;margin:8px auto 6px;background:#fff;border-radius:10px;padding:6px;box-sizing:border-box}',
  '#mbr-fab .mbr-fab-url{color:#8ea4c4;font-size:11px;line-height:16px;font-family:ui-monospace,Consolas,monospace;word-break:break-all}',
  '#mbr-fab .mbr-fab-tip{color:#6d82a3;font-size:10.5px;line-height:15px;margin-top:4px}',
  '#mbr-fab .mbr-fab-close{position:absolute;top:4px;right:6px;border:0;background:0 0;color:#8ea4c4;font-size:16px;line-height:1;cursor:pointer;padding:4px}',
  '#mbr-fab .mbr-fab-close:hover{color:#e9eefb}',
  '@media (max-width:760px){#mbr-fab{display:none}}',
].join('\n')

/** 电脑端注入脚本：只在非手机 UA 下显示扫码浮层（幂等，重复注入不会叠加） */
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
      var qr='/dsh-mobile-remote/qr.svg?text='+encodeURIComponent(info.filesUrl||info.url);
      box.innerHTML='<div class="mbr-fab-card">'
        +'<div class="mbr-fab-title">📱 手机扫码 · 文件/对话</div>'
        +'<img class="mbr-fab-qr" src="'+qr+'" alt="手机访问二维码">'
        +'<div class="mbr-fab-url">'+String(info.filesUrl||info.url).replace(/^https?:\\/\\//,'')+'</div>'
        +'<div class="mbr-fab-tip">同一 Wi-Fi · 先进文件浏览，再进 AI 对话</div>'
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

/** 转发内部文件服务的二维码（同源，避免跨源图片） */
function serveQr(req, res) {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const up = http.get({ host: '127.0.0.1', port: FILES_PORT, path: '/qr.svg' + query, timeout: 5000 }, (upRes) => {
    const headers = { ...upRes.headers }
    delete headers['transfer-encoding']
    res.writeHead(upRes.statusCode, headers)
    upRes.pipe(res)
  })
  up.on('timeout', () => { up.destroy(); res.writeHead(504); res.end('qr timeout') })
  up.on('error', () => {
    try { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('qr unavailable') } catch (err) { /* ignore */ }
  })
}

export default {
  name: 'mobile-remote-qr',
  apply(ctx) {
    ctx.inject(['webServer'], (c) => {
      /* 二维码路由（主插件若已注册同一路由则忽略冲突） */
      c.effect(() => {
        let dispose = null
        try {
          dispose = c.webServer.register({ kind: 'exact', path: QR_ROUTE, handler: serveQr })
        } catch (err) {
          console.error('[mobile-remote-qr] 二维码路由注册失败（可能已被主插件占用）:', err && err.message)
        }
        return () => { if (typeof dispose === 'function') dispose() }
      }, 'mobile-remote-qr: /dsh-mobile-remote/qr.svg')

      /* index 注入：右下角扫码浮层 */
      c.effect(() => {
        const rows = [
          { kind: 'style', text: FAB_CSS },
          { kind: 'script', placement: 'body', text: FAB_JS },
        ]
        const listener = (...args) => {
          const table = args.find((candidate) => Array.isArray(candidate))
          if (table) table.push(...rows)
        }
        const dispose = c.on('webserver/index-inject', listener)
        return () => { if (typeof dispose === 'function') dispose() }
      }, 'mobile-remote-qr: 扫码浮层注入')
    })
  },
}
