LOCAL AI STUDIO
===============

This is a static Chrome app. It uses Llama 3.2 3B Instruct through a locally
bundled WebLLM runtime and the model files in:

  Llama-3.2-3B-Instruct-q4f16_1-MLC/

The app does not call a cloud AI service and has no internet-hosted JavaScript
imports or online-model fallback. It does not require Python, Linux, or SSH.

USING IT OFFLINE ON A CHROMEBOOK
--------------------------------

Chrome requires a secure web address for WebGPU and offline app installation.
Do not open index.html directly from the Chromebook Files app: file:// pages
cannot access the model files or install the offline app shell correctly.

1. Open this app's HTTPS address in Chrome while connected to the internet.
2. Install the app from Chrome's menu if Chrome offers the install option.
3. Select "Load local model" and wait for the Ready message. The first load
   needs about 3.4 GiB of model files and can take several minutes.
4. Send a test prompt, turn off Wi-Fi, reopen the installed app, and test again
   before relying on it during an outage.

The service worker keeps the app interface available. WebLLM stores the model
artifacts in this Chrome profile's browser cache. Chats and colors use browser
storage; training notes use IndexedDB. Do not clear Chrome site data or use a
different Chrome profile if you want to keep the offline copy.

The model needs WebGPU and roughly 2.3 GiB of GPU memory, plus additional
working memory for Chrome and the operating system. Some Chromebooks will not
have enough graphics memory, general memory, storage, or WebGPU support.
The app checks WebGPU and several local model files before loading, but actual
performance depends on the Chromebook.

AI TRAINING
-----------

"AI training" saves your subject notes locally and asks the model to explain
what it understood. The original notes and explanation are then supplied as
context to future relevant questions. This is in-context learning; it does not
fine-tune or change the model's weights. Review the explanation against your
notes and use "Mark explanation checked" to record that you reviewed it.

COLOR AND DATA STORAGE
----------------------

Background and button colors are saved in this browser. Conversation history
is saved in local storage. Training subjects and explanations are saved in
IndexedDB on the same app address and Chrome profile.

FILES
-----

- index.html, style.css, script.js: app interface and behavior
- vendor/webllm/web-llm.js: locally bundled WebLLM browser runtime
- vendor/webllm/Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm: model runtime
- Llama-3.2-3B-Instruct-q4f16_1-MLC/: model configuration, tokenizer, and weights
- app.webmanifest, service-worker.js, app-icon-*.png: Chrome offline app shell
