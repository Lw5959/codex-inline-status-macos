# Third-party source notices

This repository contains source for the local Codex inline status tool. It is not
an official OpenAI plugin and does not redistribute the official desktop App.

The project's new code is provided under the root MIT license. Third-party code
retains its original copyright and license notices:

| Component | Version or source snapshot | License notice |
| --- | --- | --- |
| TokenPulse Python source | [edc27b1ab28709e6906667ef50decf12c7002e35](https://github.com/zzccchen/token-pulse/tree/edc27b1ab28709e6906667ef50decf12c7002e35) | [TokenPulse/LICENSE](TokenPulse/LICENSE) and [THIRD_PARTY.md](TokenPulse/THIRD_PARTY.md) |
| js-tiktoken | 1.0.21 | [JS-TIKTOKEN-LICENSE.txt](src/JS-TIKTOKEN-LICENSE.txt) |
| base64-js | 1.5.1 | [BASE64-JS-LICENSE.txt](src/BASE64-JS-LICENSE.txt) |
| DeepSeek Harness reference | MIT notice retained with this distribution | [DSH-MIT-LICENSE.txt](src/DSH-MIT-LICENSE.txt) |

`src/visible_tokenizer.mjs` bundles js-tiktoken, the o200k_base vocabulary, and
base64-js. The dependency lock file is preserved under `tests/native-statusbar-deps/`.

The included `TokenPulse/src/` snapshot supplies the local log-reading code used
by the cache backend. Its upstream README and notices describe additional GUI
and portable distributions; those are not shipped here. This repository includes
no Qt/PySide binaries, Python runtime, or upstream portable executable. Normal
installation creates a local Python environment and uses the included source;
it does not install the TokenPulse GUI dependencies.
