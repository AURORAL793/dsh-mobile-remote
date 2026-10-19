/**
 * DSH 手机端 UI 布局改造（由代理注入）
 * ============================================================
 * 桌面版 DSH 在 390px 手机上：侧边栏展开 280px，聊天区只剩 110px。
 * 这里改成：
 *   1. 侧边栏 = 覆盖式抽屉（不挤压聊天区），带半透明遮罩
 *   2. 收起时侧边栏完全移出屏幕，聊天区全宽
 *   3. 左上角浮动 ☰ 按钮打开抽屉
 *   4. 隐藏桌面专属控件（右侧栏/分栏/新标签页）
 *   5. 输入框 16px 防 iOS 自动放大 + 底部安全区
 *   6. 首次使用引导
 */
(function () {
  'use strict';

  var HINT_KEY = 'dsh-mobile-hint-v3';
  var isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  if (!isMobile) return;

  var CSS = [
    /* ---- frame 原来是 grid: 56px 334px 0px（侧边栏+聊天+右栏）
           侧边栏改成 fixed 后不占位，聊天区会掉进第一列 56px，
           所以直接把列定义改成单列 1fr ---- */
    '[class*="frame"] {',
    '  grid-template-columns: 1fr !important;',
    '}',
    /* ---- 主内容全宽，不被侧边栏挤压 ---- */
    '[class*="centerCol"] {',
    '  width: 100% !important;',
    '  max-width: 100% !important;',
    '  margin-left: 0 !important;',
    '  left: 0 !important;',
    '}',
    /* ---- 侧边栏：固定定位，默认移出屏幕 ---- */
    '[class*="sidebarCol"] {',
    '  position: fixed !important;',
    '  top: 0 !important;',
    '  bottom: 0 !important;',
    '  left: 0 !important;',
    '  height: 100% !important;',
    '  width: min(80vw, 320px) !important;',
    '  max-width: none !important;',
    '  z-index: 800 !important;',
    '  transform: translateX(-103%);',
    '  transition: transform .26s cubic-bezier(.22,.8,.24,1);',
    '  box-shadow: 14px 0 44px rgba(0,0,0,.6);',
    '  will-change: transform;',
    '}',
    'body.dsm-sb-open [class*="sidebarCol"] { transform: translateX(0); }',
    /* ---- 遮罩 ---- */
    '#dsm-mask {',
    '  position: fixed; inset: 0; z-index: 799;',
    '  background: rgba(0,0,0,.42);',
    '  opacity: 0; pointer-events: none;',
    '  transition: opacity .22s;',
    '}',
    'body.dsm-sb-open #dsm-mask { opacity: 1; pointer-events: auto; }',
    /* ---- 浮动菜单按钮 ---- */
    '#dsm-menu {',
    '  position: fixed;',
    '  top: calc(8px + env(safe-area-inset-top, 0px));',
    '  left: 8px;',
    '  z-index: 850;',
    '  width: 40px; height: 40px;',
    '  border-radius: 12px;',
    '  display: grid; place-items: center;',
    '  background: rgba(20,26,38,.82);',
    '  color: #e9eefb;',
    '  border: 1px solid rgba(255,255,255,.12);',
    '  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);',
    '  box-shadow: 0 4px 16px rgba(0,0,0,.35);',
    '  padding: 0; margin: 0; cursor: pointer;',
    '  transition: transform .12s ease, background .15s;',
    '  -webkit-tap-highlight-color: transparent;',
    '}',
    '#dsm-menu:active { transform: scale(.92); background: rgba(52,66,90,.92); }',
    'body.dsm-sb-open #dsm-menu { opacity: 0; pointer-events: none; }',
    /* ---- 右上角「文件浏览」按钮 ---- */
    '#dsm-files {',
    '  position: fixed;',
    '  top: calc(8px + env(safe-area-inset-top, 0px));',
    '  right: 8px;',
    '  z-index: 850;',
    '  height: 40px;',
    '  padding: 0 12px;',
    '  border-radius: 12px;',
    '  display: inline-flex; align-items: center; gap: 5px;',
    '  background: rgba(20,26,38,.82);',
    '  color: #e9eefb;',
    '  border: 1px solid rgba(255,255,255,.12);',
    '  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);',
    '  box-shadow: 0 4px 16px rgba(0,0,0,.35);',
    '  margin: 0; cursor: pointer;',
    '  font: 500 13px/1 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;',
    '  transition: transform .12s ease, background .15s;',
    '  -webkit-tap-highlight-color: transparent;',
    '}',
    '#dsm-files:active { transform: scale(.94); background: rgba(52,66,90,.92); }',
    '#dsm-files svg { width: 16px; height: 16px; }',
    'body.dsm-sb-open #dsm-files { opacity: 0; pointer-events: none; }',
    /* ---- 右上角「右侧面板」按钮 ---- */
    '#dsm-panel {',
    '  position: fixed;',
    '  top: calc(8px + env(safe-area-inset-top, 0px));',
    '  right: 90px;',
    '  z-index: 850;',
    '  width: 40px; height: 40px;',
    '  border-radius: 12px;',
    '  display: grid; place-items: center;',
    '  background: rgba(20,26,38,.82);',
    '  color: #e9eefb;',
    '  border: 1px solid rgba(255,255,255,.12);',
    '  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px);',
    '  box-shadow: 0 4px 16px rgba(0,0,0,.35);',
    '  padding: 0; margin: 0; cursor: pointer;',
    '  transition: transform .12s ease, background .15s;',
    '  -webkit-tap-highlight-color: transparent;',
    '}',
    '#dsm-panel:active { transform: scale(.92); background: rgba(52,66,90,.92); }',
    'body.dsm-sb-open #dsm-panel { opacity: 0; pointer-events: none; }',
    'body.dsm-right-open #dsm-panel { background: rgba(79,140,255,.9); }',
    /* ---- 给 ☰ 让出位置 ---- */
    '[class*="centerCol"] header { padding-left: 56px !important; padding-right: 140px !important; }',
    /* ---- 隐藏桌面专属控件 ---- */
    'button[aria-label="分栏"],',
    'button[aria-label="新标签页"],',
    'button[aria-label="退出全屏"] { display: none !important; }',
    /* ---- 右侧栏：手机端覆盖式抽屉（工作区文件 / 终端等）---- */
    '[class*="rightbarCol"] {',
    '  position: fixed !important;',
    '  top: 0; bottom: 0; right: 0;',
    '  width: min(88vw, 380px) !important;',
    '  height: 100vh !important;',
    '  z-index: 820 !important;',
    '  background: #17171a;',
    '  transform: translateX(102%);',
    '  transition: transform .24s ease;',
    '  box-shadow: -14px 0 44px rgba(0,0,0,.55);',
    '  display: block !important;',
    '}',
    'body.dsm-right-open [class*="rightbarCol"] { transform: translateX(0); }',
    '#dsm-right-mask { position: fixed; inset: 0; z-index: 819; background: rgba(0,0,0,.42);',
    '  opacity: 0; pointer-events: none; transition: opacity .22s; }',
    'body.dsm-right-open #dsm-right-mask { opacity: 1; pointer-events: auto; }',
    'body.dsm-right-open #dsm-menu, body.dsm-right-open #dsm-files { opacity: 0; pointer-events: none; }',
    /* ---- 输入框：16px 防止 iOS 聚焦自动放大 ---- */
    '[contenteditable="true"] { font-size: 16px !important; }',
    /* ---- 底部安全区 ---- */
    '[class*="composerSeat"], [class*="composerStack"] {',
    '  padding-bottom: calc(4px + env(safe-area-inset-bottom, 0px)) !important;',
    '}',
    'body { padding-bottom: env(safe-area-inset-bottom, 0px); }',
  ].join('\n');

  function injectStyle() {
    if (document.getElementById('dsm-style')) return;
    var st = document.createElement('style');
    st.id = 'dsm-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function injectChrome() {
    if (document.getElementById('dsm-menu')) return;
    if (!document.body) return;

    var mask = document.createElement('div');
    mask.id = 'dsm-mask';
    document.body.appendChild(mask);

    var btn = document.createElement('button');
    btn.id = 'dsm-menu';
    btn.setAttribute('aria-label', '打开菜单');
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
    document.body.appendChild(btn);

    // 右上角：返回文件浏览（与 AI 页面来回切换）
    var filesBtn = document.createElement('button');
    filesBtn.id = 'dsm-files';
    filesBtn.setAttribute('aria-label', '文件浏览');
    filesBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5A2.5 2.5 0 015.5 6h3.2l2 2.4h7.8A2.5 2.5 0 0121 10.9v6.6A2.5 2.5 0 0118.5 20h-13A2.5 2.5 0 013 17.5v-9z"/></svg><span>文件</span>';
    filesBtn.addEventListener('click', function () { location.href = '/files/'; });
    document.body.appendChild(filesBtn);

    // 右上角：右侧面板（工作区文件 / 终端 / 插件面板）
    var panelBtn = document.createElement('button');
    panelBtn.id = 'dsm-panel';
    panelBtn.setAttribute('aria-label', '右侧面板');
    panelBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>';
    panelBtn.addEventListener('click', function () {
      document.body.classList.toggle('dsm-right-open');
    });
    document.body.appendChild(panelBtn);

    // ---- 右侧栏：遮罩 + 接管开关（手机端抽屉）----
    var rightMask = document.createElement('div');
    rightMask.id = 'dsm-right-mask';
    document.body.appendChild(rightMask);
    rightMask.addEventListener('click', function () {
      document.body.classList.remove('dsm-right-open');
    });

    function bindRightButtons() {
      var openBtn = findBtn('打开右侧边栏');
      var closeBtn = findBtn('收起右侧边栏');
      if (openBtn && openBtn.dataset.dsmRightBound !== '1') {
        openBtn.dataset.dsmRightBound = '1';
        openBtn.addEventListener('click', function () {
          document.body.classList.add('dsm-right-open');
        });
      }
      if (closeBtn && closeBtn.dataset.dsmRightBound !== '1') {
        closeBtn.dataset.dsmRightBound = '1';
        closeBtn.addEventListener('click', function () {
          document.body.classList.remove('dsm-right-open');
        });
      }
    }
    bindRightButtons();
    // 按钮可能是延迟渲染的，隔段时间再绑一次
    setTimeout(bindRightButtons, 1200);
    setTimeout(bindRightButtons, 3000);

    var open = false;

    function findBtn(label) {
      return document.querySelector('button[aria-label="' + label + '"]');
    }
    function openDrawer() {
      open = true;
      var b = findBtn('打开侧边栏');
      if (b) { try { b.click(); } catch (e) { /* ignore */ } }
      document.body.classList.add('dsm-sb-open');
    }
    function closeDrawer() {
      if (!open) return;
      open = false;
      document.body.classList.remove('dsm-sb-open');
      setTimeout(function () {
        var b = findBtn('收起侧边栏');
        if (b) { try { b.click(); } catch (e) { /* ignore */ } }
      }, 300);
    }

    // 暴露给外部函数（showHint / boot 的自动演示）
    window.__dsmOpenDrawer = openDrawer;
    window.__dsmCloseDrawer = closeDrawer;

    btn.addEventListener('click', function () { open ? closeDrawer() : openDrawer(); });
    mask.addEventListener('click', closeDrawer);

    // 选中会话后自动收起抽屉
    document.addEventListener('click', function (e) {
      if (!open) return;
      var row = e.target && e.target.closest ? e.target.closest('[class*="sessionRow"]') : null;
      if (row) setTimeout(closeDrawer, 140);
    }, true);

    // ESC / 浏览器返回时收起
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && open) closeDrawer();
    });
    window.addEventListener('popstate', function () {
      if (open) closeDrawer();
    });
  }

  function showHint() {
    if (localStorage.getItem(HINT_KEY) === '1') return;
    if (document.getElementById('dsm-hint-overlay')) return;
    var overlay = document.createElement('div');
    overlay.id = 'dsm-hint-overlay';
    overlay.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483000;'
      + 'display:flex;align-items:center;justify-content:center;padding:22px;'
      + 'background:rgba(4,7,12,.5);-webkit-backdrop-filter:blur(7px);backdrop-filter:blur(7px);';
    overlay.innerHTML =
      '<div style="width:100%;max-width:330px;background:rgba(22,28,40,.98);border:1px solid rgba(255,255,255,.14);' +
      'border-radius:20px;padding:20px;color:#e9eefb;font-family:system-ui,-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;' +
      'font-size:14px;line-height:1.7;box-shadow:0 24px 60px rgba(0,0,0,.6);">' +
        '<div style="font-weight:700;font-size:16px;margin-bottom:12px;">🤖 AI 助手 · 手机版</div>' +
        '<div style="margin-bottom:10px;">① 点左上角 <b style="display:inline-block;padding:0 6px;border-radius:6px;background:rgba(255,255,255,.16);">☰</b> 打开会话列表</div>' +
        '<div style="margin:-4px 0 12px 18px;color:#a8b8d4;">选「<b style="color:#cfdcf5;">局域网文件浏览应用</b>」继续之前的对话，或点「<b style="color:#cfdcf5;">新建会话</b>」派新任务</div>' +
        '<div style="margin-bottom:10px;">② 选过一次后，手机会记住</div>' +
        '<div style="margin:-4px 0 12px 18px;color:#a8b8d4;">下次打开自动回到这个会话</div>' +
        '<div style="margin-bottom:16px;">③ 手机返回键 / 边缘滑动 → 回到文件浏览</div>' +
        '<button id="dsm-hint-open" style="width:100%;padding:13px;border:0;border-radius:14px;margin-bottom:8px;' +
        'background:linear-gradient(135deg,#4f8cff,#8b5cf6);color:#fff;font-size:16px;font-weight:650;font-family:inherit;">打开侧边栏看看</button>' +
        '<button id="dsm-hint-ok" style="width:100%;padding:11px;border:1px solid rgba(255,255,255,.18);border-radius:14px;' +
        'background:transparent;color:#a8b8d4;font-size:14px;font-family:inherit;">知道了</button>' +
      '</div>';
    document.body.appendChild(overlay);

    function close() {
      localStorage.setItem(HINT_KEY, '1');
      overlay.remove();
    }
    document.getElementById('dsm-hint-ok').addEventListener('click', close);
    document.getElementById('dsm-hint-open').addEventListener('click', function () {
      close();
      setTimeout(function () { try { if (window.__dsmOpenDrawer) window.__dsmOpenDrawer(); } catch (err) { /* ignore */ } }, 180);
    });
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close();
    });
  }

  function boot() {
    injectStyle();
    var tries = 0;
    var timer = setInterval(function () {
      if (document.querySelector('[class*="frame"]') || document.querySelector('[class*="centerCol"]')) {
        clearInterval(timer);
        injectStyle();
        injectChrome();
        setTimeout(function () {
          var seenHint = localStorage.getItem(HINT_KEY) === '1';
          showHint();
          // 首次（新标记）自动滑出一次侧边栏，让用户知道入口在哪
          if (localStorage.getItem('dsm-drawer-intro') !== '1') {
            localStorage.setItem('dsm-drawer-intro', '1');
            setTimeout(function () {
              // 有引导弹窗时等用户关掉再演示；没有则直接演示
              if (!document.getElementById('dsm-hint-overlay')) {
                try { if (window.__dsmOpenDrawer) window.__dsmOpenDrawer(); } catch (err) { /* ignore */ }
                setTimeout(function () { try { if (window.__dsmCloseDrawer) window.__dsmCloseDrawer(); } catch (err) { /* ignore */ } }, 2800);
              }
            }, seenHint ? 900 : 4200);
          }
        }, 900);
      } else if (++tries > 60) {
        clearInterval(timer);
      }
    }, 300);
  }

  if (document.readyState === 'complete') boot();
  else window.addEventListener('load', boot);
})();
