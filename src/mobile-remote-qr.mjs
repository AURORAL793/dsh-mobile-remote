/**
 * ============================================================================
 *  mobile-remote-qr — 手机访问二维码入口（常驻按钮 + 弹窗）
 * ============================================================================
 *  配合 dsh-mobile-remote 主插件使用：
 *    1. 在 DSH 左上角（logo 行右侧）注入常驻「手机」按钮
 *    2. 点击弹出二维码弹窗（可复制地址、随时再开）
 *    3. 右下角浮层仅首次出现（引导），关闭后从左上角按钮再次打开
 *    4. 注册 /dsh-mobile-remote/qr.svg 二维码路由（同源转发内部文件服务）
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

/** 样式：左上角按钮 + 二维码弹窗 + 首次浮层 */
const FAB_CSS = [
  /* ---- 左上角常驻按钮（插入 logo 行，靠右） ---- */
  '#mbr-qr-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;',
  '  height:28px;min-width:30px;padding:0 8px;margin-left:auto;flex:none;',
  '  border:1px solid rgba(255,255,255,.14);border-radius:8px;',
  '  background:rgba(20,26,38,.55);color:#e9eefb;cursor:pointer;',
  '  font:500 12px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
  '  -webkit-tap-highlight-color:transparent;transition:background .15s;}',
  '#mbr-qr-btn:hover{background:rgba(52,66,90,.92);}',
  '#mbr-qr-btn svg{width:15px;height:15px;flex:none;}',
  /* ---- 二维码弹窗 ---- */
  '#mbr-qr-modal{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;',
  '  background:rgba(4,7,12,.55);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);padding:20px;}',
  '#mbr-qr-modal.open{display:flex;}',
  '#mbr-qr-card{position:relative;width:100%;max-width:340px;background:rgba(22,28,40,.98);',
  '  border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:18px;',
  '  box-shadow:0 24px 60px rgba(0,0,0,.6);',
  '  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}',
  '#mbr-qr-card h3{margin:0 0 12px;color:#e9eefb;font-size:15px;font-weight:650;}',
  '#mbr-qr-card .mbr-qr-img{display:block;width:100%;max-width:260px;margin:0 auto 10px;',
  '  background:#fff;border-radius:10px;padding:8px;box-sizing:border-box;}',
  '#mbr-qr-card .mbr-qr-url{color:#8ea4c4;font:12px/1.5 ui-monospace,Consolas,monospace;',
  '  text-align:center;word-break:break-all;}',
  '#mbr-qr-card .mbr-qr-tip{color:#6d82a3;font-size:11px;line-height:1.5;text-align:center;margin-top:8px;}',
  '#mbr-qr-card .mbr-qr-actions{display:flex;gap:8px;margin-top:12px;}',
  '#mbr-qr-card .mbr-qr-actions button{flex:1;padding:9px;border-radius:10px;',
  '  font:500 13px/1 inherit;cursor:pointer;}',
  '#mbr-qr-card .mbr-qr-copy{border:1px solid rgba(255,255,255,.2);background:transparent;color:#cfdcf5;}',
  '#mbr-qr-card .mbr-qr-copy:hover{background:rgba(255,255,255,.08);}',
  '#mbr-qr-card .mbr-qr-close2{border:0;background:linear-gradient(135deg,#4f8cff,#8b5cf6);color:#fff;}',
  '#mbr-qr-card .mbr-qr-x{position:absolute;top:8px;right:10px;border:0;background:0 0;',
  '  color:#8ea4c4;font-size:20px;line-height:1;cursor:pointer;padding:2px 6px;}',
  '#mbr-qr-card .mbr-qr-x:hover{color:#e9eefb;}',
  /* ---- 右下角首次浮层 ---- */
  '#mbr-fab{position:fixed;right:16px;bottom:16px;z-index:8000;',
  '  font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
  '#mbr-fab .mbr-fab-card{position:relative;background:rgba(22,28,40,.96);border:1px solid rgba(255,255,255,.14);',
  '  border-radius:16px;padding:12px 12px 10px;box-shadow:0 16px 44px rgba(0,0,0,.5);text-align:center;',
  '  -webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);min-width:176px}',
  '#mbr-fab .mbr-fab-title{color:#e9eefb;font-size:12px;font-weight:600;line-height:18px}',
  '#mbr-fab .mbr-fab-qr{width:148px;height:148px;display:block;margin:8px auto 6px;background:#fff;',
  '  border-radius:10px;padding:6px;box-sizing:border-box}',
  '#mbr-fab .mbr-fab-url{color:#8ea4c4;font-size:11px;line-height:16px;',
  '  font-family:ui-monospace,Consolas,monospace;word-break:break-all}',
  '#mbr-fab .mbr-fab-tip{color:#6d82a3;font-size:10.5px;line-height:15px;margin-top:4px}',
  '#mbr-fab .mbr-fab-close{position:absolute;top:4px;right:6px;border:0;background:0 0;',
  '  color:#8ea4c4;font-size:16px;line-height:1;cursor:pointer;padding:4px}',
  '#mbr-fab .mbr-fab-close:hover{color:#e9eefb}',
  '@media (max-width:760px){#mbr-fab,#mbr-qr-btn{display:none}}',
].join('\n')

/** 注入脚本：左上角常驻按钮 + 二维码弹窗 + 首次浮层 */
const FAB_JS = `(function(){
try{
  if(/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent||''))return;
  function boot(){
    fetch('/dsh-mobile-remote/info',{cache:'no-store'}).then(function(r){return r.json()}).then(function(info){
      if(!info||!info.running||!info.url)return;
      var url=info.filesUrl||info.url;
      var qrSrc='/dsh-mobile-remote/qr.svg?text='+encodeURIComponent(url);
      var pretty=String(url).replace(/^https?:\\/\\//,'');

      /* ---- 左上角常驻按钮 ---- */
      if(!document.getElementById('mbr-qr-btn')){
        var btn=document.createElement('button');
        btn.id='mbr-qr-btn';
        btn.title='手机访问二维码';
        btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM19 19h2v2h-2z"/></svg><span>手机</span>';
        var row=document.querySelector('[class*="logoRow"]');
        if(row){ row.appendChild(btn); }
        else { document.body.appendChild(btn); btn.style.position='fixed'; btn.style.left='8px'; btn.style.top='8px'; btn.style.zIndex='9000'; }
      }

      /* ---- 二维码弹窗 ---- */
      if(!document.getElementById('mbr-qr-modal')){
        var modal=document.createElement('div');
        modal.id='mbr-qr-modal';
        modal.innerHTML='<div id="mbr-qr-card">'
          +'<button class="mbr-qr-x" title="关闭">×</button>'
          +'<h3>📱 手机扫码访问</h3>'
          +'<img class="mbr-qr-img" src="'+qrSrc+'" alt="手机访问二维码">'
          +'<div class="mbr-qr-url">'+pretty+'</div>'
          +'<div class="mbr-qr-tip">同一 Wi-Fi · 扫码进文件浏览，再进 AI 对话</div>'
          +'<div class="mbr-qr-actions">'
          +'<button class="mbr-qr-copy">复制地址</button>'
          +'<button class="mbr-qr-close2">关闭</button>'
          +'</div></div>';
        document.body.appendChild(modal);
        var copyBtn=modal.querySelector('.mbr-qr-copy');
        copyBtn.addEventListener('click',function(){
          try{
            if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(url);}
            copyBtn.textContent='已复制';
            setTimeout(function(){copyBtn.textContent='复制地址';},1500);
          }catch(e){}
        });
      }
      var btnEl=document.getElementById('mbr-qr-btn');
      var modalEl=document.getElementById('mbr-qr-modal');
      function open(){ modalEl.classList.add('open'); }
      function close(){ modalEl.classList.remove('open'); }
      if(btnEl){ btnEl.addEventListener('click',open); }
      modalEl.querySelector('.mbr-qr-x').addEventListener('click',close);
      modalEl.querySelector('.mbr-qr-close2').addEventListener('click',close);
      modalEl.addEventListener('click',function(e){ if(e.target===modalEl)close(); });
      document.addEventListener('keydown',function(e){ if(e.key==='Escape')close(); });

      /* ---- 右下角首次浮层（关闭后不再自动出现，可从左上角按钮再开） ---- */
      if(localStorage.getItem('dsh-mobile-remote:fab')!=='hidden' && !document.getElementById('mbr-fab')){
        var box=document.createElement('div');
        box.id='mbr-fab';
        box.innerHTML='<div class="mbr-fab-card">'
          +'<div class="mbr-fab-title">📱 手机扫码 · 文件/对话</div>'
          +'<img class="mbr-fab-qr" src="'+qrSrc+'" alt="手机访问二维码">'
          +'<div class="mbr-fab-url">'+pretty+'</div>'
          +'<div class="mbr-fab-tip">关闭后可从左上角「手机」按钮再次打开</div>'
          +'<button class="mbr-fab-close" title="收起">×</button></div>';
        document.body.appendChild(box);
        box.querySelector('.mbr-fab-close').addEventListener('click',function(e){
          e.stopPropagation();
          localStorage.setItem('dsh-mobile-remote:fab','hidden');
          box.remove();
        });
      }
    }).catch(function(){});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot);
  else boot();
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

      /* index 注入：左上角常驻按钮 + 弹窗 + 首次浮层 */
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
      }, 'mobile-remote-qr: 二维码入口注入')
    })
  },
}
