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
base64-js. Development dependencies and their lock file are at the repository root.

The included `TokenPulse/src/` snapshot supplies the local log-reading code used
by the cache backend. Its upstream README and notices describe additional GUI
and portable distributions; those are not shipped here. This repository includes
no Qt/PySide binaries, Python runtime, or upstream portable executable. The native
macOS release uses only system frameworks. Historical Python/Node launchers are
archived under `macos/legacy/`; Windows entry points remain compatible with the
upstream source layout and do not install the TokenPulse GUI dependencies.

The macOS adaptation is based on `wenalang05-arch/codex-inline-status` v1.3.5,
commit `95128d00c968deacd086928f0b9da32ec09ced00`. Upstream history and MIT notices
are retained. The official OpenAI desktop application is not redistributed.
