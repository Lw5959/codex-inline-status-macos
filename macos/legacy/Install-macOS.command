#!/bin/zsh
# Finder 的 PATH 可能不含 Homebrew；优先选择用户已安装的 Python。
cd -- "${0:A:h}/../.." || exit 1
for task_python in /opt/homebrew/bin/python3 /usr/local/bin/python3 "${commands[python3]}"; do
  if [[ -x "$task_python" ]] && "$task_python" -c 'import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)' 2>/dev/null; then
    "$task_python" macos/legacy/manage.py install "$@"
    exit $?
  fi
done
print -u2 '需要 Python 3.11 或更高版本，请安装后重试。'
exit 1
