#!/bin/zsh
# 固定私有环境路径，双击启动不依赖终端的 nvm 配置。
task_root="$HOME/Library/Application Support/CodexInlineStatus"
task_native="$task_root/native/GPTLauncher"
if [[ -x "$task_native" ]]; then
  exec "$task_native" --service launch --root "$task_root"
fi
task_python="$task_root/TokenPulse/.venv/bin/python3"
if [[ ! -x "$task_python" ]]; then
  print -u2 '尚未安装，请先双击 Install-macOS.command。'
  exit 1
fi
exec "$task_python" "$task_root/macos/manage.py" launch "$@"
