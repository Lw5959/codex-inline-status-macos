PYTHON ?= python3

.PHONY: build test test-js test-python dmg benchmark verify

build:
	$(PYTHON) scripts/build_macos_app.py

test: test-js test-python

test-js:
	npm test

test-python:
	PYTHONPATH=src:TokenPulse/src $(PYTHON) -m unittest discover -s tests -p 'test_*.py'

dmg:
	$(PYTHON) scripts/build_macos_dmg.py

benchmark:
	npm run benchmark

# 原生测试依赖已经完成的构建，顺序执行以避免删建与运行 App 发生竞争。
verify:
	$(MAKE) build
	$(MAKE) test
	$(MAKE) dmg
