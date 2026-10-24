/*
 * DSHM 备份与迁移 - 注入式客户端界面（单文件 ES5）
 * 宿主通过 webServer.tapIndex 注入：<script defer src="/dshm-backup/client.js"></script>
 * 同源 API：/dshm-backup/api/{state,backup,inspect,restore,emergency,verify,backups}
 * 约束：ES5 IIFE（var/function）、无外部资源、无 import/export/require、
 *       所有动态文本使用 textContent 输出、不读取 Cookie；localStorage 仅保存悬浮按钮位置，
 *       不使用内联脚本。
 * 常驻轮询仅使用递归 setTimeout，且只在面板打开且存在任务时进行。
 */
(function () {
  'use strict';

  var VERSION = '0.1.8';
  var API_BASE = '/dshm-backup/api/';
  var SENTINEL = '__DSHM_BACKUP_UI__';
  var POLL_MS = 1000;
  var REQ_TIMEOUT_MS = 30000;
  var MAX_LIST = 20;
  var FAB_POS_KEY = 'dshm-backup.fab-pos.v1';
  var FAB_LONG_PRESS_MS = 500;
  var FAB_MOVE_CANCEL_PX = 10;

  // 幂等哨兵：宿主可能重复注入，同一页面只初始化一次
  if (window[SENTINEL]) {
    return;
  }
  window[SENTINEL] = { version: VERSION, mounted: false, failed: false };

  var ui = {
    mounted: false,
    open: false,
    rescue: false,
    state: null,
    stateError: '',
    stateLoading: false,
    pollTimer: null,
    pollExpected: false,
    pollFailures: 0,
    gracePolls: 0,
    selectedFile: '',
    busyBackup: false,
    busyVerify: false,
    busyPreview: false,
    busyRestore: false,
    preview: null,
    previewId: '',
    previewFile: '',
    restoreArmed: 0,
    restoreErrors: [],
    emergencySent: false,
    emergencyResult: null,
    emergencyError: '',
    msgTimer: null,
    dom: null
  };

  // 悬浮按钮长按拖动状态（只影响按钮位置，不涉及数据/API）
  var fabDrag = {
    pressing: false,
    active: false,
    timer: null,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
    suppressClick: false,
    listening: false
  };

  var theme = { dark: false };

  // ===== 基础工具 =====
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) {
      node.className = cls;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function append(parent) {
    var i;
    for (i = 1; i < arguments.length; i++) {
      if (arguments[i]) {
        parent.appendChild(arguments[i]);
      }
    }
    return parent;
  }

  function clearNode(node) {
    if (!node) {
      return;
    }
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function setText(node, text) {
    if (node) {
      node.textContent = (text === undefined || text === null) ? '' : String(text);
    }
  }

  function show(node, visible) {
    if (node) {
      node.style.display = visible ? '' : 'none';
    }
  }

  // 转义仅作为兜底使用；界面动态文本统一走 textContent，避免任何 HTML 拼接
  function esc(value) {
    var s = (value === undefined || value === null) ? '' : String(value);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function guard(fn) {
    return function () {
      try {
        return fn.apply(null, arguments);
      } catch (e) {
        try {
          showMsg('界面操作异常：' + formatError(e), 'err');
        } catch (e2) {
          // 界面尚未就绪时静默
        }
        return null;
      }
    };
  }

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function fmtTime(value) {
    if (!value) {
      return '—';
    }
    var date = null;
    try {
      date = new Date(value);
    } catch (e) {
      date = null;
    }
    if (!date || isNaN(date.getTime())) {
      return String(value);
    }
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
      ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
  }

  function fmtSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || n < 0) {
      return '—';
    }
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n = n / 1024;
      i++;
    }
    if (i === 0) {
      return Math.round(n) + ' ' + units[i];
    }
    return Math.round(n * 10) / 10 + ' ' + units[i];
  }

  function dateValue(iso) {
    var t = 0;
    try {
      t = Date.parse(iso);
    } catch (e) {
      t = 0;
    }
    if (!isFinite(t)) {
      t = 0;
    }
    return t;
  }

  function fileBase(file) {
    return String(file || '').replace(/^.*[\\\/]/, '');
  }

  function shortHash(hash) {
    return hash ? String(hash).slice(0, 12) : '';
  }

  function num(value) {
    var n = Number(value);
    return isFinite(n) ? String(n) : '—';
  }

  function numOrDash(value) {
    var n = Number(value);
    return isFinite(n) ? String(Math.round(n)) : '—';
  }

  function kindLabel(kind) {
    var map = {
      manual: '手动',
      baseline: '基线',
      emergency: '异常抢备',
      'pre-restore': '恢复前快照'
    };
    return map[kind] || (kind ? String(kind) : '未知');
  }

  function kindBadgeClass(kind) {
    var map = {
      manual: 'dbk-kind-manual',
      baseline: 'dbk-kind-baseline',
      emergency: 'dbk-kind-emergency',
      'pre-restore': 'dbk-kind-pre'
    };
    return map[kind] || '';
  }

  function phaseLabel(phase) {
    var map = {
      queued: '排队中',
      scanning: '扫描中',
      staging: '暂存中',
      packing: '打包中',
      verifying: '校验中',
      writing: '写入中',
      applying: '应用恢复中',
      done: '已完成',
      failed: '失败'
    };
    return map[phase] || (phase ? String(phase) : '处理中');
  }

  function safeJson(value) {
    try {
      var text = JSON.stringify(value);
      if (!text) {
        return '';
      }
      if (text.length > 800) {
        return text.slice(0, 800) + '…';
      }
      return text;
    } catch (e) {
      return '';
    }
  }

  function formatError(err) {
    var text = '未知错误';
    if (err) {
      if (err.message) {
        text = String(err.message);
      } else {
        text = String(err);
      }
      if (err.code) {
        text = text + '（' + err.code + '）';
      }
      if (err.status) {
        text = text + ' [HTTP ' + err.status + ']';
      }
      if (err.details) {
        var details = safeJson(err.details);
        if (details) {
          text = text + '：' + details;
        }
      }
    }
    return text;
  }

  function formatJobValue(value) {
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object') {
      if (value.message) {
        return String(value.message) + (value.code ? '（' + value.code + '）' : '');
      }
      var json = safeJson(value);
      return json || '详情不可读';
    }
    return String(value);
  }

  function isReadOnly() {
    var s = ui.state;
    if (!s || !s.diagnostics) {
      return false;
    }
    return s.diagnostics.writable === false;
  }

  function readOnlyReason() {
    var s = ui.state;
    var reason = (s && s.diagnostics) ? s.diagnostics.readOnlyReason : '';
    return reason ? String(reason) : '备份目录不可写';
  }

  // ===== 失败页识别 =====
  // 排除本脚本自己注入的元素，避免界面文本（含「插件加载失败」提示）造成误判
  function pageText() {
    if (!document.body) {
      return '';
    }
    var parts = [];
    var kids = document.body.childNodes;
    var dom = ui.dom;
    var i;
    for (i = 0; i < kids.length; i++) {
      var node = kids[i];
      if (!node) {
        continue;
      }
      if (dom && (node === dom.fab || node === dom.overlay)) {
        continue;
      }
      if (node.nodeType === 1 || node.nodeType === 3) {
        parts.push(node.textContent || '');
      }
    }
    return parts.join(' ');
  }

  function detectFailurePage() {
    try {
      var title = document.title || '';
      if (/Failed to load plugins/i.test(title)) {
        return true;
      }
      if (/failed to load plugin/i.test(title)) {
        return true;
      }
      var text = pageText();
      if (!text && document.documentElement) {
        text = document.documentElement.textContent || '';
      }
      if (/Failed to load plugins/i.test(text)) {
        return true;
      }
      if (/failed to load plugin/i.test(text)) {
        return true;
      }
      if (/entries did not activate/i.test(text)) {
        return true;
      }
      if (/client-modules:.*failed to load/i.test(text)) {
        return true;
      }
    } catch (e) {
      return false;
    }
    return false;
  }

  // ===== 暗色适配 =====
  function backgroundColorOf(node) {
    if (!node) {
      return '';
    }
    try {
      var style = window.getComputedStyle(node, null);
      return style ? style.backgroundColor : '';
    } catch (e) {
      return '';
    }
  }

  function applyThemeClasses() {
    var dom = ui.dom;
    if (!dom) {
      return;
    }
    var nodes = [dom.fab, dom.overlay];
    var i;
    for (i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node || !node.classList) {
        continue;
      }
      if (theme.dark) {
        node.classList.add('dbk-dark');
      } else {
        node.classList.remove('dbk-dark');
      }
    }
  }

  function detectDark() {
    var dark = false;
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        dark = true;
      }
    } catch (e) {
      dark = false;
    }
    var probes = [document.body, document.documentElement];
    var i;
    for (i = 0; i < probes.length; i++) {
      var bg = backgroundColorOf(probes[i]);
      if (!bg) {
        continue;
      }
      var match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/);
      if (!match) {
        continue;
      }
      var alpha = match[4] === undefined ? 1 : parseFloat(match[4]);
      if (!isFinite(alpha) || alpha < 0.1) {
        continue;
      }
      var lum = (parseInt(match[1], 10) * 299 + parseInt(match[2], 10) * 587 + parseInt(match[3], 10) * 114) / 1000;
      dark = lum < 140;
      break;
    }
    theme.dark = dark;
    applyThemeClasses();
  }

  // ===== HTTP 封装（同源相对路径，非 GET 需要 POST + JSON） =====
  function request(path, options) {
    var opts = options || {};
    var method = opts.method || 'GET';
    var init = {
      method: method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {}
    };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    var ctrl = null;
    var timer = null;
    if (typeof AbortController !== 'undefined') {
      try {
        ctrl = new AbortController();
        init.signal = ctrl.signal;
        timer = setTimeout(function () {
          try {
            ctrl.abort();
          } catch (e) {
            // 忽略
          }
        }, REQ_TIMEOUT_MS);
      } catch (e2) {
        ctrl = null;
        timer = null;
      }
    }
    function stopTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
    return fetch(API_BASE + path, init).then(function (response) {
      stopTimer();
      return response.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (e3) {
            data = null;
          }
        }
        if (!response.ok) {
          var err = new Error((data && (data.error || data.message)) || ('请求失败（HTTP ' + response.status + '）'));
          err.status = response.status;
          if (data) {
            err.code = data.code || '';
            err.details = data.details || null;
          }
          throw err;
        }
        if (data === null) {
          throw new Error('服务返回了无法解析的数据');
        }
        return data;
      });
    }, function (netErr) {
      stopTimer();
      throw new Error('网络请求失败' + (netErr && netErr.message ? '：' + netErr.message : ''));
    });
  }

  // ===== 样式（单 <style> 标签，类名统一 dbk- 前缀，暗色变量适配） =====
  var CSS_TEXT = [
    '.dbk-fab,.dbk-overlay{--b-bg:#ffffff;--b-bg2:#f5f6f8;--b-fg:#1f2328;--b-fg2:#5b6472;--b-line:#d6dae0;--b-accent:#2563eb;--b-accent-fg:#ffffff;--b-ok:#15803d;--b-warn:#b45309;--b-err:#b91c1c;--b-ok-bg:#e7f7ec;--b-warn-bg:#fdf3d8;--b-err-bg:#fde8e8;--b-shadow:0 14px 36px rgba(0,0,0,.30);}',
    '@media (prefers-color-scheme: dark){.dbk-fab,.dbk-overlay{--b-bg:#1b1f24;--b-bg2:#22272e;--b-fg:#e6edf3;--b-fg2:#9aa4b1;--b-line:#3a434e;--b-accent:#3b82f6;--b-accent-fg:#ffffff;--b-ok:#4ade80;--b-warn:#fbbf24;--b-err:#f87171;--b-ok-bg:#16301f;--b-warn-bg:#3a2d14;--b-err-bg:#3c1d1d;--b-shadow:0 14px 36px rgba(0,0,0,.60);}}',
    '.dbk-fab.dbk-dark,.dbk-overlay.dbk-dark{--b-bg:#1b1f24;--b-bg2:#22272e;--b-fg:#e6edf3;--b-fg2:#9aa4b1;--b-line:#3a434e;--b-accent:#3b82f6;--b-accent-fg:#ffffff;--b-ok:#4ade80;--b-warn:#fbbf24;--b-err:#f87171;--b-ok-bg:#16301f;--b-warn-bg:#3a2d14;--b-err-bg:#3c1d1d;--b-shadow:0 14px 36px rgba(0,0,0,.60);}',
    '.dbk-fab{position:fixed;right:16px;bottom:84px;z-index:2147483000;display:inline-flex;align-items:center;justify-content:center;padding:10px 18px;border:1px solid rgba(255,255,255,.18);border-radius:999px;background:var(--b-accent);color:var(--b-accent-fg);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;font-weight:600;line-height:1.2;letter-spacing:.02em;box-shadow:0 6px 18px rgba(37,99,235,.35);cursor:grab;-webkit-user-select:none;user-select:none;-webkit-tap-highlight-color:transparent;touch-action:none;-webkit-touch-callout:none;}',
    '.dbk-fab:hover{filter:brightness(1.08);}',
    '.dbk-fab:active{transform:scale(.97);}',
    '.dbk-fab.dbk-fab-dragging{cursor:grabbing;transform:none!important;filter:none!important;}',
    '.dbk-fab.dbk-fab-dragging:active{transform:none!important;}',
    '.dbk-fab.dbk-fab-rescue{background:#c2410c;box-shadow:0 6px 18px rgba(194,65,12,.42);}',
    '.dbk-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483001;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.55);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.55;color:var(--b-fg);-webkit-tap-highlight-color:transparent;}',
    '.dbk-panel{display:flex;flex-direction:column;width:760px;max-width:calc(100% - 24px);max-height:90vh;background:var(--b-bg);border:1px solid var(--b-line);border-radius:14px;box-shadow:var(--b-shadow);overflow:hidden;}',
    '.dbk-hd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:13px 16px 11px;border-bottom:1px solid var(--b-line);background:var(--b-bg);}',
    '.dbk-title{margin:0;font-size:16px;font-weight:700;}',
    '.dbk-close{flex:0 0 auto;width:32px;height:32px;padding:0;border:1px solid transparent;border-radius:8px;background:transparent;color:var(--b-fg2);font-family:inherit;font-size:20px;line-height:1;cursor:pointer;}',
    '.dbk-close:hover{background:var(--b-bg2);color:var(--b-fg);}',
    '.dbk-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 16px 18px;-webkit-overflow-scrolling:touch;}',
    '.dbk-banner{margin:12px 0 0;padding:10px 12px;border:1px solid #d97706;border-left:4px solid #d97706;border-radius:8px;background:var(--b-warn-bg);color:var(--b-fg);font-size:13px;}',
    '.dbk-banner-line{font-weight:700;}',
    '.dbk-banner-extra{font-size:12px;color:var(--b-fg2);margin-top:3px;word-break:break-word;}',
    '.dbk-status{display:flex;align-items:center;gap:8px;margin:12px 0 0;font-size:13px;color:var(--b-fg2);}',
    '.dbk-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;background:var(--b-fg2);}',
    '.dbk-status-ok .dbk-dot{background:var(--b-ok);}',
    '.dbk-status-warn .dbk-dot{background:var(--b-warn);}',
    '.dbk-status-err .dbk-dot{background:var(--b-err);}',
    '.dbk-status-err .dbk-status-text{color:var(--b-err);}',
    '.dbk-msg{margin:10px 0 0;padding:8px 10px;border:1px solid transparent;border-radius:8px;font-size:13px;word-break:break-word;}',
    '.dbk-msg-ok{background:var(--b-ok-bg);border-color:var(--b-ok);color:var(--b-ok);}',
    '.dbk-msg-err{background:var(--b-err-bg);border-color:var(--b-err);color:var(--b-err);}',
    '.dbk-msg-warn{background:var(--b-warn-bg);border-color:var(--b-warn);color:var(--b-warn);}',
    '.dbk-msg-info{background:var(--b-bg2);border-color:var(--b-line);color:var(--b-fg2);}',
    '.dbk-meta{margin-top:14px;padding:9px 12px;border:1px solid var(--b-line);border-radius:10px;background:var(--b-bg2);}',
    '.dbk-meta-row{display:flex;gap:10px;align-items:flex-start;padding:3px 0;font-size:13px;}',
    '.dbk-meta-label{flex:0 0 72px;color:var(--b-fg2);}',
    '.dbk-meta-val{flex:1 1 auto;min-width:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;}',
    '.dbk-copy{flex:0 0 auto;}',
    '.dbk-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px;}',
    '.dbk-btn{appearance:none;-webkit-appearance:none;border:1px solid var(--b-line);border-radius:9px;background:var(--b-bg2);color:var(--b-fg);font-family:inherit;font-size:13px;font-weight:600;line-height:1.2;padding:9px 14px;cursor:pointer;}',
    '.dbk-btn:hover{filter:brightness(1.05);}',
    '.dbk-btn:disabled{opacity:.45;cursor:not-allowed;filter:none;}',
    '.dbk-btn-primary{background:var(--b-accent);border-color:var(--b-accent);color:var(--b-accent-fg);}',
    '.dbk-btn-warn{background:#c2410c;border-color:#c2410c;color:#ffffff;}',
    '.dbk-btn-armed{box-shadow:0 0 0 2px var(--b-err);}',
    '.dbk-btn-sm{padding:5px 10px;font-size:12px;border-radius:7px;}',
    '.dbk-hint{margin-top:6px;font-size:12px;color:var(--b-fg2);word-break:break-word;}',
    '.dbk-card{margin-top:14px;padding:12px;border:1px solid var(--b-line);border-radius:10px;background:var(--b-bg2);}',
    '.dbk-card-title{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px;font-size:13px;font-weight:700;}',
    '.dbk-empty{padding:4px 0;font-size:13px;color:var(--b-fg2);}',
    '.dbk-job-top{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:13px;font-weight:700;}',
    '.dbk-bar{margin-top:8px;height:8px;border-radius:999px;background:rgba(127,127,127,.25);overflow:hidden;}',
    '.dbk-bar-inner{width:0;height:100%;border-radius:999px;background:var(--b-accent);transition:width .25s ease;}',
    '.dbk-bar-done .dbk-bar-inner{background:var(--b-ok);}',
    '.dbk-bar-failed .dbk-bar-inner{background:var(--b-err);}',
    '.dbk-job-result{margin-top:8px;}',
    '.dbk-result-title{margin:10px 0 6px;font-size:13px;font-weight:700;}',
    '.dbk-list{display:flex;flex-direction:column;gap:8px;}',
    '.dbk-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border:1px solid var(--b-line);border-radius:9px;background:var(--b-bg);cursor:pointer;}',
    '.dbk-row:hover{border-color:var(--b-accent);}',
    '.dbk-row-selected{border-color:var(--b-accent);box-shadow:inset 0 0 0 1px var(--b-accent);background:var(--b-bg2);}',
    '.dbk-row-main{flex:1 1 auto;min-width:0;}',
    '.dbk-row-name{font-size:13px;font-weight:600;word-break:break-all;}',
    '.dbk-row-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px;font-size:11px;color:var(--b-fg2);}',
    '.dbk-row-actions{display:flex;flex:0 0 auto;gap:6px;}',
    '.dbk-badge{display:inline-block;padding:1px 7px;border:1px solid var(--b-line);border-radius:999px;background:var(--b-bg2);color:var(--b-fg2);font-size:11px;font-weight:600;white-space:nowrap;}',
    '.dbk-kind-manual{border-color:var(--b-accent);color:var(--b-accent);}',
    '.dbk-kind-baseline{border-color:var(--b-ok);color:var(--b-ok);}',
    '.dbk-kind-emergency{border-color:var(--b-warn);color:var(--b-warn);}',
    '.dbk-kind-pre{border-color:#8b5cf6;color:#8b5cf6;}',
    '.dbk-verified{border-color:var(--b-ok);color:var(--b-ok);}',
    '.dbk-unverified{border-color:var(--b-line);color:var(--b-fg2);}',
    '.dbk-kv{display:flex;gap:8px;padding:3px 0;font-size:12px;border-bottom:1px dashed var(--b-line);}',
    '.dbk-kv:last-child{border-bottom:0;}',
    '.dbk-kv-key{flex:0 0 38%;color:var(--b-fg2);word-break:break-all;}',
    '.dbk-kv-val{flex:1 1 auto;min-width:0;word-break:break-all;}',
    '.dbk-counts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}',
    '.dbk-count{padding:8px;border:1px solid var(--b-line);border-radius:8px;background:var(--b-bg);text-align:center;}',
    '.dbk-count-num{display:block;font-size:18px;font-weight:700;}',
    '.dbk-count-label{display:block;margin-top:2px;font-size:11px;color:var(--b-fg2);}',
    '.dbk-scroll{max-height:190px;overflow:auto;}',
    '.dbk-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px;}',
    '.dbk-table th,.dbk-table td{padding:5px 6px;border-bottom:1px solid var(--b-line);text-align:left;vertical-align:top;word-break:break-all;}',
    '.dbk-table th{color:var(--b-fg2);font-weight:600;}',
    '.dbk-item{padding:3px 0;font-size:12px;word-break:break-word;}',
    '.dbk-item-warn{color:var(--b-warn);}',
    '.dbk-item-err{color:var(--b-err);}',
    '.dbk-skip{padding:2px 0;font-size:12px;color:var(--b-warn);word-break:break-word;}',
    '.dbk-alert{margin-top:10px;padding:10px 12px;border:1px solid var(--b-err);border-radius:9px;background:var(--b-err-bg);color:var(--b-err);font-size:13px;font-weight:600;line-height:1.6;word-break:break-word;}',
    '.dbk-alert-warn{border-color:#d97706;background:var(--b-warn-bg);color:var(--b-warn);}',
    '.dbk-report{margin:8px 0 0;padding:10px;max-height:220px;overflow:auto;border:1px solid var(--b-line);border-radius:8px;background:var(--b-bg);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;}',
    '.dbk-preview-hd{display:flex;align-items:center;gap:10px;padding-top:12px;}',
    '.dbk-preview-hd h3{margin:0;font-size:15px;}',
    '.dbk-preview-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:14px;}',
    '.dbk-preview-bar .dbk-hint{flex:1 1 100%;margin-top:0;}',
    '@media (max-width:560px){.dbk-overlay{padding:8px;} .dbk-panel{width:100%;max-width:100%;max-height:94vh;border-radius:12px;} .dbk-fab{right:12px;bottom:76px;padding:9px 15px;} .dbk-counts{grid-template-columns:repeat(2,minmax(0,1fr));} .dbk-row{flex-direction:column;align-items:stretch;} .dbk-row-actions{justify-content:flex-end;} .dbk-meta-label{flex-basis:64px;}}'
  ].join('\n');

  // ===== DOM 骨架 =====
  function buildMetaRow(store, key, label) {
    var row = el('div', 'dbk-meta-row');
    row.appendChild(el('span', 'dbk-meta-label', label));
    var val = el('span', 'dbk-meta-val', '—');
    row.appendChild(val);
    var copy = null;
    if (key === 'backupDir') {
      copy = el('button', 'dbk-btn dbk-btn-sm dbk-copy', '复制');
      copy.type = 'button';
      copy.title = '复制备份目录路径';
      copy.addEventListener('click', guard(copyBackupDir), false);
      row.appendChild(copy);
    }
    store[key] = { val: val, copy: copy };
    return row;
  }

  // ===== 悬浮按钮位置：长按拖动 + 本地持久化 =====
  function fabViewportSize() {
    var w = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
    var h = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 0;
    return { w: w, h: h };
  }

  function fabClamp(left, top, width, height) {
    var vp = fabViewportSize();
    var margin = 4;
    var maxLeft = Math.max(margin, vp.w - width - margin);
    var maxTop = Math.max(margin, vp.h - height - margin);
    return {
      left: Math.max(margin, Math.min(left, maxLeft)),
      top: Math.max(margin, Math.min(top, maxTop))
    };
  }

  function fabApplyPosition(left, top) {
    var fab = ui.dom && ui.dom.fab;
    if (!fab) {
      return null;
    }
    var width = fab.offsetWidth || 0;
    var height = fab.offsetHeight || 0;
    var pos = fabClamp(left, top, width, height);
    fab.style.left = Math.round(pos.left) + 'px';
    fab.style.top = Math.round(pos.top) + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    return pos;
  }

  function fabReadSavedPosition() {
    try {
      var raw = window.localStorage && window.localStorage.getItem(FAB_POS_KEY);
      if (!raw) {
        return null;
      }
      var pos = JSON.parse(raw);
      if (pos && isFinite(pos.left) && isFinite(pos.top)) {
        return { left: Number(pos.left), top: Number(pos.top) };
      }
    } catch (e) {
      // localStorage 不可用/内容损坏：使用默认位置
    }
    return null;
  }

  function fabSaveCurrentPosition() {
    var fab = ui.dom && ui.dom.fab;
    if (!fab || !fab.style.left) {
      return;
    }
    var left = parseFloat(fab.style.left);
    var top = parseFloat(fab.style.top);
    if (!isFinite(left) || !isFinite(top)) {
      return;
    }
    try {
      window.localStorage.setItem(FAB_POS_KEY, JSON.stringify({
        left: Math.round(left),
        top: Math.round(top)
      }));
    } catch (e) {
      // 持久化失败不影响拖动本身
    }
  }

  function fabRestoreSavedPosition() {
    var saved = fabReadSavedPosition();
    if (saved) {
      fabApplyPosition(saved.left, saved.top);
    }
  }

  function fabClampCurrentPosition() {
    var fab = ui.dom && ui.dom.fab;
    if (!fab || !fab.style.left) {
      return;
    }
    var left = parseFloat(fab.style.left);
    var top = parseFloat(fab.style.top);
    if (!isFinite(left) || !isFinite(top)) {
      return;
    }
    fabApplyPosition(left, top);
    fabSaveCurrentPosition();
  }

  function fabRemoveDocListeners() {
    if (!fabDrag.listening) {
      return;
    }
    document.removeEventListener('mousemove', fabOnDocMove, false);
    document.removeEventListener('mouseup', fabOnDocUp, false);
    document.removeEventListener('touchmove', fabOnDocMove, false);
    document.removeEventListener('touchend', fabOnDocUp, false);
    document.removeEventListener('touchcancel', fabOnDocUp, false);
    fabDrag.listening = false;
  }

  function fabAddDocListeners() {
    if (fabDrag.listening) {
      return;
    }
    fabDrag.listening = true;
    document.addEventListener('mousemove', fabOnDocMove, false);
    document.addEventListener('mouseup', fabOnDocUp, false);
    document.addEventListener('touchmove', fabOnDocMove, { passive: false });
    document.addEventListener('touchend', fabOnDocUp, false);
    document.addEventListener('touchcancel', fabOnDocUp, false);
  }

  function fabClearPress() {
    if (fabDrag.timer) {
      clearTimeout(fabDrag.timer);
      fabDrag.timer = null;
    }
    fabDrag.pressing = false;
    fabDrag.active = false;
    fabRemoveDocListeners();
    if (ui.dom && ui.dom.fab) {
      ui.dom.fab.classList.remove('dbk-fab-dragging');
    }
  }

  function fabBeginDrag() {
    if (!fabDrag.pressing) {
      return;
    }
    var fab = ui.dom && ui.dom.fab;
    if (!fab) {
      return;
    }
    var rect = fab.getBoundingClientRect();
    fabApplyPosition(rect.left, rect.top);
    fab.classList.add('dbk-fab-dragging');
    fabDrag.active = true;
  }

  function fabOnDocMove(event) {
    if (!fabDrag.pressing) {
      return;
    }
    var point = event.touches ? event.touches[0] : event;
    if (!point || typeof point.clientX !== 'number') {
      return;
    }
    var dx = point.clientX - fabDrag.startX;
    var dy = point.clientY - fabDrag.startY;
    if (!fabDrag.active) {
      // 长按计时未到就移动：视为误触/滑动，取消长按，并抑制紧随其后的 click。
      if (Math.abs(dx) > FAB_MOVE_CANCEL_PX || Math.abs(dy) > FAB_MOVE_CANCEL_PX) {
        fabDrag.suppressClick = true;
        fabClearPress();
      }
      return;
    }
    if (event.cancelable) {
      event.preventDefault();
    }
    fabApplyPosition(point.clientX - fabDrag.offsetX, point.clientY - fabDrag.offsetY);
  }

  function fabOnDocUp() {
    if (!fabDrag.pressing) {
      return;
    }
    var wasActive = fabDrag.active;
    if (wasActive) {
      fabSaveCurrentPosition();
    }
    fabDrag.suppressClick = wasActive;
    fabClearPress();
    if (wasActive) {
      setTimeout(function () {
        fabDrag.suppressClick = false;
      }, 400);
    }
  }

  function fabOnPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) {
      return;
    }
    if (event.touches && event.touches.length > 1) {
      return;
    }
    var fab = ui.dom && ui.dom.fab;
    if (!fab) {
      return;
    }
    var point = event.touches ? event.touches[0] : event;
    if (!point || typeof point.clientX !== 'number') {
      return;
    }
    var rect = fab.getBoundingClientRect();
    fabDrag.suppressClick = false;
    fabDrag.pressing = true;
    fabDrag.active = false;
    fabDrag.startX = point.clientX;
    fabDrag.startY = point.clientY;
    fabDrag.offsetX = point.clientX - rect.left;
    fabDrag.offsetY = point.clientY - rect.top;
    if (fabDrag.timer) {
      clearTimeout(fabDrag.timer);
    }
    fabDrag.timer = setTimeout(function () {
      try {
        fabBeginDrag();
      } catch (e) {
        fabClearPress();
      }
    }, FAB_LONG_PRESS_MS);
    fabAddDocListeners();
  }

  function setupFabDrag(fab) {
    if (!fab) {
      return;
    }
    fab.addEventListener('mousedown', guard(fabOnPointerDown), false);
    fab.addEventListener('touchstart', guard(fabOnPointerDown), { passive: true });
    fab.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    }, false);
    window.addEventListener('resize', guard(fabClampCurrentPosition), false);
  }

  function buildDom() {
    var dom = {};
    ui.dom = dom;

    dom.style = el('style', 'dbk-style');
    dom.style.textContent = CSS_TEXT;
    (document.head || document.documentElement).appendChild(dom.style);

    // 悬浮按钮：正常页「备份」，失败页「备份工具（救援）」
    dom.fab = el('button', 'dbk-fab' + (ui.rescue ? ' dbk-fab-rescue' : ''), ui.rescue ? '备份工具（救援）' : '备份');
    dom.fab.type = 'button';
    dom.fab.title = (ui.rescue ? '插件加载失败页：打开备份救援面板' : '打开 DSHM 备份与迁移面板') + '；长按可拖动位置';
    dom.fab.setAttribute('aria-label', (ui.rescue ? '备份工具（救援）' : '备份') + '；长按可拖动位置');
    dom.fab.addEventListener('click', guard(onFabClick), false);
    setupFabDrag(dom.fab);

    dom.overlay = el('div', 'dbk-overlay');
    dom.overlay.style.display = 'none';
    dom.overlay.addEventListener('click', guard(onOverlayClick), false);

    dom.panel = el('div', 'dbk-panel');
    dom.panel.setAttribute('role', 'dialog');
    dom.panel.setAttribute('aria-modal', 'true');
    dom.panel.setAttribute('aria-label', 'DSHM 备份与迁移');
    dom.overlay.appendChild(dom.panel);

    dom.hd = el('div', 'dbk-hd');
    dom.title = el('h2', 'dbk-title', 'DSHM 备份与迁移');
    dom.closeBtn = el('button', 'dbk-close', '×');
    dom.closeBtn.type = 'button';
    dom.closeBtn.title = '关闭';
    dom.closeBtn.setAttribute('aria-label', '关闭备份面板');
    dom.closeBtn.addEventListener('click', guard(closePanel), false);
    append(dom.hd, dom.title, dom.closeBtn);
    dom.panel.appendChild(dom.hd);

    // 主视图
    dom.bodyMain = el('div', 'dbk-body');
    dom.panel.appendChild(dom.bodyMain);

    dom.banner = el('div', 'dbk-banner');
    dom.banner.appendChild(el('div', 'dbk-banner-line', '插件加载失败页：仍可执行备份/查看备份'));
    dom.bannerExtra = el('div', 'dbk-banner-extra');
    dom.banner.appendChild(dom.bannerExtra);
    show(dom.banner, false);
    dom.bodyMain.appendChild(dom.banner);

    dom.status = el('div', 'dbk-status dbk-status-idle');
    dom.statusDot = el('span', 'dbk-dot');
    dom.statusText = el('span', 'dbk-status-text', '正在连接备份服务…');
    append(dom.status, dom.statusDot, dom.statusText);
    dom.bodyMain.appendChild(dom.status);

    dom.msg = el('div', 'dbk-msg dbk-msg-info');
    dom.msg.setAttribute('role', 'status');
    dom.msg.setAttribute('aria-live', 'polite');
    show(dom.msg, false);
    dom.bodyMain.appendChild(dom.msg);

    dom.meta = el('div', 'dbk-meta');
    dom.metaRows = {};
    dom.meta.appendChild(buildMetaRow(dom.metaRows, 'coreVersion', '核心版本'));
    dom.meta.appendChild(buildMetaRow(dom.metaRows, 'nodeVersion', 'Node 版本'));
    dom.meta.appendChild(buildMetaRow(dom.metaRows, 'backupDir', '备份目录'));
    dom.bodyMain.appendChild(dom.meta);

    dom.actions = el('div', 'dbk-actions');
    dom.backupBtn = el('button', 'dbk-btn dbk-btn-primary', '立即备份');
    dom.backupBtn.type = 'button';
    dom.backupBtn.addEventListener('click', guard(startBackup), false);
    dom.refreshBtn = el('button', 'dbk-btn', '刷新');
    dom.refreshBtn.type = 'button';
    dom.refreshBtn.addEventListener('click', guard(refreshAll), false);
    dom.verifyBtn = el('button', 'dbk-btn', '校验选中备份');
    dom.verifyBtn.type = 'button';
    dom.verifyBtn.addEventListener('click', guard(verifySelected), false);
    append(dom.actions, dom.backupBtn, dom.refreshBtn, dom.verifyBtn);
    dom.bodyMain.appendChild(dom.actions);
    dom.actionHint = el('div', 'dbk-hint', '点击备份行可选中后校验；「恢复」需先预览。长按右下角「备份」按钮可拖动位置。');
    dom.bodyMain.appendChild(dom.actionHint);

    // 任务进度
    dom.job = el('div', 'dbk-card dbk-job');
    var jobTop = el('div', 'dbk-job-top');
    dom.jobTitle = el('span', 'dbk-job-title', '任务');
    dom.jobPercent = el('span', 'dbk-job-percent', '');
    append(jobTop, dom.jobTitle, dom.jobPercent);
    dom.jobBarWrap = el('div', 'dbk-bar');
    dom.jobBar = el('div', 'dbk-bar-inner');
    dom.jobBarWrap.appendChild(dom.jobBar);
    dom.jobMsg = el('div', 'dbk-hint', '');
    dom.jobMeta = el('div', 'dbk-hint', '');
    dom.jobResult = el('div', 'dbk-job-result');
    append(dom.job, jobTop, dom.jobBarWrap, dom.jobMsg, dom.jobMeta, dom.jobResult);
    show(dom.job, false);
    dom.bodyMain.appendChild(dom.job);

    // 最近一次恢复结果（任务结束后仍可查看；含冷重启提示）
    dom.report = el('div', 'dbk-card dbk-report-card');
    dom.reportTitle = el('div', 'dbk-card-title', '最近一次恢复结果');
    dom.reportBody = el('div', 'dbk-report-body');
    append(dom.report, dom.reportTitle, dom.reportBody);
    show(dom.report, false);
    dom.bodyMain.appendChild(dom.report);

    // 基线卡片
    dom.baseline = el('div', 'dbk-card dbk-baseline');
    dom.baseline.appendChild(el('div', 'dbk-card-title', '最近健康基线'));
    dom.baselineBody = el('div', '');
    dom.baseline.appendChild(dom.baselineBody);
    dom.bodyMain.appendChild(dom.baseline);

    // 备份列表
    dom.backups = el('div', 'dbk-card dbk-backups');
    var backupsTitle = el('div', 'dbk-card-title');
    backupsTitle.appendChild(el('span', '', '备份列表'));
    dom.backupsCount = el('span', 'dbk-badge', '0');
    backupsTitle.appendChild(dom.backupsCount);
    dom.backupList = el('div', 'dbk-list');
    dom.backupEmpty = el('div', 'dbk-empty', '暂无备份');
    dom.backupHint = el('div', 'dbk-hint', '按创建时间倒序，最多显示 20 条；「恢复」需先预览该备份。');
    append(dom.backups, backupsTitle, dom.backupList, dom.backupEmpty, dom.backupHint);
    dom.bodyMain.appendChild(dom.backups);

    // 预览视图
    dom.bodyPreview = el('div', 'dbk-body dbk-preview');
    dom.previewHd = el('div', 'dbk-preview-hd');
    dom.previewBack = el('button', 'dbk-btn dbk-btn-sm', '← 返回列表');
    dom.previewBack.type = 'button';
    dom.previewBack.addEventListener('click', guard(backToMain), false);
    dom.previewTitle = el('h3', '', '恢复预览');
    append(dom.previewHd, dom.previewBack, dom.previewTitle);
    dom.previewContent = el('div', '');
    append(dom.bodyPreview, dom.previewHd, dom.previewContent);
    show(dom.bodyPreview, false);
    dom.panel.appendChild(dom.bodyPreview);

    dom.previewConfirm = null;
    dom.previewHint = null;
  }

  // ===== 渲染 =====
  function renderAll(state) {
    if (!ui.mounted || !ui.dom) {
      return;
    }
    try {
      if (state) {
        ui.state = state;
      }
      renderRescue();
      renderStatus();
      renderMeta();
      renderActions();
      renderJob();
      renderReport();
      renderBaseline();
      renderBackups();
    } catch (e) {
      try {
        console.warn('[dshm-backup] 渲染界面失败');
      } catch (e2) {
        // 忽略
      }
    }
  }

  function renderRescue() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    if (!ui.rescue) {
      show(d.banner, false);
      return;
    }
    show(d.banner, true);
    clearNode(d.bannerExtra);
    var line = '';
    if (ui.emergencyError) {
      line = '保命备份请求失败：' + ui.emergencyError;
    } else if (ui.emergencyResult) {
      var reason = ui.emergencyResult.reason ? String(ui.emergencyResult.reason) : '';
      if (ui.emergencyResult.started) {
        line = '已请求保命备份' + (reason ? '（' + reason + '）' : '');
      } else {
        line = '未启动保命备份：' + (reason || '原因未知');
      }
    } else if (ui.emergencySent) {
      line = '正在请求保命备份…';
    }
    if (line) {
      d.bannerExtra.appendChild(el('div', '', line));
    }
    var s = ui.state || {};
    if (s.emergency && s.emergency.done) {
      d.bannerExtra.appendChild(el('div', '', '保命备份：' + (s.emergency.file ? fileBase(s.emergency.file) : '已存在') + ' · ' + fmtTime(s.emergency.at)));
    }
  }

  function renderStatus() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    var cls = 'dbk-status';
    var text = '正在连接备份服务…';
    if (ui.stateError) {
      cls = cls + ' dbk-status-err';
      text = '无法连接备份服务：' + ui.stateError;
    } else if (ui.state) {
      if (ui.state.ok === false) {
        cls = cls + ' dbk-status-err';
        text = '备份服务返回异常状态';
      } else if (isReadOnly()) {
        cls = cls + ' dbk-status-warn';
        text = '只读：' + readOnlyReason();
      } else {
        cls = cls + ' dbk-status-ok';
        text = '服务在线';
      }
    } else if (ui.stateLoading) {
      text = '正在读取服务状态…';
    }
    d.status.className = cls;
    setText(d.statusText, text);
  }

  function renderMeta() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    var s = ui.state || {};
    var core = s.core || {};
    setText(d.metaRows.coreVersion.val, core.coreVersion || '—');
    setText(d.metaRows.nodeVersion.val, core.nodeVersion || '—');
    setText(d.metaRows.backupDir.val, s.backupDir || '—');
    if (d.metaRows.backupDir.copy) {
      d.metaRows.backupDir.copy.disabled = !s.backupDir;
    }
  }

  function renderActions() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    var s = ui.state;
    var ro = isReadOnly();
    var job = s && s.job ? s.job : null;
    // 宿主会保留已结束的 job 快照，只有运行中的任务才禁用「立即备份」
    var jobRunning = !!(job && job.phase !== 'done' && job.phase !== 'failed');
    d.backupBtn.disabled = ro || ui.busyBackup || jobRunning;
    if (ui.busyBackup) {
      d.backupBtn.textContent = '正在提交…';
    } else if (jobRunning && (job.kind === 'backup' || job.kind === 'manual')) {
      d.backupBtn.textContent = '备份中…';
    } else {
      d.backupBtn.textContent = '立即备份';
    }
    if (ro) {
      d.backupBtn.title = '只读模式：' + readOnlyReason();
    } else {
      d.backupBtn.title = '立即执行一次手动备份';
    }
    d.refreshBtn.disabled = ui.stateLoading;
    d.verifyBtn.disabled = !ui.selectedFile || ui.busyVerify;
    d.verifyBtn.textContent = ui.busyVerify ? '校验中…' : '校验选中备份';
    if (ui.selectedFile) {
      setText(d.actionHint, '已选中：' + fileBase(ui.selectedFile) + (ro ? '（只读模式）' : ''));
    } else {
      setText(d.actionHint, '点击备份行可选中后校验；「恢复」需先预览。');
    }
  }

  function renderJob() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    var s = ui.state || {};
    var job = s.job || null;
    if (!job) {
      show(d.job, false);
      clearNode(d.jobResult);
      return;
    }
    show(d.job, true);
    var kindText = '任务';
    if (job.kind === 'restore') {
      kindText = '恢复任务';
    } else if (job.kind === 'backup' || job.kind === 'manual') {
      kindText = '备份任务';
    } else if (job.kind === 'baseline') {
      kindText = '基线备份任务';
    } else if (job.kind === 'emergency') {
      kindText = '异常抢备任务';
    } else if (job.kind === 'inspect') {
      kindText = '检查任务';
    }
    setText(d.jobTitle, kindText + ' · ' + phaseLabel(job.phase));
    var pct = Number(job.percent);
    if (!isFinite(pct)) {
      pct = 0;
    }
    if (pct < 0) {
      pct = 0;
    }
    if (pct > 100) {
      pct = 100;
    }
    pct = Math.round(pct);
    setText(d.jobPercent, pct + '%');
    d.jobBar.style.width = pct + '%';
    d.jobBarWrap.className = 'dbk-bar' + (job.phase === 'failed' ? ' dbk-bar-failed' : (job.phase === 'done' ? ' dbk-bar-done' : ''));
    setText(d.jobMsg, job.message ? String(job.message) : '');
    var metaParts = [];
    if (job.startedAt) {
      metaParts.push('开始时间：' + fmtTime(job.startedAt));
    }
    if (job.id) {
      metaParts.push('任务号 ' + String(job.id).slice(0, 8));
    }
    setText(d.jobMeta, metaParts.join(' · '));
    clearNode(d.jobResult);
    if (job.phase === 'failed') {
      appendJobError(d.jobResult, job);
    } else if (job.phase === 'done') {
      appendJobDone(d.jobResult, job);
    } else {
      d.jobResult.appendChild(el('div', 'dbk-hint', '任务进行中，进度每秒自动刷新，任务结束后停止。'));
    }
  }

  function appendJobError(container, job) {
    var errText = job.error ? formatJobValue(job.error) : '任务失败，未返回错误详情';
    container.appendChild(el('div', 'dbk-alert', errText));
    if (job.kind === 'restore') {
      container.appendChild(el('div', 'dbk-hint', '恢复未完成：目标数据可能处于未完成状态，请勿新建会话；可重新预览后再试，或使用异常抢备。'));
    }
  }

  function appendJobDone(container, job) {
    var result = job.result || null;
    if (job.kind === 'restore') {
      if (result) {
        renderRestoreResult(container, result, false);
      } else {
        container.appendChild(el('div', 'dbk-hint', '恢复任务已完成，请查看下方最近一次恢复结果。'));
      }
    } else if (job.kind === 'backup' || job.kind === 'manual' || job.kind === 'baseline' || job.kind === 'emergency') {
      var file = result ? (result.file || result.name || result.backupFile || '') : '';
      container.appendChild(el('div', 'dbk-msg dbk-msg-ok', '备份完成' + (file ? '：' + fileBase(file) : '') + '。'));
      container.appendChild(el('div', 'dbk-hint', '如列表未更新，可点击「刷新」。'));
    } else {
      container.appendChild(el('div', 'dbk-msg dbk-msg-ok', '任务已完成。'));
    }
  }

  // 兼容两种恢复结果结构：job.result（restoredSessions 等）与 state.restore.lastResult（counts 汇总）
  function restoreCountsOf(result) {
    var out = { sessions: undefined, workspaces: undefined, files: undefined, attachments: undefined };
    if (!result) {
      return out;
    }
    if (result.counts && typeof result.counts === 'object') {
      out.sessions = result.counts.sessions;
      out.workspaces = result.counts.workspaces;
      out.files = result.counts.files;
      out.attachments = result.counts.attachments;
    }
    if (result.restoredSessions !== undefined) {
      out.sessions = result.restoredSessions;
    }
    if (result.restoredWorkspaces !== undefined) {
      out.workspaces = result.restoredWorkspaces;
    }
    if (result.restoredWorkspaceFiles !== undefined) {
      out.files = result.restoredWorkspaceFiles;
    }
    if (result.restoredFiles !== undefined) {
      out.files = result.restoredFiles;
    }
    if (result.restoredAttachments !== undefined) {
      out.attachments = result.restoredAttachments;
    }
    return out;
  }

  function renderRestoreResult(container, result, suppressRestart) {
    var ok = result && result.ok !== false && !result.error;
    container.appendChild(el('div', 'dbk-result-title', ok ? '恢复完成' : '恢复结果'));
    var counts = restoreCountsOf(result);
    var countParts = [];
    if (counts.sessions !== undefined) {
      countParts.push('会话 ' + num(counts.sessions));
    }
    if (counts.workspaces !== undefined) {
      countParts.push('工作区 ' + num(counts.workspaces));
    }
    if (counts.files !== undefined) {
      countParts.push('文件 ' + num(counts.files));
    }
    if (counts.attachments !== undefined) {
      countParts.push('附件 ' + num(counts.attachments));
    }
    if (countParts.length) {
      container.appendChild(el('div', 'dbk-hint', '已恢复：' + countParts.join(' · ')));
    }
    var skipped = result && result.skipped ? result.skipped : null;
    if (skipped && skipped.length) {
      var skipBox = el('div', 'dbk-hint');
      skipBox.appendChild(el('div', '', '跳过 ' + skipped.length + ' 项：'));
      var i;
      for (i = 0; i < skipped.length; i++) {
        var item = skipped[i] || {};
        var label = item.id || item.path || item.file || ('第 ' + (i + 1) + ' 项');
        var reason = item.reason ? String(item.reason) : '未说明原因';
        skipBox.appendChild(el('div', 'dbk-skip', '· ' + label + '：' + reason));
      }
      container.appendChild(skipBox);
    }
    var pending = !!(ui.state && ui.state.restore && ui.state.restore.pendingRestart);
    if (!suppressRestart && ((result && result.needsColdRestart) || pending)) {
      container.appendChild(el('div', 'dbk-alert dbk-alert-warn', '请划掉后台重新打开 DSHM 应用以加载恢复的数据；重启前不要新建会话'));
    }
    if (result && result.reportText) {
      var pre = el('pre', 'dbk-report');
      pre.textContent = String(result.reportText);
      container.appendChild(pre);
    }
    if (!ok) {
      var err = result && result.error ? formatJobValue(result.error) : '';
      container.appendChild(el('div', 'dbk-alert', '恢复未完成' + (err ? '：' + err : '') + '。当前数据可能处于未完成状态，请勿新建会话。'));
    }
  }

  function renderReport() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    var s = ui.state || {};
    if (s.job) {
      show(d.report, false);
      return;
    }
    var restore = s.restore || null;
    if (!restore || (!restore.pendingRestart && !restore.lastResult)) {
      show(d.report, false);
      clearNode(d.reportBody);
      return;
    }
    show(d.report, true);
    setText(d.reportTitle, restore.pendingRestart ? '恢复已写入，等待冷重启' : '最近一次恢复结果');
    clearNode(d.reportBody);
    if (restore.pendingRestart) {
      d.reportBody.appendChild(el('div', 'dbk-alert dbk-alert-warn', '请划掉后台重新打开 DSHM 应用以加载恢复的数据；重启前不要新建会话'));
    }
    if (restore.lastResult) {
      renderRestoreResult(d.reportBody, restore.lastResult, !!restore.pendingRestart);
    }
  }

  function buildKv(key, value, badgeClass, badgeText) {
    var row = el('div', 'dbk-kv');
    row.appendChild(el('span', 'dbk-kv-key', key));
    var val = el('span', 'dbk-kv-val');
    var hasValue = value !== undefined && value !== null && value !== '';
    if (badgeText) {
      val.appendChild(el('span', 'dbk-badge ' + (badgeClass || ''), badgeText));
      if (hasValue) {
        val.appendChild(document.createTextNode(' ' + String(value)));
      }
    } else if (hasValue) {
      val.textContent = String(value);
    } else {
      val.textContent = '—';
    }
    row.appendChild(val);
    return row;
  }

  function renderBaseline() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    var s = ui.state || {};
    clearNode(d.baselineBody);
    var base = s.baseline || null;
    if (!base) {
      d.baselineBody.appendChild(el('div', 'dbk-empty', '暂无基线'));
    } else {
      d.baselineBody.appendChild(buildKv('时间', fmtTime(base.createdAt)));
      d.baselineBody.appendChild(buildKv('文件', base.name || fileBase(base.file) || '—'));
      d.baselineBody.appendChild(buildKv('大小', fmtSize(base.size)));
      if (base.verified) {
        d.baselineBody.appendChild(buildKv('校验', base.verifiedAt ? fmtTime(base.verifiedAt) : '', 'dbk-verified', '已校验'));
      } else if (base.hasSidecar) {
        d.baselineBody.appendChild(buildKv('校验', '', 'dbk-unverified', '仅有旁文件（未校验）'));
      } else {
        d.baselineBody.appendChild(buildKv('校验', '', 'dbk-unverified', '未校验'));
      }
    }
    if (s.lastManual) {
      d.baselineBody.appendChild(buildKv('最近手动备份', (s.lastManual.name || fileBase(s.lastManual.file) || '—') + ' · ' + fmtTime(s.lastManual.createdAt)));
    }
  }

  function renderBackups() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    var s = ui.state || {};
    var list = [];
    var raw = s.backups;
    var i;
    if (raw && raw.length) {
      for (i = 0; i < raw.length; i++) {
        list.push(raw[i]);
      }
    }
    list.sort(function (a, b) {
      return dateValue(b && b.createdAt) - dateValue(a && a.createdAt);
    });
    if (list.length > MAX_LIST) {
      list = list.slice(0, MAX_LIST);
    }
    setText(d.backupsCount, String(list.length));
    clearNode(d.backupList);
    if (!list.length) {
      show(d.backupEmpty, true);
      return;
    }
    show(d.backupEmpty, false);
    for (i = 0; i < list.length; i++) {
      d.backupList.appendChild(buildBackupRow(list[i]));
    }
  }

  function buildBackupRow(item) {
    var file = (item && (item.file || item.name)) || '';
    var name = (item && item.name) || fileBase(file) || '未命名备份';
    var row = el('div', 'dbk-row');
    var main = el('div', 'dbk-row-main');
    main.appendChild(el('div', 'dbk-row-name', name));
    var meta = el('div', 'dbk-row-meta');
    meta.appendChild(el('span', 'dbk-badge ' + kindBadgeClass(item && item.kind), kindLabel(item && item.kind)));
    meta.appendChild(el('span', '', fmtTime(item && item.createdAt)));
    meta.appendChild(el('span', '', fmtSize(item && item.size)));
    var verified = item ? item.verified : undefined;
    if (verified === true) {
      meta.appendChild(el('span', 'dbk-badge dbk-verified', '已校验'));
    } else if (item && item.hasSidecar === true) {
      meta.appendChild(el('span', 'dbk-badge dbk-unverified', '仅有旁文件（未校验）'));
    } else if (verified === false) {
      meta.appendChild(el('span', 'dbk-badge dbk-unverified', '未校验'));
    }
    main.appendChild(meta);
    var actions = el('div', 'dbk-row-actions');
    var previewBtn = el('button', 'dbk-btn dbk-btn-sm', '预览');
    previewBtn.type = 'button';
    previewBtn.addEventListener('click', guard(function () {
      selectFile(file);
      requestPreview(file);
    }), false);
    var restoreBtn = el('button', 'dbk-btn dbk-btn-sm dbk-btn-primary', '恢复');
    restoreBtn.type = 'button';
    var ready = !!(ui.previewId && ui.previewFile === file && !ui.busyPreview && !isReadOnly());
    restoreBtn.disabled = !ready;
    restoreBtn.title = ready ? '打开预览并确认恢复' : (isReadOnly() ? '只读模式无法恢复' : '请先预览该备份');
    restoreBtn.addEventListener('click', guard(function () {
      if (!ui.previewId || ui.previewFile !== file) {
        showMsg('请先预览该备份', 'warn');
        return;
      }
      resetRestoreArmed();
      showPreviewView();
    }), false);
    append(actions, previewBtn, restoreBtn);
    append(row, main, actions);
    if (file && file === ui.selectedFile) {
      row.className = 'dbk-row dbk-row-selected';
    }
    row.setAttribute('tabindex', '0');
    row.addEventListener('click', guard(function () {
      selectFile(file);
    }), false);
    row.addEventListener('keydown', guard(function (event) {
      if (event && (event.key === 'Enter' || event.key === ' ')) {
        if (event.preventDefault) {
          event.preventDefault();
        }
        selectFile(file);
      }
    }), false);
    return row;
  }

  function selectFile(file) {
    if (!file) {
      return;
    }
    ui.selectedFile = file;
    renderBackups();
    renderActions();
  }

  function findBackupByFile(file) {
    var s = ui.state || {};
    var list = s.backups || [];
    var i;
    for (i = 0; i < list.length; i++) {
      if (list[i] && (list[i].file === file || list[i].name === file)) {
        return list[i];
      }
    }
    return null;
  }

  // ===== 预览 / 恢复确认 =====
  function requestPreview(file) {
    if (!file) {
      return;
    }
    if (ui.busyPreview) {
      showMsg('正在解析上一个预览，请稍候', 'warn');
      return;
    }
    ui.busyPreview = true;
    ui.selectedFile = file;
    renderActions();
    renderBackups();
    showMsg('正在解析备份预览…', 'info');
    request('inspect', { method: 'POST', body: { file: file } }).then(guard(function (data) {
      ui.busyPreview = false;
      ui.preview = (data && data.preview) ? data.preview : {};
      ui.previewId = (data && data.previewId) ? data.previewId : '';
      ui.previewFile = file;
      ui.restoreErrors = collectPreviewErrors(ui.preview);
      ui.restoreArmed = 0;
      renderPreview();
      showPreviewView();
      renderBackups();
      renderActions();
      if (ui.restoreErrors.length) {
        showMsg('预览发现错误，暂不能恢复。', 'err');
      } else {
        showMsg('预览完成，请确认后恢复。', 'ok');
      }
    }), guard(function (err) {
      ui.busyPreview = false;
      ui.preview = null;
      ui.previewId = '';
      ui.previewFile = file;
      ui.restoreErrors = [];
      ui.restoreArmed = 0;
      renderPreviewError(err);
      showPreviewView();
      renderBackups();
      renderActions();
    }));
  }

  function buildCount(label, value) {
    var cell = el('div', 'dbk-count');
    cell.appendChild(el('span', 'dbk-count-num', numOrDash(value)));
    cell.appendChild(el('span', 'dbk-count-label', label));
    return cell;
  }

  // 预览中会阻止恢复的问题：errors（若有）+ conflicts（目标冲突）+ canRestore=false
  function collectPreviewErrors(preview) {
    var errors = [];
    var i;
    if (preview && preview.errors && preview.errors.length) {
      for (i = 0; i < preview.errors.length; i++) {
        errors.push(preview.errors[i]);
      }
    }
    if (preview && preview.conflicts && preview.conflicts.length) {
      for (i = 0; i < preview.conflicts.length; i++) {
        errors.push(preview.conflicts[i]);
      }
    }
    if (preview && preview.canRestore === false && errors.length === 0) {
      errors.push('该备份预览标记为不可恢复');
    }
    return errors;
  }

  function buildPreviewSummary(item, preview) {
    var card = el('div', 'dbk-card');
    card.appendChild(el('div', 'dbk-card-title', '备份摘要'));
    var file = (preview && preview.file) || ui.previewFile || '';
    var name = (item && item.name) || (preview && preview.name) || fileBase(file) || '—';
    var sha = (item && item.sha256) || (preview && preview.sha256) || '';
    var size = (item && item.size !== undefined) ? item.size : (preview ? preview.size : undefined);
    var kind = (item && item.kind) || (preview && preview.manifest ? preview.manifest.kind : '');
    var createdAt = (item && item.createdAt) || (preview && preview.manifest ? preview.manifest.createdAt : '');
    card.appendChild(buildKv('名称', name));
    card.appendChild(buildKv('文件', file || '—'));
    if (kind) {
      card.appendChild(buildKv('类型', kindLabel(kind)));
    }
    if (createdAt) {
      card.appendChild(buildKv('创建时间', fmtTime(createdAt)));
    }
    if (size !== undefined) {
      card.appendChild(buildKv('大小', fmtSize(size)));
    }
    if (sha) {
      card.appendChild(buildKv('SHA-256', shortHash(sha) + '…'));
    }
    return card;
  }

  function buildMappingCard(mapping) {
    var card = el('div', 'dbk-card');
    card.appendChild(el('div', 'dbk-card-title', '路径映射'));
    if (!mapping || !mapping.length) {
      card.appendChild(el('div', 'dbk-empty', '无路径映射'));
      return card;
    }
    var wrap = el('div', 'dbk-scroll');
    var table = el('table', 'dbk-table');
    var thead = el('thead', '');
    var headRow = el('tr', '');
    append(headRow, el('th', '', '从'), el('th', '', '到'), el('th', '', '方式'));
    thead.appendChild(headRow);
    var tbody = el('tbody', '');
    var i;
    for (i = 0; i < mapping.length; i++) {
      var mapItem = mapping[i] || {};
      var tr = el('tr', '');
      var mode = mapItem.mode === 'remap' ? '重映射' : '保持';
      append(tr, el('td', '', mapItem.from || '—'), el('td', '', mapItem.to || '—'), el('td', '', mode));
      tbody.appendChild(tr);
    }
    append(table, thead, tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    return card;
  }

  function buildListCard(title, list, kind) {
    var card = el('div', 'dbk-card');
    card.appendChild(el('div', 'dbk-card-title', title));
    var box = el('div', '');
    var i;
    for (i = 0; i < list.length; i++) {
      var text = (typeof list[i] === 'string') ? list[i] : formatJobValue(list[i]);
      box.appendChild(el('div', 'dbk-item ' + (kind === 'err' ? 'dbk-item-err' : 'dbk-item-warn'), '· ' + text));
    }
    card.appendChild(box);
    return card;
  }

  function buildManifestCard(manifest) {
    var card = el('div', 'dbk-card');
    card.appendChild(el('div', 'dbk-card-title', '清单摘要'));
    if (!manifest || typeof manifest !== 'object') {
      card.appendChild(el('div', 'dbk-empty', '无清单信息'));
      return card;
    }
    var keyList = [];
    try {
      var key;
      for (key in manifest) {
        if (Object.prototype.hasOwnProperty.call(manifest, key)) {
          keyList.push(key);
        }
      }
    } catch (e) {
      keyList = [];
    }
    if (!keyList.length) {
      card.appendChild(el('div', 'dbk-empty', '无清单信息'));
      return card;
    }
    if (keyList.length > 12) {
      keyList = keyList.slice(0, 12);
    }
    var i;
    for (i = 0; i < keyList.length; i++) {
      var name = keyList[i];
      var value = manifest[name];
      if (value === null || value === undefined) {
        continue;
      }
      var text;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        text = String(value);
      } else if (value && typeof value.length === 'number') {
        text = '共 ' + value.length + ' 项';
      } else {
        text = safeJson(value) || '详情不可读';
      }
      card.appendChild(buildKv(name, text));
    }
    return card;
  }

  function renderPreview() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    var preview = ui.preview || {};
    var item = findBackupByFile(ui.previewFile);
    clearNode(d.previewContent);
    d.previewContent.appendChild(buildPreviewSummary(item, preview));

    var countsCard = el('div', 'dbk-card');
    countsCard.appendChild(el('div', 'dbk-card-title', '将恢复内容'));
    var counts = preview.counts || {};
    var fileCount = (counts.files !== undefined) ? counts.files : counts.workspaceFiles;
    var grid = el('div', 'dbk-counts');
    append(grid, buildCount('会话', counts.sessions), buildCount('工作区', counts.workspaces),
      buildCount('文件', fileCount), buildCount('附件', counts.attachments));
    countsCard.appendChild(grid);
    d.previewContent.appendChild(countsCard);

    var targetCard = el('div', 'dbk-card');
    targetCard.appendChild(el('div', 'dbk-card-title', '目标环境'));
    var fresh = preview.targetFresh === true;
    targetCard.appendChild(el('div', '', fresh ? '目标环境看起来是全新安装，可较安全地恢复。' : '目标环境已有数据，恢复可能覆盖或合并现有数据，请谨慎操作。'));
    var freshReasons = preview.targetFreshReasons;
    var freshReasonText = preview.targetFreshReason || (freshReasons && freshReasons.length ? freshReasons.join('；') : '');
    if (freshReasonText) {
      targetCard.appendChild(el('div', 'dbk-hint', '原因：' + freshReasonText));
    }
    d.previewContent.appendChild(targetCard);

    d.previewContent.appendChild(buildMappingCard(preview.mapping));

    if (preview.warnings && preview.warnings.length) {
      d.previewContent.appendChild(buildListCard('警告', preview.warnings, 'warn'));
    }

    if (preview.requiresVersionConfirm || (preview.versionWarnings && preview.versionWarnings.length)) {
      var versionCard = el('div', 'dbk-card');
      versionCard.appendChild(el('div', 'dbk-card-title', '版本提示'));
      versionCard.appendChild(el('div', 'dbk-hint', '备份与当前核心版本不完全一致；确认恢复时需要额外再点一次以确认版本不一致。'));
      var versionList = (preview.versionWarnings && preview.versionWarnings.length) ? preview.versionWarnings : ['版本信息缺失，无法完全比对'];
      var vi;
      for (vi = 0; vi < versionList.length; vi++) {
        var versionText = (typeof versionList[vi] === 'string') ? versionList[vi] : formatJobValue(versionList[vi]);
        versionCard.appendChild(el('div', 'dbk-item dbk-item-warn', '· ' + versionText));
      }
      d.previewContent.appendChild(versionCard);
    }

    var skippedPreview = preview.skippedSessions;
    if (skippedPreview && skippedPreview.length) {
      var skipCard = el('div', 'dbk-card');
      skipCard.appendChild(el('div', 'dbk-card-title', '将跳过的会话'));
      var si;
      for (si = 0; si < skippedPreview.length; si++) {
        var skippedItem = skippedPreview[si] || {};
        var skippedLabel = skippedItem.id || ('第 ' + (si + 1) + ' 项');
        var skippedReason = skippedItem.reason ? String(skippedItem.reason) : '备份时不完整';
        skipCard.appendChild(el('div', 'dbk-item dbk-item-warn', '· ' + skippedLabel + '：' + skippedReason));
      }
      d.previewContent.appendChild(skipCard);
    }

    if (ui.restoreErrors.length) {
      d.previewContent.appendChild(buildListCard('错误（阻止恢复）', ui.restoreErrors, 'err'));
    }

    d.previewContent.appendChild(buildManifestCard(preview.manifest));

    var bar = el('div', 'dbk-preview-bar');
    var hintText = '恢复会覆盖目标环境中的同名数据，请再次确认。';
    if (ui.restoreErrors.length) {
      hintText = '预览存在错误，无法开始恢复。';
    } else if (preview.requiresVersionConfirm) {
      hintText = '备份与当前核心版本不一致：确认恢复时需要额外再点一次确认版本不一致；恢复会覆盖目标环境中的同名数据。';
    }
    var hint = el('div', 'dbk-hint', hintText);
    var confirmBtn = el('button', 'dbk-btn dbk-btn-warn', '确认恢复');
    confirmBtn.type = 'button';
    confirmBtn.addEventListener('click', guard(onConfirmRestoreClick), false);
    var cancelBtn = el('button', 'dbk-btn', '取消');
    cancelBtn.type = 'button';
    cancelBtn.addEventListener('click', guard(backToMain), false);
    append(bar, hint, confirmBtn, cancelBtn);
    d.previewContent.appendChild(bar);
    d.previewConfirm = confirmBtn;
    d.previewHint = hint;
    updateConfirmButton();
  }

  function renderPreviewError(err) {
    var d = ui.dom;
    if (!d) {
      return;
    }
    clearNode(d.previewContent);
    var card = el('div', 'dbk-card');
    card.appendChild(el('div', 'dbk-card-title', '预览失败'));
    card.appendChild(el('div', 'dbk-alert', formatError(err)));
    card.appendChild(el('div', 'dbk-hint', '该备份无法用于恢复，请返回列表选择其他备份，或重新生成备份。'));
    d.previewContent.appendChild(card);
    var bar = el('div', 'dbk-preview-bar');
    var backBtn = el('button', 'dbk-btn', '返回列表');
    backBtn.type = 'button';
    backBtn.addEventListener('click', guard(backToMain), false);
    bar.appendChild(backBtn);
    d.previewContent.appendChild(bar);
    d.previewConfirm = null;
    d.previewHint = null;
  }

  function updateConfirmButton() {
    var d = ui.dom;
    if (!d || !d.previewConfirm) {
      return;
    }
    var btn = d.previewConfirm;
    var mismatch = !!(ui.preview && ui.preview.requiresVersionConfirm === true);
    btn.disabled = isReadOnly() || ui.busyRestore || ui.restoreErrors.length > 0 || !ui.previewId;
    if (ui.busyRestore) {
      btn.textContent = '正在提交恢复…';
      btn.className = 'dbk-btn dbk-btn-warn';
    } else if (ui.restoreArmed >= 2) {
      btn.textContent = '版本不一致，再次点击仍要恢复';
      btn.className = 'dbk-btn dbk-btn-warn dbk-btn-armed';
    } else if (ui.restoreArmed >= 1) {
      btn.textContent = '再次点击确认恢复';
      btn.className = 'dbk-btn dbk-btn-warn dbk-btn-armed';
    } else if (mismatch) {
      btn.textContent = '确认恢复（版本不一致）';
      btn.className = 'dbk-btn dbk-btn-warn';
    } else {
      btn.textContent = '确认恢复';
      btn.className = 'dbk-btn dbk-btn-warn';
    }
    if (isReadOnly()) {
      btn.title = '只读模式：' + readOnlyReason();
    } else if (ui.restoreErrors.length > 0) {
      btn.title = '预览存在错误，无法恢复';
    } else if (mismatch) {
      btn.title = '备份与当前核心版本不一致，点击后需再次确认';
    } else {
      btn.title = '';
    }
  }

  function onConfirmRestoreClick() {
    if (isReadOnly()) {
      showMsg('只读模式：' + readOnlyReason(), 'warn');
      return;
    }
    if (!ui.previewId) {
      showMsg('预览标识缺失，请重新预览该备份。', 'err');
      return;
    }
    if (ui.restoreErrors.length > 0) {
      showMsg('预览存在错误，无法恢复。', 'err');
      return;
    }
    var mismatch = !!(ui.preview && ui.preview.requiresVersionConfirm === true);
    if (ui.restoreArmed < 1) {
      ui.restoreArmed = 1;
      updateConfirmButton();
      showMsg('请再次点击「再次点击确认恢复」以开始恢复。', 'warn');
      return;
    }
    if (mismatch && ui.restoreArmed < 2) {
      ui.restoreArmed = 2;
      updateConfirmButton();
      showMsg('备份与当前核心版本不一致：如仍要恢复，请再次点击「版本不一致，再次点击仍要恢复」。', 'warn');
      return;
    }
    startRestore();
  }

  function resetRestoreArmed() {
    ui.restoreArmed = 0;
    updateConfirmButton();
  }

  function startRestore() {
    if (ui.busyRestore) {
      return;
    }
    var allowMismatch = ui.restoreArmed >= 2 && ui.preview && ui.preview.requiresVersionConfirm === true;
    var body = { previewId: ui.previewId, confirm: true };
    if (allowMismatch) {
      body.allowVersionMismatch = true;
    }
    ui.busyRestore = true;
    updateConfirmButton();
    showMsg('正在提交恢复任务…', 'info');
    request('restore', { method: 'POST', body: body }).then(guard(function (data) {
      ui.busyRestore = false;
      ui.restoreArmed = 0;
      ui.preview = null;
      ui.previewId = '';
      ui.previewFile = '';
      ui.restoreErrors = [];
      if (ui.dom && ui.dom.previewContent) {
        clearNode(ui.dom.previewContent);
      }
      if (ui.dom) {
        ui.dom.previewConfirm = null;
        ui.dom.previewHint = null;
      }
      var s = ui.state || {};
      s.job = {
        id: (data && data.jobId) ? data.jobId : '',
        kind: 'restore',
        phase: 'scanning',
        percent: 0,
        message: '恢复任务已开始',
        startedAt: new Date().toISOString()
      };
      ui.state = s;
      ui.pollExpected = true;
      showMainView();
      renderAll(s);
      schedulePoll();
      showMsg('恢复任务已开始，请等待完成；完成后需要冷重启应用。', 'info');
    }), guard(function (err) {
      ui.busyRestore = false;
      ui.restoreArmed = 0;
      updateConfirmButton();
      if (err && err.code === 'VERSION_MISMATCH') {
        showMsg('备份与当前核心版本不一致：请重新预览该备份，并按「版本不一致」流程再次确认。', 'warn');
      } else {
        showMsg('恢复请求失败：' + formatError(err), 'err');
      }
    }));
  }

  // ===== 主操作 =====
  function loadState(options) {
    var opts = options || {};
    if (ui.stateLoading) {
      return;
    }
    ui.stateLoading = true;
    renderStatus();
    renderActions();
    request('state').then(guard(function (data) {
      ui.stateLoading = false;
      ui.stateError = '';
      ui.pollFailures = 0;
      if (!data || data.ok === false) {
        ui.stateError = (data && (data.error || data.message)) || '服务返回异常状态';
        renderStatus();
        renderActions();
        return;
      }
      ui.state = data;
      var job = data.job || null;
      var jobRunning = !!(job && job.phase !== 'done' && job.phase !== 'failed');
      if (jobRunning) {
        ui.gracePolls = 0;
        ui.pollExpected = true;
      } else if (!job && ui.pollExpected && ui.gracePolls < 2) {
        // 刚提交任务时宿主可能尚未写入 job，给少量宽限轮询；任务确实结束则停止
        ui.gracePolls++;
        ui.pollExpected = true;
      } else {
        ui.gracePolls = 0;
        ui.pollExpected = false;
      }
      if (ui.open) {
        renderAll(data);
      }
      if (ui.open && ui.pollExpected) {
        schedulePoll();
      } else {
        stopPoll();
      }
      if (opts.manual) {
        showMsg('已刷新', 'ok');
      }
    }), guard(function (err) {
      ui.stateLoading = false;
      ui.stateError = formatError(err);
      ui.pollFailures++;
      renderStatus();
      renderActions();
      if (ui.open && ui.pollExpected && ui.pollFailures < 30) {
        schedulePoll();
      }
    }));
  }

  function schedulePoll() {
    if (!ui.open) {
      return;
    }
    if (ui.pollTimer) {
      return;
    }
    ui.pollTimer = setTimeout(function () {
      ui.pollTimer = null;
      if (!ui.open) {
        return;
      }
      try {
        loadState({ silent: true });
      } catch (e) {
        stopPoll();
      }
    }, POLL_MS);
  }

  function stopPoll() {
    if (ui.pollTimer) {
      clearTimeout(ui.pollTimer);
      ui.pollTimer = null;
    }
  }

  function startBackup() {
    if (isReadOnly()) {
      showMsg('只读模式：' + readOnlyReason(), 'warn');
      return;
    }
    if (ui.busyBackup) {
      return;
    }
    ui.busyBackup = true;
    renderActions();
    showMsg('正在提交备份任务…', 'info');
    request('backup', { method: 'POST', body: { kind: 'manual' } }).then(guard(function (data) {
      ui.busyBackup = false;
      var s = ui.state || {};
      s.job = {
        id: (data && data.jobId) ? data.jobId : '',
        kind: 'backup',
        phase: 'scanning',
        percent: 0,
        message: '备份任务已开始',
        startedAt: new Date().toISOString()
      };
      ui.state = s;
      ui.pollExpected = true;
      renderAll(s);
      schedulePoll();
      showMsg('备份任务已开始，进度每秒自动刷新。', 'info');
    }), guard(function (err) {
      ui.busyBackup = false;
      renderActions();
      if (err && err.status === 409) {
        showMsg('已有任务进行中，请等待完成或稍后刷新。', 'warn');
        loadState({ silent: true });
      } else {
        showMsg('备份请求失败：' + formatError(err), 'err');
      }
    }));
  }

  function refreshAll() {
    if (ui.stateLoading) {
      return;
    }
    showMsg('正在刷新…', 'info');
    loadState({ manual: true });
  }

  function verifySelected() {
    var file = ui.selectedFile;
    if (!file) {
      showMsg('请先点击选中一条备份记录。', 'warn');
      return;
    }
    if (ui.busyVerify) {
      return;
    }
    var fileName = fileBase(file);
    ui.busyVerify = true;
    renderActions();
    showMsg('正在校验：' + fileName + '…', 'info');
    request('verify', { method: 'POST', body: { file: fileName } }).then(guard(function (data) {
      ui.busyVerify = false;
      renderActions();
      if (data && data.verified) {
        var extra = data.sha256 ? '（SHA-256 ' + shortHash(data.sha256) + '）' : '';
        showMsg('校验通过：' + fileName + extra, 'ok');
      } else {
        showMsg('校验未通过：文件可能已损坏，请勿用于恢复。', 'err');
      }
      loadState({ silent: true });
    }), guard(function (err) {
      ui.busyVerify = false;
      renderActions();
      if (err && err.status === 422) {
        showMsg('校验未通过：备份文件已损坏或内容不一致，请勿用于恢复。', 'err');
      } else {
        showMsg('校验失败：' + formatError(err), 'err');
      }
    }));
  }

  function copyBackupDir() {
    var s = ui.state || {};
    var dir = s.backupDir ? String(s.backupDir) : '';
    if (!dir) {
      showMsg('没有可复制的备份目录', 'warn');
      return;
    }
    function copied() {
      showMsg('已复制备份目录：' + dir, 'ok');
    }
    function failed() {
      showMsg('复制失败，请手动选择目录文本复制。', 'err');
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(dir).then(copied, function () {
          legacyCopy(dir, copied, failed);
        });
      } else {
        legacyCopy(dir, copied, failed);
      }
    } catch (e) {
      legacyCopy(dir, copied, failed);
    }
  }

  function legacyCopy(text, onOk, onFail) {
    try {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', 'readonly');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.left = '-9999px';
      document.body.appendChild(area);
      area.select();
      var done = false;
      try {
        done = document.execCommand('copy');
      } catch (e) {
        done = false;
      }
      document.body.removeChild(area);
      if (done) {
        onOk();
      } else {
        onFail();
      }
    } catch (e2) {
      onFail();
    }
  }

  // ===== 面板开关 / 视图切换 =====
  function openPanel() {
    if (!ui.mounted || !ui.dom || ui.open) {
      return;
    }
    ui.open = true;
    ui.stateError = '';
    ensureAttached();
    if (!ui.rescue) {
      try {
        if (detectFailurePage()) {
          enterRescueMode();
        }
      } catch (e) {
        // 忽略失败页复查异常
      }
    }
    if (ui.msgTimer) {
      clearTimeout(ui.msgTimer);
      ui.msgTimer = null;
    }
    show(ui.dom.msg, false);
    show(ui.dom.overlay, true);
    detectDark();
    showMainView();
    renderAll(ui.state);
    renderStatus();
    if (ui.rescue) {
      renderRescue();
      triggerEmergency();
    }
    loadState({ silent: false });
    try {
      ui.dom.closeBtn.focus();
    } catch (e) {
      // 忽略聚焦失败
    }
  }

  function closePanel() {
    if (!ui.open) {
      return;
    }
    ui.open = false;
    stopPoll();
    if (ui.dom) {
      show(ui.dom.overlay, false);
    }
    resetRestoreArmed();
    showMainView();
  }

  function showMainView() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    show(d.bodyMain, true);
    show(d.bodyPreview, false);
    if (d.bodyMain) {
      d.bodyMain.scrollTop = 0;
    }
  }

  function showPreviewView() {
    var d = ui.dom;
    if (!d) {
      return;
    }
    show(d.bodyMain, false);
    show(d.bodyPreview, true);
    if (d.bodyPreview) {
      d.bodyPreview.scrollTop = 0;
    }
  }

  function backToMain() {
    resetRestoreArmed();
    showMainView();
  }

  function onFabClick(event) {
    if (fabDrag.suppressClick) {
      fabDrag.suppressClick = false;
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    openPanel();
  }

  function onOverlayClick(event) {
    if (event && event.target === ui.dom.overlay) {
      closePanel();
    }
  }

  function onKeydown(event) {
    if (!event || event.key !== 'Escape') {
      return;
    }
    if (ui.open) {
      closePanel();
    }
  }

  function showMsg(text, kind) {
    var d = ui.dom;
    if (!d || !d.msg) {
      return;
    }
    d.msg.className = 'dbk-msg dbk-msg-' + (kind || 'info');
    setText(d.msg, text);
    show(d.msg, true);
    if (ui.msgTimer) {
      clearTimeout(ui.msgTimer);
      ui.msgTimer = null;
    }
    ui.msgTimer = setTimeout(function () {
      ui.msgTimer = null;
      if (ui.dom && ui.dom.msg) {
        show(ui.dom.msg, false);
      }
    }, 6000);
  }

  // ===== 失败页救援模式 =====
  // 宿主可能在脚本挂载后重建页面内容，检测到悬浮按钮/遮罩被移除时重新挂载
  function ensureAttached() {
    var d = ui.dom;
    if (!d || !document.body) {
      return;
    }
    try {
      if (!document.body.contains(d.fab)) {
        document.body.appendChild(d.fab);
      }
      if (!document.body.contains(d.overlay)) {
        document.body.appendChild(d.overlay);
      }
    } catch (e) {
      // 忽略重新挂载失败
    }
  }

  function triggerEmergency() {
    if (!ui.rescue || ui.emergencySent) {
      return;
    }
    ui.emergencySent = true;
    renderRescue();
    request('emergency', { method: 'POST', body: {} }).then(guard(function (data) {
      ui.emergencyResult = data || {};
      ui.emergencyError = '';
      renderRescue();
      if (data && data.started) {
        ui.pollExpected = true;
      }
      loadState({ silent: true });
    }), guard(function (err) {
      ui.emergencyError = formatError(err);
      renderRescue();
    }));
  }

  function enterRescueMode() {
    if (ui.rescue) {
      return;
    }
    ui.rescue = true;
    if (!ui.dom) {
      return;
    }
    ui.dom.fab.className = 'dbk-fab dbk-fab-rescue';
    setText(ui.dom.fab, '备份工具（救援）');
    ui.dom.fab.title = '插件加载失败页：打开备份救援面板；长按可拖动位置';
    ui.dom.fab.setAttribute('aria-label', '备份工具（救援）；长按可拖动位置');
    ensureAttached();
    detectDark();
    renderRescue();
    if (ui.open) {
      triggerEmergency();
    }
  }

  // 宿主失败页可能在 defer 脚本之后才渲染出失败文案，做少量一次性延迟复查（非定时常驻）
  function scheduleRescueChecks() {
    var delays = [800, 2200, 5000, 9000];
    var index = 0;
    function next() {
      if (ui.rescue || index >= delays.length) {
        return;
      }
      var delay = delays[index];
      index++;
      setTimeout(function () {
        ensureAttached();
        if (ui.rescue) {
          return;
        }
        try {
          if (detectFailurePage()) {
            enterRescueMode();
          } else {
            next();
          }
        } catch (e) {
          // 忽略复查异常
        }
      }, delay);
    }
    next();
  }

  // ===== 挂载 =====
  function mount() {
    if (ui.mounted) {
      return;
    }
    try {
      if (!document.body) {
        return;
      }
      ui.rescue = detectFailurePage();
      buildDom();
      document.body.appendChild(ui.dom.fab);
      document.body.appendChild(ui.dom.overlay);
      fabRestoreSavedPosition();
      ui.mounted = true;
      detectDark();
      window[SENTINEL] = {
        version: VERSION,
        mounted: true,
        rescue: ui.rescue,
        open: openPanel,
        close: closePanel
      };
      document.addEventListener('keydown', guard(onKeydown), false);
      scheduleRescueChecks();
      loadState({ silent: true });
    } catch (e) {
      window[SENTINEL] = { version: VERSION, mounted: false, failed: true };
      try {
        console.warn('[dshm-backup] 客户端界面初始化失败');
      } catch (e2) {
        // 忽略
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, false);
  } else {
    setTimeout(mount, 0);
  }
})();
