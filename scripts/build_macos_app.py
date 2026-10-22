#!/usr/bin/env python3
"""构建纯原生 App。Python 只用于开发期打包，不进入产物，也不用于运行。"""
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
VERSION = '2.1.4'


def meter_bundle():
    tokenizer = (ROOT / 'src/visible_tokenizer.mjs').read_text()
    tokenizer = re.sub(r'export\s*\{[^}]*\};\s*$', '', tokenizer)
    meter = (ROOT / 'src/visible_stream_meter.mjs').read_text()
    meter = re.sub(r'(?m)^export (?=(?:const|function|class)\b)', '', meter)
    # JavaScriptCore 不提供 Web TextEncoder，按 Unicode 标量编码并替换悬空 surrogate。
    polyfill = r'''
globalThis.TextEncoder = class {
  encode(text = '') {
    const output = [];
    for (const char of String(text)) {
      let n = char.codePointAt(0);
      if (n >= 0xd800 && n <= 0xdfff) n = 0xfffd;
      if (n < 128) output.push(n);
      else if (n < 2048) output.push(192 | n >> 6, 128 | n & 63);
      else if (n < 65536) output.push(224 | n >> 12, 128 | n >> 6 & 63, 128 | n & 63);
      else output.push(240 | n >> 18, 128 | n >> 12 & 63, 128 | n >> 6 & 63, 128 | n & 63);
    }
    return Uint8Array.from(output);
  }
};
globalThis.TextDecoder = class { decode(bytes) { return __nativeDecodeUTF8(Array.from(bytes || [])); } };
'''
    bridge = r'''
const __nativeMeters = new Map();
function __updateMeter(session, thread, snapshot) {
  if (typeof snapshot === 'string') snapshot = JSON.parse(snapshot);
  if (!__nativeMeters.has(session)) {
    while (__nativeMeters.size >= 32) __nativeMeters.delete(__nativeMeters.keys().next().value);
    __nativeMeters.set(session, new __METER__.VisibleStreamMeter(__TOKENIZER__));
  }
  const result = __nativeMeters.get(session).update(thread, snapshot);
  return {...result, nativeObserverId:snapshot.observerId};
}
function __removeMeter(session) { __nativeMeters.delete(session); }
function __nativeTest(request) {
  if (request.action === 'raw') return __nativeTest(JSON.parse(request.requestJSON));
  if (request.action === 'encode') return __TOKENIZER__.encode(request.text);
  if (request.action === 'count') return __METER__.countVisibleTokens(request.text,request.firstText,__TOKENIZER__);
  if (request.action === 'sequence') return request.events.map(x=>__updateMeter(x.session,x.thread,x.snapshot));
  throw new Error('Unknown test');
}
'''
    return (polyfill + '\nconst __TOKENIZER__ = (()=>{\n' + tokenizer + '\nreturn {encode,tokenByteLength};})();\n'
            + 'const __METER__ = (()=>{\n' + meter + '\nreturn {VisibleStreamMeter,countVisibleTokens};})();\n' + bridge)


def main():
    app = ROOT / 'release/GPT Launcher.app'
    if app.exists():
        shutil.rmtree(app)
    resources = app / 'Contents/Resources'
    engine = resources / 'engine'
    (app / 'Contents/MacOS').mkdir(parents=True)
    engine.mkdir(parents=True)
    for name in ['native_statusbar.js', 'visible_stream_observer.js', 'JS-TIKTOKEN-LICENSE.txt', 'BASE64-JS-LICENSE.txt', 'DSH-MIT-LICENSE.txt']:
        shutil.copy2(ROOT / 'src' / name, engine / name)
    shutil.copy2(ROOT / 'LICENSE', engine / 'LICENSE.txt')
    shutil.copy2(ROOT / 'TokenPulse/LICENSE', engine / 'TokenPulse-LICENSE.txt')
    (engine / 'native_meter.js').write_text(meter_bundle())
    native_files = sorted((ROOT / 'macos/native').glob('*.swift'))
    digest = hashlib.sha256()
    for path in native_files + [ROOT / 'macos/AppMain.swift'] + sorted(engine.iterdir()):
        digest.update(path.name.encode()); digest.update(path.read_bytes())
    payload = {'version': VERSION + '-' + digest.hexdigest()[:16], 'runtime': 'macOS-system-frameworks-only', 'regionPolicy': 'US-only-fail-closed'}
    (resources / 'payload.json').write_text(json.dumps(payload, indent=2))
    (app / 'Contents/Info.plist').write_bytes(plistlib.dumps({
        'CFBundleName': 'GPT Launcher', 'CFBundleDisplayName': 'GPT 启动助手', 'CFBundleExecutable': 'GPTLauncher',
        'CFBundleIdentifier': 'local.codex-inline-status.assistant', 'CFBundleVersion': VERSION, 'CFBundleShortVersionString': VERSION,
        'CFBundlePackageType': 'APPL', 'LSMinimumSystemVersion': '14.0', 'LSUIElement': True,
        'NSHighResolutionCapable': True, 'CFBundleIconFile': 'AppIcon.icns',
    }))
    build = ROOT / 'build/native-build'
    build.mkdir(parents=True, exist_ok=True)
    # 多文件 Swift 可执行程序的顶层入口必须名为 main.swift。
    main_file = build / 'main.swift'
    shutil.copy2(ROOT / 'macos/AppMain.swift', main_file)
    subprocess.run(['/usr/bin/xcrun', 'swiftc', '-O', '-swift-version', '5', '-target', 'arm64-apple-macosx14.0',
                    *map(str, native_files), str(main_file), '-o', str(app / 'Contents/MacOS/GPTLauncher'),
                    '-framework', 'AppKit', '-framework', 'JavaScriptCore', '-framework', 'SystemConfiguration', '-lsqlite3'], check=True)
    icon_tool = ROOT / 'build/MakeIcon'
    subprocess.run(['/usr/bin/xcrun', 'swiftc', str(ROOT / 'macos/tools/MakeIcon.swift'), '-o', str(icon_tool), '-framework', 'AppKit'], check=True)
    iconset = ROOT / 'build/GPTLauncher.iconset'
    subprocess.run([str(icon_tool), str(iconset)], check=True)
    subprocess.run(['/usr/bin/iconutil', '-c', 'icns', str(iconset), '-o', str(resources / 'AppIcon.icns')], check=True)
    subprocess.run(['/usr/bin/codesign', '--force', '--deep', '--sign', '-', str(app)], check=True)
    subprocess.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    # 同时按名称、后缀及二进制依赖核对，不把旧运行时或开发机路径带入发布包。
    assert not any(p.name.lower() in {'node', 'python', 'python3'} or p.suffix in {'.py', '.pyc', '.dylib'} for p in app.rglob('*'))
    links = subprocess.check_output(['/usr/bin/otool', '-L', str(app / 'Contents/MacOS/GPTLauncher')], text=True)
    assert '/opt/homebrew/' not in links and '/.nvm/' not in links
    output = ROOT / 'outputs/GPT Launcher.app'
    if output.exists(): shutil.rmtree(output)
    shutil.copytree(app, output)
    package = ROOT / ('outputs/GPT-Launcher-' + VERSION + '-macos-arm64.zip')
    if package.exists(): package.unlink()
    subprocess.run(['/usr/bin/ditto', '-c', '-k', '--sequesterRsrc', '--keepParent', str(app), str(package)], check=True)
    print(json.dumps({'app': str(output), 'zip': str(package), 'zipSha256': hashlib.sha256(package.read_bytes()).hexdigest(), 'payload': payload}, indent=2))


if __name__ == '__main__':
    main()
