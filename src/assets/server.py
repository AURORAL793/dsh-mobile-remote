#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
========================================================================
 局域网文件浏览器 · LanFileBrowser
========================================================================
在电脑上运行本程序，手机连接同一个 Wi-Fi / 路由器，用手机浏览器
打开屏幕上显示的地址（或扫二维码），即可浏览电脑里的：

    照片 / 图片      文本 / 代码 / 日志      视频 / 音乐      任意文件

特点：
  · 不用装 App：手机浏览器打开即用，可「添加到主屏幕」当 App
  · 缩略图网格、全屏看图（左右滑动切换、双指缩放 / 双击放大）
  · txt 自动识别编码（UTF-8 / GBK / GB18030 / UTF-16 …），可调字号
  · 视频、音乐在线播放，支持拖动进度条（HTTP Range）
  · 搜索当前文件夹、排序、网格 / 列表切换、深色模式
  · 完全只读：不会修改、删除电脑上的任何文件

依赖：
  Python 3.8+ 即可运行；以下两个库可选，装了体验更好：
    pip install Pillow        # 生成缩略图（强烈建议）
    pip install qrcode        # 启动时在电脑屏幕上显示二维码
  没有 Pillow 时图片不显示缩略图，但点开仍能看原图。

用法：
  python server.py                  # 默认端口 8787，自动打开浏览器
  python server.py --port 9000      # 换端口
  python server.py --no-browser     # 不自动打开浏览器
  python server.py --no-qr          # 不在终端打印二维码
  python server.py --clear-cache    # 清空缩略图缓存后启动
"""

import argparse
import base64
import codecs
import hashlib
import io
import json
import mimetypes
import os
import re
import shutil
import socket
import sys
import threading
import time
import traceback
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlparse

# ----------------------------------------------------------------------------
# 可选依赖
# ----------------------------------------------------------------------------
try:
    from PIL import Image, ImageDraw, ImageOps
    Image.MAX_IMAGE_PIXELS = 300_000_000          # 允许 3 亿像素，避免误报
    HAS_PIL = True
except Exception:                                  # pragma: no cover
    HAS_PIL = False

try:                                               # HEIC（iPhone 照片）
    import pillow_heif
    pillow_heif.register_heif_opener()
    HAS_HEIF = True
except Exception:
    HAS_HEIF = False

try:
    import qrcode
    HAS_QR = True
except Exception:
    HAS_QR = False

try:
    import winreg
except Exception:
    winreg = None

# ----------------------------------------------------------------------------
# 常量 / 路径
# ----------------------------------------------------------------------------
APP_DIR = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(APP_DIR, 'web')
CONFIG_PATH = os.path.join(APP_DIR, 'config.json')

_LOCAL = os.environ.get('LOCALAPPDATA') or os.path.join(os.path.expanduser('~'), '.cache')
DATA_DIR = os.path.join(_LOCAL, 'LanFileBrowser')
THUMB_DIR = os.path.join(DATA_DIR, 'thumbs')
VIEW_DIR = os.path.join(DATA_DIR, 'views')
ICON_DIR = os.path.join(DATA_DIR, 'icons')

DEFAULT_CONFIG = {
    "port": 8787,
    "bind": "0.0.0.0",
    "pin": "",                 # 留空 = 不需要密码；例如 "1234" 则手机要输 PIN
    "open_browser": True,
    "ai_port": 8788,           # DSH 手机版代理端口（首页「AI 助手」入口用）
}

VERBOSE = False
APP_VERSION = '1.0.0'

IMAGE_EXT = {
    'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'heif',
    'tif', 'tiff', 'ico', 'svg', 'jpe', 'apng',
}
VIDEO_EXT = {
    'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', '3gp', '3g2', 'ts', 'mts', 'm2ts',
    'flv', 'wmv', 'mpg', 'mpeg', 'rmvb', 'rm', 'ogv',
}
AUDIO_EXT = {
    'mp3', 'm4a', 'wav', 'flac', 'ogg', 'oga', 'aac', 'opus', 'wma', 'ape', 'amr',
}
TEXT_EXT = {
    'txt', 'md', 'markdown', 'log', 'json', 'jsonl', 'csv', 'tsv', 'ini', 'cfg',
    'conf', 'yml', 'yaml', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'cjs', 'ts',
    'tsx', 'jsx', 'py', 'bat', 'cmd', 'ps1', 'sh', 'c', 'h', 'cpp', 'hpp', 'cc',
    'java', 'go', 'rs', 'sql', 'srt', 'ass', 'ssa', 'vtt', 'lrc', 'properties',
    'toml', 'gitignore', 'env', 'license', 'readme', 'nfo', 'reg', 'rst', 'tex',
    'vue', 'php', 'rb', 'swift', 'kt', 'lua', 'r', 'm', 'pl', 'makefile',
}
# 目录列表里跳过系统噪音
SKIP_DIRS = {
    '$recycle.bin', 'system volume information', 'config.msi', '$windows.~bt',
    '$windows.~ws', 'recovery', 'perflogs', 'windows.old', 'msocache',
    'found.000', 'found.001', 'found.002',
}
SKIP_FILES = {
    'pagefile.sys', 'hiberfil.sys', 'swapfile.sys', 'desktop.ini', 'thumbs.db',
    'ntuser.dat', 'ntuser.ini', 'bootmgr', 'bootnxt',
}

MIME_MAP = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'jfif': 'image/jpeg', 'jpe': 'image/jpeg',
    'png': 'image/png', 'apng': 'image/apng', 'gif': 'image/gif', 'webp': 'image/webp',
    'bmp': 'image/bmp', 'ico': 'image/x-icon', 'svg': 'image/svg+xml',
    'avif': 'image/avif', 'heic': 'image/heic', 'heif': 'image/heif',
    'tif': 'image/tiff', 'tiff': 'image/tiff',
    'mp4': 'video/mp4', 'm4v': 'video/mp4', 'mov': 'video/quicktime', 'webm': 'video/webm',
    'mkv': 'video/x-matroska', 'avi': 'video/x-msvideo', '3gp': 'video/3gpp',
    '3g2': 'video/3gpp2', 'ts': 'video/mp2t', 'mts': 'video/mp2t', 'm2ts': 'video/mp2t',
    'flv': 'video/x-flv', 'wmv': 'video/x-ms-wmv', 'mpg': 'video/mpeg', 'mpeg': 'video/mpeg',
    'ogv': 'video/ogg', 'rmvb': 'application/vnd.rn-realmedia-vbr',
    'mp3': 'audio/mpeg', 'm4a': 'audio/mp4', 'wav': 'audio/wav', 'flac': 'audio/flac',
    'ogg': 'audio/ogg', 'oga': 'audio/ogg', 'aac': 'audio/aac', 'opus': 'audio/opus',
    'wma': 'audio/x-ms-wma', 'ape': 'audio/x-ape', 'amr': 'audio/amr',
    'txt': 'text/plain; charset=utf-8', 'md': 'text/plain; charset=utf-8',
    'log': 'text/plain; charset=utf-8', 'csv': 'text/plain; charset=utf-8',
    'json': 'application/json; charset=utf-8', 'xml': 'text/xml; charset=utf-8',
    'html': 'text/html; charset=utf-8', 'htm': 'text/html; charset=utf-8',
    'css': 'text/css; charset=utf-8', 'js': 'text/javascript; charset=utf-8',
    'pdf': 'application/pdf', 'zip': 'application/zip', 'rar': 'application/vnd.rar',
    '7z': 'application/x-7z-compressed', 'tar': 'application/x-tar',
    'gz': 'application/gzip', 'apk': 'application/vnd.android.package-archive',
}

_nat_re = re.compile(r'(\d+)')


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def natural_key(text):
    """自然排序：文件2 排在 文件10 前面。"""
    parts = _nat_re.split((text or '').lower())
    return [(0, int(p)) if p.isdigit() else (1, p) for p in parts]


def extension_of(name):
    return os.path.splitext(name)[1].lower().lstrip('.')


def kind_of(name, is_dir=False):
    if is_dir:
        return 'dir'
    ext = extension_of(name)
    if ext in IMAGE_EXT:
        return 'image'
    if ext in VIDEO_EXT:
        return 'video'
    if ext in AUDIO_EXT:
        return 'audio'
    if ext in TEXT_EXT:
        return 'text'
    if ext == 'pdf':
        return 'pdf'
    return 'file'


def guess_mime(path):
    ext = extension_of(path)
    if ext in MIME_MAP:
        return MIME_MAP[ext]
    ctype, _ = mimetypes.guess_type(path)
    return ctype or 'application/octet-stream'


# ----------------------------------------------------------------------------
# 路径 / 编码辅助
# ----------------------------------------------------------------------------
def b64d(text):
    """URL-safe base64 -> str"""
    if not text:
        return ''
    s = text.strip().replace('-', '+').replace('_', '/')
    s += '=' * (-len(s) % 4)
    try:
        return base64.b64decode(s).decode('utf-8', 'replace')
    except Exception:
        return ''


def b64e(text):
    """str -> URL-safe base64"""
    return base64.urlsafe_b64encode(text.encode('utf-8')).decode('ascii').rstrip('=')


def safe_path(raw):
    """校验并规范化客户端传来的绝对路径，拒绝 UNC / 相对路径。"""
    if not raw:
        return None
    p = os.path.normpath(os.path.expanduser(raw))
    if not os.path.isabs(p):
        return None
    if p.startswith('\\\\'):            # 网络共享
        return None
    if not re.match(r'^[A-Za-z]:\\', p + ('\\' if not p.endswith('\\') else '')):
        return None
    return p


def is_drive_root(path):
    return bool(re.match(r'^[A-Za-z]:\\?$', path))


def decode_text_bytes(data):
    """尽力把字节解码成文本，返回 (文本, 编码名)。"""
    if data.startswith(codecs.BOM_UTF8):
        return data.decode('utf-8-sig', 'replace'), 'UTF-8 (BOM)'
    if data.startswith(codecs.BOM_UTF16_LE) or data.startswith(codecs.BOM_UTF16_BE):
        return data.decode('utf-16', 'replace'), 'UTF-16'
    for enc, label in (('utf-8', 'UTF-8'), ('gb18030', 'GB18030 / GBK'),
                       ('big5', 'Big5'), ('shift_jis', 'Shift-JIS')):
        try:
            return data.decode(enc), label
        except UnicodeDecodeError:
            continue
    return data.decode('latin-1'), 'Latin-1'


def looks_binary(data):
    """判断字节串更像二进制还是文本（先认 BOM，再看 NUL / 控制字符占比）。"""
    if not data:
        return False
    # UTF-16 文本天然含 NUL 字节，有 BOM 就是文本
    if (data.startswith(codecs.BOM_UTF8)
            or data.startswith(codecs.BOM_UTF16_LE)
            or data.startswith(codecs.BOM_UTF16_BE)):
        return False
    sample = data[:8192]
    if b'\x00' in sample:
        return True
    control = sum(1 for b in sample if b < 9 or 13 < b < 32 or b == 127)
    return (control / len(sample)) > 0.10


def known_folder(name):
    """从注册表读取「桌面 / 图片 / 下载」等真实路径（兼容 OneDrive 重定向）。"""
    if winreg is None:
        return None
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r'Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders',
        ) as key:
            value, _ = winreg.QueryValueEx(key, name)
        return os.path.expandvars(value)
    except Exception:
        return None


def volume_label(root):
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(261)
        ctypes.windll.kernel32.GetVolumeInformationW(
            ctypes.c_wchar_p(root), buf, 261, None, None, None, None, 0)
        return buf.value or ''
    except Exception:
        return ''


def port_open(host, port, timeout=0.25):
    """本机端口是否有服务在监听（用于探测 AI 代理是否启动）。"""
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


# ----------------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------------
def load_config():
    cfg = dict(DEFAULT_CONFIG)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                cfg.update(json.load(f) or {})
        except Exception:
            log('config.json 读取失败，使用默认配置')
    else:
        try:
            with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
                json.dump(cfg, f, ensure_ascii=False, indent=2)
        except Exception:
            pass
    return cfg


# ----------------------------------------------------------------------------
# 目录列表
# ----------------------------------------------------------------------------
def list_directory(path, sort='name', order='asc', limit=4000):
    dirs, files = [], []
    with os.scandir(path) as it:
        for entry in it:
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
                low = entry.name.lower()
                if is_dir:
                    if low in SKIP_DIRS:
                        continue
                    st = entry.stat(follow_symlinks=False)
                    dirs.append({
                        'name': entry.name, 'type': 'dir', 'size': 0,
                        'mtime': int(st.st_mtime), 'ext': '',
                    })
                else:
                    if low in SKIP_FILES:
                        continue
                    st = entry.stat(follow_symlinks=False)
                    ext = extension_of(entry.name)
                    files.append({
                        'name': entry.name,
                        'type': kind_of(entry.name),
                        'size': st.st_size,
                        'mtime': int(st.st_mtime),
                        'ext': ext,
                    })
            except (OSError, PermissionError):
                continue

    if sort == 'time':
        key_func = lambda x: x['mtime']        # noqa: E731
        rev = (order == 'desc')
    elif sort == 'size':
        key_func = lambda x: x['size']         # noqa: E731
        rev = (order == 'desc')
    else:
        key_func = lambda x: natural_key(x['name'])   # noqa: E731
        rev = (order == 'desc')

    dirs.sort(key=key_func, reverse=rev)
    files.sort(key=key_func, reverse=rev)
    total = len(dirs) + len(files)
    merged = (dirs + files)
    truncated = total > limit
    return merged[:limit], truncated, total


# ----------------------------------------------------------------------------
# 缩略图 / 预览图
# ----------------------------------------------------------------------------
def _ensure_dir(d):
    try:
        os.makedirs(d, exist_ok=True)
    except Exception:
        pass


def _cache_path(base_dir, path, extra):
    try:
        st = os.stat(path)
        stamp = f'{st.st_mtime_ns}|{st.st_size}'
    except OSError:
        stamp = '0|0'
    raw = f'{path}|{stamp}|{extra}'.encode('utf-8', 'surrogatepass')
    key = hashlib.sha1(raw).hexdigest()
    return os.path.join(base_dir, key[:2], key[2:] + '.jpg')


def make_thumbnail(path, size):
    """返回缩略图缓存文件路径；失败返回 None。"""
    out = _cache_path(THUMB_DIR, path, f'thumb{size}')
    if os.path.exists(out):
        return out
    if not HAS_PIL:
        return None
    try:
        _ensure_dir(os.path.dirname(out))
        with Image.open(path) as im:
            try:
                im.draft('RGB', (size * 2, size * 2))     # JPEG 快速降采样
            except Exception:
                pass
            im = ImageOps.exif_transpose(im)
            if im.mode in ('RGBA', 'LA', 'P', 'PA'):
                rgba = im.convert('RGBA')
                bg = Image.new('RGB', rgba.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.split()[-1])
                im = bg
            elif im.mode != 'RGB':
                im = im.convert('RGB')
            im.thumbnail((size, size), Image.LANCZOS)
            tmp = out + f'.{os.getpid()}.{threading.get_ident()}.tmp'
            im.save(tmp, 'JPEG', quality=85, optimize=True, progressive=True)
            os.replace(tmp, out)
        return out
    except Exception:
        return None


def make_preview(path, max_side):
    """生成适合手机屏幕的预览大图；失败返回 None。"""
    out = _cache_path(VIEW_DIR, path, f'view{max_side}')
    if os.path.exists(out):
        return out
    if not HAS_PIL:
        return None
    try:
        _ensure_dir(os.path.dirname(out))
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ('RGBA', 'LA', 'P', 'PA'):
                rgba = im.convert('RGBA')
                bg = Image.new('RGB', rgba.size, (255, 255, 255))
                bg.paste(rgba, mask=rgba.split()[-1])
                im = bg
            elif im.mode != 'RGB':
                im = im.convert('RGB')
            im.thumbnail((max_side, max_side), Image.LANCZOS)
            tmp = out + f'.{os.getpid()}.{threading.get_ident()}.tmp'
            im.save(tmp, 'JPEG', quality=88, optimize=True, progressive=True)
            os.replace(tmp, out)
        return out
    except Exception:
        return None


def cleanup_cache(max_bytes=1536 * 1024 * 1024):
    """缩略图缓存超过 1.5GB 时删掉最旧的文件。"""
    try:
        files = []
        total = 0
        for base in (THUMB_DIR, VIEW_DIR):
            for root, _dirs, names in os.walk(base):
                for n in names:
                    if not n.lower().endswith(('.jpg', '.tmp')):
                        continue
                    fp = os.path.join(root, n)
                    try:
                        st = os.stat(fp)
                    except OSError:
                        continue
                    files.append((st.st_mtime, st.st_size, fp))
                    total += st.st_size
        if total <= max_bytes:
            return
        files.sort()
        removed = 0
        target = total * 0.7
        for _mtime, size, fp in files:
            try:
                os.remove(fp)
                removed += 1
                total -= size
            except OSError:
                pass
            if total <= target:
                break
        if removed:
            log(f'缓存清理：删除 {removed} 个旧缩略图')
    except Exception:
        pass


# ----------------------------------------------------------------------------
# 图片信息
# ----------------------------------------------------------------------------
def image_info(path):
    info = {}
    if not HAS_PIL:
        return info
    try:
        with Image.open(path) as im:
            info['width'], info['height'] = im.size
            info['format'] = im.format or ''
            try:
                exif = im.getexif()
            except Exception:
                exif = None
            if exif:
                def pick(tag_id):
                    v = exif.get(tag_id)
                    if isinstance(v, bytes):
                        try:
                            v = v.decode('utf-8', 'replace').strip('\x00').strip()
                        except Exception:
                            return ''
                    return str(v).strip() if v is not None else ''

                taken = pick(36867) or pick(306)
                make = pick(271)
                model = pick(272)
                if taken:
                    info['taken'] = taken
                if make or model:
                    info['camera'] = f'{make} {model}'.strip()
                try:
                    orient = exif.get(274)
                    if orient:
                        info['orientation'] = int(orient)
                except Exception:
                    pass
    except Exception:
        pass
    return info


# ----------------------------------------------------------------------------
# 位置（首页快捷入口）
# ----------------------------------------------------------------------------
def build_locations():
    home = os.path.expanduser('~')
    locs = []
    seen = set()

    def add(name, path, icon, extra=None):
        if not path:
            return
        path = os.path.normpath(path)
        if not os.path.isdir(path):
            return
        key = path.lower()
        if key in seen:
            return
        seen.add(key)
        item = {'name': name, 'path': path, 'icon': icon, 'kind': 'folder'}
        if extra:
            item.update(extra)
        locs.append(item)

    desktop = known_folder('Desktop') or os.path.join(home, 'Desktop')
    pictures = known_folder('My Pictures') or os.path.join(home, 'Pictures')
    downloads = (known_folder('{374DE290-123F-4565-9164-39C4925E467B}')
                 or os.path.join(home, 'Downloads'))
    documents = known_folder('Personal') or os.path.join(home, 'Documents')
    videos = known_folder('My Video') or os.path.join(home, 'Videos')
    music = known_folder('My Music') or os.path.join(home, 'Music')

    add('桌面', desktop, 'desktop')
    add('图片', pictures, 'image')
    add('下载', downloads, 'download')
    add('文档', documents, 'doc')
    add('视频', videos, 'video')
    add('音乐', music, 'audio')

    # 聊天软件接收的文件（存在才显示）
    for name, rel in (
        ('微信文件', os.path.join(documents, 'xwechat_files')),
        ('微信文件', os.path.join(documents, 'WeChat Files')),
        ('QQ 文件', os.path.join(documents, 'Tencent Files')),
    ):
        add(name, rel, 'chat')

    drives = []
    for letter in 'CDEFGHIJKLMNOPQRSTUVWXYZ':
        root = f'{letter}:\\'
        if not os.path.exists(root):
            continue
        label = volume_label(root)
        name = f'{letter} 盘' + (f' · {label}' if label else '')
        item = {
            'name': name, 'path': root, 'icon': 'drive', 'kind': 'drive',
            'letter': letter,
        }
        try:
            usage = shutil.disk_usage(root)
            item['total'] = usage.total
            item['free'] = usage.free
        except Exception:
            pass
        drives.append(item)

    return {'locations': locs, 'drives': drives}


# ----------------------------------------------------------------------------
# 搜索
# ----------------------------------------------------------------------------
def search_files(base, query, limit=300, max_depth=7, timeout=12.0):
    q = (query or '').strip().lower()
    if not q or not os.path.isdir(base):
        return []
    results = []
    started = time.time()
    base_depth = base.rstrip(os.sep).count(os.sep)
    for root, dirs, files in os.walk(base, topdown=True):
        if time.time() - started > timeout or len(results) >= limit:
            break
        depth = root.rstrip(os.sep).count(os.sep) - base_depth
        dirs[:] = [
            d for d in dirs
            if d.lower() not in SKIP_DIRS
            and d.lower() not in ('node_modules', '.git', 'appdata', 'windows', 'program files',
                                  'program files (x86)', 'programdata')
        ]
        if depth >= max_depth:
            dirs[:] = []
        for name in dirs:
            if q in name.lower():
                full = os.path.join(root, name)
                try:
                    mtime = int(os.stat(full).st_mtime)
                except OSError:
                    mtime = 0
                results.append({
                    'name': name, 'path': full, 'type': 'dir', 'size': 0,
                    'mtime': mtime, 'ext': '', 'rel': os.path.relpath(full, base),
                })
                if len(results) >= limit:
                    break
        if len(results) >= limit:
            break
        for name in files:
            if q not in name.lower():
                continue
            full = os.path.join(root, name)
            try:
                st = os.stat(full)
            except OSError:
                continue
            results.append({
                'name': name, 'path': full, 'type': kind_of(name),
                'size': st.st_size, 'mtime': int(st.st_mtime), 'ext': extension_of(name),
                'rel': os.path.relpath(full, base),
            })
            if len(results) >= limit:
                break
    return results


# ----------------------------------------------------------------------------
# 图标（用 Pillow 画一个 App 图标）
# ----------------------------------------------------------------------------
_icon_cache = {}


def make_icon(size):
    if size in _icon_cache:
        return _icon_cache[size]
    if not HAS_PIL:
        return None
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    grad = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / max(1, size - 1)
        grad.putpixel((0, y), (
            int(37 + (124 - 37) * t),
            int(99 + (58 - 99) * t),
            int(235 + (237 - 235) * t),
        ))
    grad = grad.resize((size, size), Image.BILINEAR)
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=int(size * 0.23), fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)

    # 白色相片卡片
    m = size * 0.17
    top = size * 0.27
    card = [m, top, size - m, size - top + size * 0.06]
    d.rounded_rectangle(card, radius=int(size * 0.07), fill=(255, 255, 255, 255))
    # 太阳
    d.ellipse([card[0] + size * 0.10, card[1] + size * 0.11,
               card[0] + size * 0.20, card[1] + size * 0.21], fill=(96, 165, 250, 255))
    # 山
    d.polygon([(card[0] + size * 0.08, card[3] - size * 0.06),
               (card[0] + size * 0.30, card[1] + size * 0.24),
               (card[0] + size * 0.50, card[3] - size * 0.06)], fill=(59, 130, 246, 255))
    d.polygon([(card[0] + size * 0.32, card[3] - size * 0.06),
               (card[0] + size * 0.52, card[1] + size * 0.32),
               (card[0] + size * 0.72, card[3] - size * 0.06)], fill=(37, 99, 235, 255))
    _icon_cache[size] = img
    return img


# ----------------------------------------------------------------------------
# 二维码
# ----------------------------------------------------------------------------
def qr_svg_bytes(text):
    if not HAS_QR:
        return None
    try:
        import qrcode.image.svg
        img = qrcode.make(text, image_factory=qrcode.image.svg.SvgPathImage,
                          box_size=10, border=2)
        buf = io.BytesIO()
        img.save(buf)
        return buf.getvalue()
    except Exception:
        return None


def print_qr_terminal(text):
    if not HAS_QR:
        return
    try:
        qr = qrcode.QRCode(border=1)
        qr.add_data(text)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
        print(flush=True)
    except Exception:
        pass


# ----------------------------------------------------------------------------
# 网络信息
# ----------------------------------------------------------------------------
def get_lan_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.3)
        try:
            s.connect(('8.8.8.8', 80))
            ips.append(s.getsockname()[0])
        finally:
            s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips:
                ips.append(ip)
    except Exception:
        pass
    cleaned = []
    for ip in ips:
        if ip.startswith('127.') or ip.startswith('169.254.') or ip == '0.0.0.0':
            continue
        if ip not in cleaned:
            cleaned.append(ip)

    def score(ip):
        if ip.startswith('192.168.'):
            return 0
        if ip.startswith('10.'):
            return 1
        if ip.startswith('172.'):
            return 2
        return 3

    return sorted(cleaned, key=score)


# ----------------------------------------------------------------------------
# HTTP 处理
# ----------------------------------------------------------------------------
class LanBrowserHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'LanFileBrowser/' + APP_VERSION
    sys_version = ''

    # ---------- 基础 ----------
    def log_message(self, fmt, *args):
        if VERBOSE:
            super().log_message(fmt, *args)

    def do_GET(self):
        try:
            self._dispatch()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            traceback.print_exc()
            try:
                self._send_json({'error': '服务器内部错误'}, 500)
            except Exception:
                pass

    def do_HEAD(self):
        self.do_GET()

    def _dispatch(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = parse_qs(parsed.query)

        if path in ('/', '/index.html'):
            return self._send_index()
        if path.startswith('/static/'):
            return self._send_static(path[len('/static/'):])
        if path == '/manifest.webmanifest':
            return self._send_manifest()
        if path in ('/favicon.ico', '/icon-192.png', '/icon-512.png', '/icon-180.png'):
            size = {'/icon-192.png': 192, '/icon-512.png': 512, '/icon-180.png': 180,
                    '/favicon.ico': 64}.get(path, 192)
            return self._send_icon(size)
        if path == '/qr.svg':
            return self._send_qr(qs)

        if path.startswith('/api/') or path in ('/thumb', '/view', '/raw', '/download'):
            if not self._check_auth(qs):
                return self._send_json({'error': '需要访问密码'}, 401)

        if path == '/api/serverinfo':
            return self._send_json(self._server_info())
        if path == '/api/locations':
            data = build_locations()
            data['server'] = self._server_info()
            return self._send_json(data)
        if path == '/api/list':
            return self._api_list(qs)
        if path == '/api/text':
            return self._api_text(qs)
        if path == '/api/info':
            return self._api_info(qs)
        if path == '/api/search':
            return self._api_search(qs)
        if path == '/thumb':
            return self._send_thumb(qs)
        if path == '/view':
            return self._send_view(qs)
        if path == '/raw':
            return self._send_raw(qs)
        if path == '/download':
            return self._send_download(qs)

        # SPA：其余路径返回首页（支持前端路由刷新）
        return self._send_index()

    # ---------- 输出 ----------
    def _send_bytes(self, body, ctype, status=200, cache='no-store', extra=None):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        self.send_header('X-Content-Type-Options', 'nosniff')
        if extra:
            for k, v in extra:
                self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        self._send_bytes(body, 'application/json; charset=utf-8', status)

    def _send_text(self, text, status=200, ctype='text/plain; charset=utf-8'):
        self._send_bytes(text.encode('utf-8'), ctype, status)

    def _send_index(self):
        try:
            with open(os.path.join(WEB_DIR, 'index.html'), 'rb') as f:
                body = f.read()
        except OSError:
            return self._send_text('找不到 web/index.html', 500)
        self._send_bytes(body, 'text/html; charset=utf-8', 200, cache='no-cache')

    def _send_static(self, rel):
        rel = rel.split('?')[0].lstrip('/')
        target = os.path.normpath(os.path.join(WEB_DIR, rel))
        if not target.startswith(WEB_DIR) or not os.path.isfile(target):
            return self._send_text('Not Found', 404)
        try:
            with open(target, 'rb') as f:
                body = f.read()
        except OSError:
            return self._send_text('Not Found', 404)
        ctype = guess_mime(target)
        self._send_bytes(body, ctype, 200, cache='no-cache')

    def _send_manifest(self):
        manifest = {
            'name': '局域网文件',
            'short_name': '局域网文件',
            'description': '浏览电脑上的照片、文本和文件',
            'start_url': '/',
            'scope': '/',
            'display': 'standalone',
            'orientation': 'any',
            'background_color': '#0b1220',
            'theme_color': '#0b1220',
            'icons': [
                {'src': '/icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
                {'src': '/icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
                {'src': '/icon-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
            ],
        }
        body = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
        self._send_bytes(body, 'application/manifest+json; charset=utf-8',
                         200, cache='public, max-age=600')

    def _send_icon(self, size):
        _ensure_dir(ICON_DIR)
        cache_file = os.path.join(ICON_DIR, f'icon-{size}.png')
        if os.path.exists(cache_file):
            try:
                with open(cache_file, 'rb') as f:
                    return self._send_bytes(f.read(), 'image/png', 200,
                                            cache='public, max-age=86400')
            except OSError:
                pass
        img = make_icon(size)
        if img is None:
            return self._send_text('No Pillow', 404)
        buf = io.BytesIO()
        img.save(buf, 'PNG')
        data = buf.getvalue()
        try:
            with open(cache_file, 'wb') as f:
                f.write(data)
        except OSError:
            pass
        self._send_bytes(data, 'image/png', 200, cache='public, max-age=86400')

    def _send_qr(self, qs):
        text = (qs.get('text') or [''])[0]
        if not text:
            host = self.headers.get('Host') or ''
            if host and not host.startswith('127.') and not host.startswith('localhost'):
                text = f'http://{host}/'
            else:
                info = self._server_info()
                text = info.get('lan_url') or f'http://127.0.0.1:{info.get("port", 8787)}/'
        data = qr_svg_bytes(text)
        if not data:
            return self._send_text('qrcode 未安装', 404)
        self._send_bytes(data, 'image/svg+xml; charset=utf-8', 200,
                         cache='no-cache')

    # ---------- 认证（可选 PIN） ----------
    def _check_auth(self, qs):
        pin = str(CONFIG.get('pin') or '').strip()
        if not pin:
            return True
        supplied = (qs.get('pin') or [''])[0]
        if not supplied:
            cookie = self.headers.get('Cookie') or ''
            m = re.search(r'(?:^|;\s*)lanpin=([^;]*)', cookie)
            if m:
                supplied = unquote(m.group(1))
        return supplied == pin

    # ---------- 文件流 ----------
    def _send_file_stream(self, path, as_attachment=False):
        try:
            st = os.stat(path)
        except OSError:
            return self._send_json({'error': '文件不存在'}, 404)
        size = st.st_size
        ctype = guess_mime(path)
        start, end = 0, size - 1
        status = 200
        range_header = self.headers.get('Range') or ''
        if range_header:
            m = re.match(r'bytes=(\d*)-(\d*)\s*$', range_header.strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    length = int(m.group(2))
                    start = max(0, size - length)
                    end = size - 1
                if start >= size or start > end:
                    self.send_response(416)
                    self.send_header('Content-Range', f'bytes */{size}')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                status = 206
        length = max(0, end - start + 1)

        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(length))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Cache-Control', 'private, max-age=600')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if status == 206:
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        filename = os.path.basename(path)
        if as_attachment:
            self.send_header(
                'Content-Disposition',
                "attachment; filename*=UTF-8''" + quote(filename, safe=''))
        else:
            self.send_header('Content-Disposition', 'inline')
        self.end_headers()
        if self.command == 'HEAD' or length == 0:
            return
        try:
            with open(path, 'rb') as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(262144, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    # ---------- API ----------
    def _server_info(self):
        host = self.headers.get('Host') or ''
        port = PUBLIC_PORT or PORT
        if PUBLIC_URL:
            lan_url = PUBLIC_URL if PUBLIC_URL.endswith('/') else PUBLIC_URL + '/'
        else:
            lan_url = f'http://{LAN_IP}:{port}/' if LAN_IP else f'http://127.0.0.1:{port}/'
        return {
            'version': APP_VERSION,
            'port': port,
            'hostname': socket.gethostname(),
            'ips': LAN_IPS,
            'lan_url': lan_url,
            'current_host': host,
            'has_pin': bool(str(CONFIG.get('pin') or '').strip()),
            'theme': 'dark',
            'ai_url': '/ai/',
            'ai_available': ai_available(port),
        }

    def _api_list(self, qs):
        raw = b64d((qs.get('p') or [''])[0])
        sort = (qs.get('sort') or ['name'])[0]
        order = (qs.get('order') or ['asc'])[0]
        path = safe_path(raw)
        if not path:
            data = build_locations()
            data['server'] = self._server_info()
            return self._send_json(data)
        if not os.path.isdir(path):
            return self._send_json({'error': '目录不存在或无法访问'}, 404)
        try:
            entries, truncated, total = list_directory(path, sort, order)
        except PermissionError:
            return self._send_json({'error': '没有权限访问这个文件夹'}, 403)
        except OSError as exc:
            return self._send_json({'error': f'无法读取目录：{exc}'}, 500)

        name = os.path.basename(path.rstrip('\\/')) or path
        parent = None if is_drive_root(path) else safe_path(os.path.dirname(path))
        self._send_json({
            'path': path,
            'name': name,
            'parent': parent,
            'is_drive_root': is_drive_root(path),
            'entries': entries,
            'truncated': truncated,
            'total': total,
        })

    def _api_text(self, qs):
        path = safe_path(b64d((qs.get('p') or [''])[0]))
        if not path or not os.path.isfile(path):
            return self._send_json({'error': '文件不存在'}, 404)
        try:
            max_bytes = int((qs.get('max') or ['4194304'])[0])
        except ValueError:
            max_bytes = 4194304
        max_bytes = max(4096, min(max_bytes, 16 * 1024 * 1024))
        try:
            with open(path, 'rb') as f:
                data = f.read(max_bytes + 1)
        except PermissionError:
            return self._send_json({'error': '没有权限读取这个文件'}, 403)
        except OSError as exc:
            return self._send_json({'error': f'读取失败：{exc}'}, 500)
        truncated = len(data) > max_bytes
        if truncated:
            data = data[:max_bytes]
        if looks_binary(data):
            return self._send_json({'error': '这是二进制文件，无法以文本方式打开', 'binary': True}, 415)
        text, encoding = decode_text_bytes(data)
        text = text.replace('\r\n', '\n').replace('\r', '\n')
        self._send_json({
            'content': text,
            'encoding': encoding,
            'truncated': truncated,
            'size': os.path.getsize(path),
            'name': os.path.basename(path),
        })

    def _api_info(self, qs):
        path = safe_path(b64d((qs.get('p') or [''])[0]))
        if not path or not os.path.exists(path):
            return self._send_json({'error': '文件不存在'}, 404)
        try:
            st = os.stat(path)
        except OSError as exc:
            return self._send_json({'error': str(exc)}, 500)
        kind = kind_of(os.path.basename(path), os.path.isdir(path))
        info = {
            'name': os.path.basename(path),
            'path': path,
            'type': kind,
            'size': st.st_size,
            'mtime': int(st.st_mtime),
            'is_dir': os.path.isdir(path),
        }
        if kind == 'image':
            info.update(image_info(path))
        self._send_json(info)

    def _api_search(self, qs):
        path = safe_path(b64d((qs.get('p') or [''])[0]))
        query = (qs.get('q') or [''])[0]
        if not path or not os.path.isdir(path):
            return self._send_json({'error': '目录不存在'}, 404)
        if not query.strip():
            return self._send_json({'results': [], 'query': ''})
        try:
            results = search_files(path, query)
        except Exception as exc:
            return self._send_json({'error': f'搜索失败：{exc}'}, 500)
        self._send_json({'results': results, 'query': query, 'count': len(results)})

    def _send_thumb(self, qs):
        path = safe_path(b64d((qs.get('p') or [''])[0]))
        try:
            size = int((qs.get('s') or ['400'])[0])
        except ValueError:
            size = 400
        size = max(64, min(size, 1024))
        if not path or not os.path.isfile(path):
            return self._send_json({'error': '文件不存在'}, 404)
        if extension_of(path) not in IMAGE_EXT or extension_of(path) == 'svg':
            return self._send_json({'error': '不是图片'}, 415)
        out = make_thumbnail(path, size)
        if not out:
            return self._send_json({'error': '缩略图生成失败'}, 500)
        try:
            with open(out, 'rb') as f:
                data = f.read()
        except OSError:
            return self._send_json({'error': '缩略图读取失败'}, 500)
        self._send_bytes(data, 'image/jpeg', 200,
                         cache='public, max-age=31536000, immutable')

    def _send_view(self, qs):
        path = safe_path(b64d((qs.get('p') or [''])[0]))
        try:
            max_side = int((qs.get('w') or ['1800'])[0])
        except ValueError:
            max_side = 1800
        max_side = max(400, min(max_side, 4096))
        if not path or not os.path.isfile(path):
            return self._send_json({'error': '文件不存在'}, 404)
        ext = extension_of(path)
        if ext not in IMAGE_EXT:
            return self._send_json({'error': '不是图片'}, 415)

        # 动图 / SVG 直接发原文件，保留动画与矢量
        if ext == 'svg' or ext == 'gif':
            return self._send_file_stream(path)

        try:
            file_size = os.path.getsize(path)
            width = height = 0
            if HAS_PIL:
                try:
                    with Image.open(path) as im:
                        width, height = im.size
                except Exception:
                    pass
            # 小图直接发原图，保留文字清晰度
            if file_size <= 1.5 * 1024 * 1024 and width and max(width, height) <= max_side:
                return self._send_file_stream(path)
        except OSError:
            pass

        out = make_preview(path, max_side)
        if not out:
            return self._send_file_stream(path)
        try:
            with open(out, 'rb') as f:
                data = f.read()
        except OSError:
            return self._send_stack_fallback(path)
        self._send_bytes(data, 'image/jpeg', 200,
                         cache='private, max-age=604800')

    def _send_stack_fallback(self, path):
        try:
            return self._send_file_stream(path)
        except Exception:
            return self._send_json({'error': '图片读取失败'}, 500)

    def _send_raw(self, qs):
        path = safe_path(b64d((qs.get('p') or [''])[0]))
        if not path or not os.path.isfile(path):
            return self._send_json({'error': '文件不存在'}, 404)
        self._send_file_stream(path)

    def _send_download(self, qs):
        path = safe_path(b64d((qs.get('p') or [''])[0]))
        if not path or not os.path.isfile(path):
            return self._send_json({'error': '文件不存在'}, 404)
        self._send_file_stream(path, as_attachment=True)


# ----------------------------------------------------------------------------
# 启动
# ----------------------------------------------------------------------------
CONFIG = {}
PORT = 8787
PUBLIC_PORT = 0
PUBLIC_URL = ''
LAN_IP = ''
LAN_IPS = []
SERVER_NAME = ''


def ai_available(public_port):
    """探测统一入口（Node 代理）是否在线。"""
    if not public_port:
        return False
    try:
        with urllib.request.urlopen(
                f'http://127.0.0.1:{public_port}/__proxy/health', timeout=0.6) as resp:
            return resp.status == 200
    except Exception:
        return False


def watch_parent(parent_pid):
    """父进程（Node 统一入口）退出后，自己也退出，避免残留。"""
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        SYNCHRONIZE = 0x00100000
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, parent_pid)
        if not handle:
            # 拿不到句柄就不监控，靠用户关闭窗口
            return
        while True:
            if kernel32.WaitForSingleObject(handle, 2000) == 0:
                os._exit(0)
    except Exception:
        pass


def parse_args():
    parser = argparse.ArgumentParser(description='局域网文件浏览器')
    parser.add_argument('--port', type=int, default=None, help='端口，默认 8787')
    parser.add_argument('--bind', default=None, help='监听地址，默认 0.0.0.0（局域网可访问）')
    parser.add_argument('--no-browser', action='store_true', help='不自动打开浏览器')
    parser.add_argument('--no-qr', action='store_true', help='不在终端打印二维码')
    parser.add_argument('--no-banner', action='store_true', help='不打印启动横幅（作为内部服务运行时用）')
    parser.add_argument('--public-port', type=int, default=0, help='对外统一入口端口（二维码/链接里显示）')
    parser.add_argument('--public-url', default='', help='对外完整 URL（二维码/链接里显示，优先于 public-port）')
    parser.add_argument('--parent-pid', type=int, default=0, help='父进程 PID，父进程退出时本服务自动退出')
    parser.add_argument('--clear-cache', action='store_true', help='启动前清空缩略图缓存')
    parser.add_argument('--verbose', action='store_true', help='打印每个请求日志')
    return parser.parse_args()


def print_banner(port):
    line = '=' * 62
    print()
    print(line)
    print(f'  局域网文件浏览器  LanFileBrowser v{APP_VERSION}')
    print(line)
    print(f'  电脑本机访问：  http://127.0.0.1:{port}/')
    if LAN_IPS:
        for idx, ip in enumerate(LAN_IPS):
            tip = '  ← 手机用这个' if idx == 0 else ''
            print(f'  手机访问地址：  http://{ip}:{port}/{tip}')
    else:
        print('  手机访问地址：  （未检测到局域网 IP，请检查网络连接）')
    print()
    print('  · 手机要和电脑连同一个路由器 / Wi-Fi')
    print('  · 手机浏览器打开上面的地址，或扫下方二维码')
    print('  · 可「添加到主屏幕」，用起来就像 App')
    print('  · 服务只读，不会修改电脑上的文件')
    print('  · 关闭这个窗口或按 Ctrl+C 即停止服务')
    print(line)
    print()


def main():
    global CONFIG, PORT, PUBLIC_PORT, PUBLIC_URL, LAN_IP, LAN_IPS, SERVER_NAME, VERBOSE

    args = parse_args()
    VERBOSE = args.verbose

    for d in (WEB_DIR, DATA_DIR, THUMB_DIR, VIEW_DIR, ICON_DIR):
        _ensure_dir(d)

    CONFIG = load_config()
    port = args.port or int(CONFIG.get('port') or 8787)
    bind = args.bind or CONFIG.get('bind') or '0.0.0.0'

    if args.clear_cache:
        for base in (THUMB_DIR, VIEW_DIR):
            try:
                shutil.rmtree(base, ignore_errors=True)
            except Exception:
                pass
        log('已清空缩略图缓存')

    threading.Thread(target=cleanup_cache, daemon=True).start()

    # 尝试绑定端口（被占用时自动 +1）
    httpd = None
    last_error = None
    for offset in range(10):
        candidate = port + offset
        try:
            httpd = ThreadingHTTPServer((bind, candidate), LanBrowserHandler)
            port = candidate
            break
        except OSError as exc:
            last_error = exc
            continue
    if httpd is None:
        print(f'无法监听端口 {port}：{last_error}')
        print('请用 --port 指定其它端口，或关闭占用该端口的程序。')
        return 1

    httpd.daemon_threads = True
    PORT = port
    PUBLIC_PORT = args.public_port or port
    PUBLIC_URL = args.public_url or ''
    LAN_IPS = get_lan_ips()
    LAN_IP = LAN_IPS[0] if LAN_IPS else ''
    SERVER_NAME = socket.gethostname()

    if args.parent_pid:
        threading.Thread(target=watch_parent, args=(args.parent_pid,), daemon=True).start()

    if not args.no_banner:
        if not HAS_PIL:
            print('提示：未安装 Pillow，图片将没有缩略图（pip install Pillow 可解决）')
        if not HAS_QR:
            print('提示：未安装 qrcode，启动时不显示二维码（pip install qrcode 可解决）')

        print_banner(PUBLIC_PORT)

        if not args.no_qr and LAN_IP:
            print('  手机扫这个二维码直接打开：')
            print_qr_terminal(f'http://{LAN_IP}:{PUBLIC_PORT}/')

    if CONFIG.get('open_browser') and not args.no_browser and not args.no_banner:
        def open_later():
            time.sleep(0.8)
            try:
                webbrowser.open(f'http://127.0.0.1:{port}/')
            except Exception:
                pass
        threading.Thread(target=open_later, daemon=True).start()

    log(f'服务已启动，监听 {bind}:{port}，按 Ctrl+C 停止')
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n正在停止服务…')
    finally:
        httpd.server_close()
    return 0


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass
    sys.exit(main())
