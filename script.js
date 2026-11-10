const MODEL_ID = "Llama-3.2-3B-Instruct-q4f16_1-MLC";
const MODEL_URL = new URL("./Llama-3.2-3B-Instruct-q4f16_1-MLC/", document.baseURI).href;
const MODEL_LIBRARY_URL = new URL(
  "./vendor/webllm/Llama-3.2-3B-Instruct-q4f16_1_cs1k-webgpu.wasm",
  document.baseURI
).href;
const MODEL_CONFIG = {
  cacheBackend: "cache",
  model_list: [{
    model: MODEL_URL,
    model_id: MODEL_ID,
    model_lib: MODEL_LIBRARY_URL,
    vram_required_MB: 2264,
    low_resource_required: true,
    overrides: { context_window_size: 4096 }
  }]
};

const CHAT_STORAGE_KEY = "local-ai-chats-v2";
const THEME_STORAGE_KEY = "local-ai-theme-v1";
const TRAINING_DB_NAME = "local-ai-studio";
const TRAINING_STORE_NAME = "training-topics";
const MAX_NOTE_LENGTH = 50000;
const TRAINING_CHUNK_LENGTH = 6000;
const DEFAULT_THEME = { background: "#f1f3f6", button: "#365d91" };
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "among", "and", "are", "because", "been",
  "before", "being", "between", "both", "could", "does", "doing", "from",
  "have", "into", "just", "more", "most", "only", "other", "over", "same",
  "some", "such", "than", "that", "their", "them", "there", "these", "they",
  "this", "those", "through", "under", "very", "what", "when", "where",
  "which", "while", "with", "would", "your", "you", "the", "for", "not",
  "use", "how", "why", "can", "will", "make", "does", "explain", "tell"
]);

let engine = null;
let chats = readLocalJSON(CHAT_STORAGE_KEY, readLocalJSON("ai_chat_history", []));
let currentChatId = null;
let trainingTopics = [];
let trainingDbPromise = null;
let activeTrainingId = null;
let isGenerating = false;
let toastTimer = 0;
let lastFocusedElement = null;

document.addEventListener("DOMContentLoaded", initializeApp);

async function initializeApp() {
  bindControls();
  applySavedTheme();
  if (!Array.isArray(chats)) chats = [];
  chats = chats.filter((chat) => chat && typeof chat.id === "string" && Array.isArray(chat.messages));
  renderHistoryList();

  if (chats.length === 0) createNewChat();
  else selectChat(chats[0].id);

  updateConversationCount();
  updateEngineControls(false);
  updateNetworkMessage();
  updateNotesCharacterCount();
  await initializeTrainingStore();
  checkWebGPUAvailability();
  registerOfflineShell();
}

function bindControls() {
  document.getElementById("newChatBtn").addEventListener("click", createNewChat);
  document.getElementById("loadBtn").addEventListener("click", initializeEngine);
  document.getElementById("composerForm").addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage();
  });
  document.getElementById("userInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  document.getElementById("userInput").addEventListener("input", resizeComposer);

  document.getElementById("trainingBtn").addEventListener("click", () => {
    renderTrainingTopics();
    openModal("trainingModal");
    document.getElementById("trainingTitleInput").focus();
  });
  document.getElementById("closeTrainingModal").addEventListener("click", () => closeModal("trainingModal"));
  document.getElementById("trainingForm").addEventListener("submit", trainOnSubject);
  document.getElementById("trainingNotesInput").addEventListener("input", updateNotesCharacterCount);
  document.getElementById("reviewSummaryBtn").addEventListener("click", markCurrentSummaryReviewed);

  document.getElementById("appearanceBtn").addEventListener("click", () => openModal("appearanceModal"));
  document.getElementById("closeAppearanceModal").addEventListener("click", () => closeModal("appearanceModal"));
  document.getElementById("backgroundColor").addEventListener("input", updateThemeFromControls);
  document.getElementById("buttonColor").addEventListener("input", updateThemeFromControls);
  document.getElementById("resetColorsBtn").addEventListener("click", resetTheme);

  document.getElementById("offlineGuideBtn").addEventListener("click", () => openModal("offlineModal"));
  document.getElementById("closeOfflineModal").addEventListener("click", () => closeModal("offlineModal"));
  document.getElementById("closeOfflineGuide").addEventListener("click", () => closeModal("offlineModal"));

  document.querySelectorAll(".modal-overlay").forEach((modal) => {
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal.id);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      const visibleModal = [...document.querySelectorAll(".modal-overlay")].find((modal) => !modal.hidden);
      if (visibleModal) closeModal(visibleModal.id);
      closeSidebar();
    }
  });

  const sidebarToggle = document.getElementById("sidebarToggle");
  sidebarToggle.addEventListener("click", () => {
    const isOpen = document.body.classList.toggle("sidebar-open");
    sidebarToggle.setAttribute("aria-expanded", String(isOpen));
    sidebarToggle.setAttribute("aria-label", isOpen ? "Close conversation list" : "Open conversation list");
  });
  document.addEventListener("click", (event) => {
    if (
      document.body.classList.contains("sidebar-open") &&
      !event.target.closest("#sidebar") &&
      !event.target.closest("#sidebarToggle")
    ) closeSidebar();
  });

  window.addEventListener("online", updateNetworkMessage);
  window.addEventListener("offline", updateNetworkMessage);
}

function readLocalJSON(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch (error) {
    console.warn(`Could not read saved browser data for ${key}.`, error);
    return fallback;
  }
}

function writeLocalJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (error) {
    console.error(`Could not save browser data for ${key}.`, error);
    showToast("Chrome could not save this data. Check available storage and browser permissions.");
    return false;
  }
}

function setStatus(message, state = "ready", progressValue = null) {
  const status = document.querySelector(".engine-status");
  const progress = document.getElementById("progress");
  document.getElementById("status-text").textContent = message;
  status.classList.remove("is-loading", "is-error", "is-ready");
  status.classList.add(`is-${state}`);
  if (progressValue === null) {
    progress.hidden = true;
  } else {
    progress.hidden = false;
    progress.value = Math.max(0, Math.min(100, progressValue));
  }
}

function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 4200);
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
  const toggle = document.getElementById("sidebarToggle");
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Open conversation list");
}

function openModal(id) {
  const modal = document.getElementById(id);
  lastFocusedElement = document.activeElement;
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
  if (![...document.querySelectorAll(".modal-overlay")].some((item) => !item.hidden)) {
    document.body.classList.remove("modal-open");
  }
  if (lastFocusedElement && typeof lastFocusedElement.focus === "function") lastFocusedElement.focus();
}

function applySavedTheme() {
  const storedTheme = readLocalJSON(THEME_STORAGE_KEY, DEFAULT_THEME);
  const theme = {
    background: isHexColor(storedTheme?.background) ? storedTheme.background : DEFAULT_THEME.background,
    button: isHexColor(storedTheme?.button) ? storedTheme.button : DEFAULT_THEME.button
  };
  document.getElementById("backgroundColor").value = theme.background;
  document.getElementById("buttonColor").value = theme.button;
  applyTheme(theme);
}

function updateThemeFromControls() {
  const theme = {
    background: document.getElementById("backgroundColor").value,
    button: document.getElementById("buttonColor").value
  };
  applyTheme(theme);
  writeLocalJSON(THEME_STORAGE_KEY, theme);
}

function applyTheme(theme) {
  const backgroundIsLight = colorLuminance(theme.background) > 0.46;
  const textColor = backgroundIsLight ? "#1e2938" : "#f0f3f7";
  const panelColor = mixHex(theme.background, backgroundIsLight ? "#ffffff" : "#000000", 0.055);
  const raisedColor = mixHex(theme.background, backgroundIsLight ? "#ffffff" : "#000000", 0.12);
  const borderColor = mixHex(theme.background, textColor, 0.14);
  const accentText = colorLuminance(theme.button) > 0.52 ? "#152131" : "#ffffff";
  const root = document.documentElement;
  root.style.setProperty("--app-bg", theme.background);
  root.style.setProperty("--text-color", textColor);
  root.style.setProperty("--muted-color", mixHex(textColor, theme.background, 0.55));
  root.style.setProperty("--panel-color", panelColor);
  root.style.setProperty("--panel-raised", raisedColor);
  root.style.setProperty("--border-color", borderColor);
  root.style.setProperty("--accent-color", theme.button);
  root.style.setProperty("--accent-text", accentText);
  document.querySelector('meta[name="theme-color"]').content = theme.background;
}

function resetTheme() {
  applyTheme(DEFAULT_THEME);
  document.getElementById("backgroundColor").value = DEFAULT_THEME.background;
  document.getElementById("buttonColor").value = DEFAULT_THEME.button;
  writeLocalJSON(THEME_STORAGE_KEY, DEFAULT_THEME);
}

function isHexColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function colorLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  ));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function mixHex(first, second, amount) {
  const a = first.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16));
  const b = second.slice(1).match(/.{2}/g).map((channel) => parseInt(channel, 16));
  const channels = a.map((value, index) => Math.round(value * (1 - amount) + b[index] * amount));
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function saveChats() {
  writeLocalJSON(CHAT_STORAGE_KEY, chats);
  updateConversationCount();
}

function updateConversationCount() {
  document.getElementById("conversation-count").textContent = String(chats.length);
}

function createNewChat() {
  const newChat = {
    id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `chat_${Date.now()}_${Math.random()}`,
    title: "New conversation",
    messages: []
  };
  chats.unshift(newChat);
  saveChats();
  selectChat(newChat.id);
  closeSidebar();
}

function renderHistoryList() {
  const list = document.getElementById("history-list");
  list.replaceChildren();
  if (chats.length === 0) {
    const empty = document.createElement("p");
    empty.className = "history-empty";
    empty.textContent = "Your saved conversations will appear here.";
    list.appendChild(empty);
    updateConversationCount();
    return;
  }

  chats.forEach((chat) => {
    const row = document.createElement("div");
    row.className = `history-item${chat.id === currentChatId ? " active" : ""}`;
    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "history-open";
    openButton.textContent = chat.title || "New conversation";
    openButton.title = chat.title || "New conversation";
    openButton.addEventListener("click", () => {
      selectChat(chat.id);
      closeSidebar();
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-btn";
    deleteButton.textContent = "Delete";
    deleteButton.setAttribute("aria-label", `Delete conversation: ${chat.title || "New conversation"}`);
    deleteButton.addEventListener("click", () => deleteChat(chat.id));
    row.append(openButton, deleteButton);
    list.appendChild(row);
  });
  updateConversationCount();
}

function selectChat(id) {
  currentChatId = id;
  renderHistoryList();
  renderCurrentMessages();
}

function deleteChat(id) {
  const chat = chats.find((item) => item.id === id);
  if (!chat || !window.confirm(`Delete "${chat.title || "New conversation"}" from this browser?`)) return;
  chats = chats.filter((item) => item.id !== id);
  saveChats();
  if (currentChatId === id) {
    if (chats.length === 0) {
      createNewChat();
      return;
    }
    currentChatId = chats[0].id;
  }
  renderHistoryList();
  renderCurrentMessages();
}

function renderCurrentMessages() {
  const container = document.getElementById("chat-container");
  container.replaceChildren();
  const currentChat = chats.find((chat) => chat.id === currentChatId);
  if (!currentChat || currentChat.messages.length === 0) {
    renderWelcome(container);
    return;
  }
  currentChat.messages.forEach((message) => appendMessageUI(message.role, message.content, container));
  container.scrollTop = container.scrollHeight;
}

function renderWelcome(container) {
  const welcome = document.createElement("section");
  welcome.className = "welcome-panel";
  const kicker = document.createElement("span");
  kicker.className = "welcome-kicker";
  kicker.textContent = "A private AI for your browser";
  const title = document.createElement("h1");
  title.textContent = "Think clearly. Keep everything here.";
  const description = document.createElement("p");
  description.textContent = "Load the Llama model to chat on this device. Add detailed subjects in AI training and the model can explain what it understood before using those notes in your conversations.";
  const suggestions = document.createElement("div");
  suggestions.className = "suggestion-grid";
  [
    ["Learn something", "Explain a difficult idea in simple steps."],
    ["Work through a problem", "Help me reason through a problem carefully."],
    ["Use my notes", "Summarize the most relevant ideas from my trained subjects."],
    ["Write with a plan", "Help me outline a clear, well-organized piece of writing."]
  ].forEach(([label, prompt]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion-card";
    const category = document.createElement("span");
    category.textContent = label;
    const text = document.createElement("span");
    text.className = "suggestion-text";
    text.textContent = prompt;
    button.replaceChildren(category, text);
    button.addEventListener("click", () => {
      const input = document.getElementById("userInput");
      input.value = prompt;
      input.focus();
      resizeComposer();
    });
    suggestions.appendChild(button);
  });
  welcome.append(kicker, title, description, suggestions);
  container.appendChild(welcome);
}

function appendMessageUI(role, text, container = document.getElementById("chat-container")) {
  const row = document.createElement("article");
  row.className = `message ${role}`;
  const avatar = document.createElement("span");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "You" : "AI";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  row.append(avatar, bubble);
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
  return bubble;
}

function resizeComposer() {
  const input = document.getElementById("userInput");
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function updateEngineControls(ready) {
  document.getElementById("userInput").disabled = !ready || isGenerating;
  document.getElementById("sendBtn").disabled = !ready || isGenerating;
  document.getElementById("learnBtn").disabled = !ready || isGenerating;
  document.getElementById("loadBtn").disabled = Boolean(engine);
  document.getElementById("loadBtn").querySelector("span:last-child").textContent = engine
    ? "Model ready"
    : "Load local model";
  document.getElementById("userInput").placeholder = ready
    ? "Ask a question… (Enter to send, Shift + Enter for a new line)"
    : "Load the local model to start a conversation…";
}

async function checkWebGPUAvailability() {
  const warning = document.getElementById("gpu-alert");
  if (!window.isSecureContext && location.protocol !== "file:") {
    warning.hidden = false;
    warning.innerHTML = "<strong>Secure Chrome access is required.</strong><span>Open the installed app from its HTTPS web address so WebGPU and offline storage are available.</span>";
    return false;
  }
  if (!navigator.gpu) {
    warning.hidden = false;
    setStatus("This browser does not currently expose WebGPU.", "error");
    return false;
  }
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("No compatible WebGPU adapter was found.");
    warning.hidden = true;
    return true;
  } catch (error) {
    warning.hidden = false;
    setStatus("Chrome could not access a WebGPU graphics adapter.", "error");
    return false;
  }
}

async function checkLocalModelFiles() {
  if (!navigator.onLine && typeof window.webllm?.hasModelInCache === "function") {
    if (await window.webllm.hasModelInCache(MODEL_ID, MODEL_CONFIG)) return;
    throw new Error("The model is not cached in this Chrome profile yet. Connect to the internet once, load the model, then test offline use.");
  }
  const fileUrls = [
    new URL("mlc-chat-config.json", MODEL_URL).href,
    new URL("tokenizer.json", MODEL_URL).href,
    new URL("params_shard_0.bin", MODEL_URL).href,
    new URL("params_shard_57.bin", MODEL_URL).href,
    MODEL_LIBRARY_URL
  ];
  let checks;
  try {
    checks = await Promise.all(fileUrls.map(async (url) => {
      const response = await fetch(url, { method: "HEAD", cache: "no-store" });
      return { url, ok: response.ok, status: response.status };
    }));
  } catch (error) {
    if (typeof window.webllm?.hasModelInCache === "function" &&
        await window.webllm.hasModelInCache(MODEL_ID, MODEL_CONFIG)) return;
    throw new Error("The local model files are not reachable. Open the app while online, or use the installed app after the model has been cached.");
  }
  const missing = checks.filter((check) => !check.ok);
  if (missing.length && typeof window.webllm?.hasModelInCache === "function" &&
      await window.webllm.hasModelInCache(MODEL_ID, MODEL_CONFIG)) return;
  if (missing.length) {
    throw new Error(`A required local model file could not be found (${missing.map((item) => item.status).join(", ")}).`);
  }
}

async function initializeEngine() {
  if (engine) return;
  const loadButton = document.getElementById("loadBtn");
  loadButton.disabled = true;

  try {
    setStatus("Checking the local model files…", "loading");
    if (location.protocol === "file:") {
      throw new Error("Chrome blocks local model-file access when index.html is opened directly. Open the app from its secure web address and install it in Chrome for offline use.");
    }
    if (!window.webllm || typeof window.webllm.CreateMLCEngine !== "function") {
      throw new Error("The local WebLLM runtime is missing. Keep the vendor folder beside index.html.");
    }
    const webGPUReady = await checkWebGPUAvailability();
    if (!webGPUReady) {
      throw new Error("WebGPU is not available in this Chrome session.");
    }
    await checkLocalModelFiles();

    if (navigator.storage?.persist) {
      try { await navigator.storage.persist(); } catch (error) { console.info("Persistent storage was not granted.", error); }
    }
    setStatus("Loading Llama 3.2 3B into Chrome. The first load may take several minutes…", "loading", 0);
    engine = await window.webllm.CreateMLCEngine(MODEL_ID, {
      appConfig: MODEL_CONFIG,
      initProgressCallback: (report) => {
        const progress = Number.isFinite(report.progress) ? report.progress * 100 : null;
        setStatus(report.text || "Loading the local model…", "loading", progress);
      }
    });
    setStatus("Model ready. Chat and training run on this device.", "ready");
    updateEngineControls(true);
    showToast("The local model is ready. You can now disconnect from the internet.");
  } catch (error) {
    console.error("Could not load the local model.", error);
    const message = error?.message || "The local model could not be loaded.";
    setStatus(message, "error");
    loadButton.disabled = false;
    showToast(message);
  }
}

async function sendMessage() {
  if (isGenerating || !engine) return;
  const input = document.getElementById("userInput");
  const text = input.value.trim();
  const currentChat = chats.find((chat) => chat.id === currentChatId);
  if (!text || !currentChat) return;

  if (currentChat.messages.length === 0) {
    currentChat.title = text.length > 38 ? `${text.slice(0, 38).trim()}…` : text;
    renderHistoryList();
  }
  currentChat.messages.push({ role: "user", content: text });
  appendMessageUI("user", text);
  input.value = "";
  resizeComposer();
  saveChats();

  isGenerating = true;
  updateEngineControls(true);
  setStatus("Thinking on this device…", "loading");
  const answer = appendMessageUI("assistant", "Working on a response…");
  answer.classList.add("is-thinking");

  try {
    const response = await streamCompletion(buildContextMessages(currentChat.messages), {
      temperature: 0.65,
      max_tokens: 700
    }, (partial) => {
      answer.classList.remove("is-thinking");
      answer.textContent = partial || "Working on a response…";
      document.getElementById("chat-container").scrollTop = document.getElementById("chat-container").scrollHeight;
    });
    const finalResponse = response.trim() || "The model did not return a response. Please try again.";
    answer.classList.remove("is-thinking");
    answer.textContent = finalResponse;
    currentChat.messages.push({ role: "assistant", content: finalResponse });
    saveChats();
    setStatus("Model ready. Chat and training run on this device.", "ready");
  } catch (error) {
    console.error("Local response generation failed.", error);
    answer.classList.remove("is-thinking");
    answer.textContent = `The model could not finish this response: ${error?.message || "unknown error"}`;
    setStatus("The model could not finish that response. Try a shorter prompt.", "error");
  } finally {
    isGenerating = false;
    updateEngineControls(true);
    input.focus();
  }
}

function buildContextMessages(activeMessages) {
  const latestMessages = activeMessages.slice(-8);
  const indexedTopics = [...trainingTopics]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 8);
  const summaries = indexedTopics.map((topic) => {
    const summary = topic.learnedSummary || "Saved reference notes are available.";
    return `- ${topic.title}: ${summary.slice(0, 180)}`;
  });
  const latestUserMessage = [...latestMessages].reverse().find((message) => message.role === "user")?.content || "";
  const relevantTopics = rankRelevantTopics(latestUserMessage).slice(0, 2);
  const relevantNotes = relevantTopics.map((topic) => {
    const excerpt = selectRelevantExcerpt(topic.content || "", latestUserMessage, relevantTopics.length > 1 ? 1250 : 2200);
    return `SUBJECT: ${topic.title}\nWHAT WAS LEARNED: ${(topic.learnedSummary || "").slice(0, 700)}\nSOURCE NOTES${excerpt.length < (topic.content || "").length ? " (relevant excerpt)" : ""}:\n${excerpt}`;
  });

  const systemParts = [
    "You are a helpful, respectful, and honest assistant running locally in the user's browser.",
    "Use saved training notes as reference only when they are relevant. Distinguish the user's notes from your general knowledge, and say when the notes do not provide enough information.",
    "Never claim that saved training changed your model weights. Do not use emojis. Explain your reasoning clearly and avoid inventing facts."
  ];
  if (summaries.length) {
    systemParts.push(`SAVED SUBJECT INDEX:\n${summaries.join("\n")}`);
  }
  if (relevantNotes.length) {
    systemParts.push(`RELEVANT SAVED TRAINING MATERIAL:\n${relevantNotes.join("\n\n")}`);
  }
  const recentMessages = trimRecentMessages(latestMessages, 5000);
  return [
    { role: "system", content: systemParts.join("\n\n") },
    ...recentMessages
  ];
}

function trimRecentMessages(messages, characterLimit) {
  let remaining = characterLimit;
  const selected = [];
  for (let index = messages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = messages[index];
    const content = String(message.content || "");
    const clipped = content.length > remaining
      ? `[Earlier part omitted] ${content.slice(-remaining)}`
      : content;
    selected.unshift({ role: message.role, content: clipped });
    remaining -= Math.min(content.length, remaining);
  }
  return selected;
}

function tokenize(text) {
  return (text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || [])
    .filter((word) => !STOP_WORDS.has(word));
}

function rankRelevantTopics(query) {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];
  return trainingTopics.map((topic) => {
    const titleAndSummary = new Set(tokenize(`${topic.title} ${topic.learnedSummary || ""}`));
    let score = 0;
    terms.forEach((term) => {
      if (titleAndSummary.has(term)) score += 3;
      else if ((topic.content || "").toLocaleLowerCase().includes(term)) score += 1;
    });
    return { topic, score };
  }).filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((item) => item.topic);
}

function selectRelevantExcerpt(text, query, limit) {
  if (text.length <= limit) return text;
  const terms = [...new Set(tokenize(query))].filter((term) => term.length >= 4);
  if (terms.length === 0) return `${text.slice(0, limit)}\n[Additional source notes are saved but not included in this response.]`;
  const lowerText = text.toLocaleLowerCase();
  const positions = [];
  terms.forEach((term) => {
    let nextPosition = 0;
    while ((nextPosition = lowerText.indexOf(term, nextPosition)) !== -1 && positions.length < 400) {
      positions.push(nextPosition);
      nextPosition += term.length;
    }
  });
  if (positions.length === 0) return `${text.slice(0, limit)}\n[Additional source notes are saved but not included in this response.]`;
  positions.sort((a, b) => a - b);
  const center = positions[Math.floor(positions.length / 2)];
  const start = Math.max(0, Math.min(text.length - limit, center - Math.floor(limit / 2)));
  return `${start > 0 ? "[…]\n" : ""}${text.slice(start, start + limit)}${start + limit < text.length ? "\n[…]" : ""}`;
}

async function streamCompletion(messages, options, onUpdate) {
  const stream = await engine.chat.completions.create({
    messages,
    stream: true,
    ...options
  });
  let output = "";
  for await (const chunk of stream) {
    output += chunk.choices?.[0]?.delta?.content || "";
    onUpdate(output);
  }
  return output;
}

function openTrainingDatabase() {
  if (!("indexedDB" in window)) {
    return Promise.reject(new Error("This browser does not support local training storage."));
  }
  if (trainingDbPromise) return trainingDbPromise;
  trainingDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(TRAINING_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(TRAINING_STORE_NAME)) {
        database.createObjectStore(TRAINING_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not open local training storage."));
    request.onblocked = () => reject(new Error("Close other Local AI Studio tabs, then try again."));
  });
  return trainingDbPromise;
}

async function getAllTrainingTopics() {
  const database = await openTrainingDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(TRAINING_STORE_NAME, "readonly")
      .objectStore(TRAINING_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("Could not read saved training notes."));
  });
}

async function storeTrainingTopic(topic) {
  const database = await openTrainingDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TRAINING_STORE_NAME, "readwrite");
    transaction.objectStore(TRAINING_STORE_NAME).put(topic);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not save the training notes."));
    transaction.onabort = () => reject(transaction.error || new Error("Saving the training notes was cancelled."));
  });
}

async function removeTrainingTopic(id) {
  const database = await openTrainingDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(TRAINING_STORE_NAME, "readwrite");
    transaction.objectStore(TRAINING_STORE_NAME).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Could not remove the saved subject."));
  });
}

async function initializeTrainingStore() {
  try {
    trainingTopics = await getAllTrainingTopics();
    if (!trainingTopics.length) {
      const legacyNotes = localStorage.getItem("ai_custom_memory");
      if (legacyNotes?.trim()) {
        const legacyTopic = {
          id: `topic_${Date.now()}`,
          title: "Existing saved knowledge",
          content: legacyNotes.trim(),
          learnedSummary: "Previously saved notes. Review them and train the model to generate a new explanation.",
          createdAt: new Date().toISOString(),
          reviewed: false
        };
        await storeTrainingTopic(legacyTopic);
        trainingTopics = [legacyTopic];
      }
    }
  } catch (error) {
    console.error("Local training storage is unavailable.", error);
    setStatus("Training notes could not be opened in this browser.", "error");
    showToast(error?.message || "Local training storage is unavailable.");
  }
  renderTrainingTopics();
}

function updateNotesCharacterCount() {
  const value = document.getElementById("trainingNotesInput").value.length;
  document.getElementById("notes-character-count").textContent = `${value.toLocaleString()} / ${MAX_NOTE_LENGTH.toLocaleString()}`;
}

function splitIntoChunks(text, maxLength) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    if (end < text.length) {
      const paragraphBreak = text.lastIndexOf("\n\n", end);
      const sentenceBreak = text.lastIndexOf(". ", end);
      const boundary = Math.max(paragraphBreak, sentenceBreak);
      if (boundary > start + Math.floor(maxLength * 0.55)) end = boundary + 1;
    }
    chunks.push(text.slice(start, end).trim());
    start = end;
  }
  return chunks.filter(Boolean);
}

async function trainOnSubject(event) {
  event.preventDefault();
  if (!engine || isGenerating) {
    showToast("Load the local model before training a subject.");
    return;
  }
  const title = document.getElementById("trainingTitleInput").value.trim();
  const content = document.getElementById("trainingNotesInput").value.trim();
  if (!title || !content) return;
  if (content.length > MAX_NOTE_LENGTH) {
    showToast(`Keep the subject notes under ${MAX_NOTE_LENGTH.toLocaleString()} characters.`);
    return;
  }

  isGenerating = true;
  const learnButton = document.getElementById("learnBtn");
  learnButton.disabled = true;
  updateEngineControls(Boolean(engine));
  document.getElementById("training-result").hidden = false;
  document.getElementById("result-title").textContent = title;
  document.getElementById("result-summary").textContent = "Reading your notes and preparing an explanation…";
  document.getElementById("reviewed-badge").hidden = true;
  const reviewButton = document.getElementById("reviewSummaryBtn");
  reviewButton.hidden = true;
  reviewButton.disabled = false;
  reviewButton.textContent = "Mark explanation checked";
  setStatus("Reviewing your subject notes on this device…", "loading", 0);

  try {
    const chunks = splitIntoChunks(content, TRAINING_CHUNK_LENGTH);
    const sectionSummaries = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const progress = Math.round((index / (chunks.length + 1)) * 100);
      setStatus(`Reviewing section ${index + 1} of ${chunks.length}…`, "loading", progress);
      const sectionMessages = [
        {
          role: "system",
          content: "Carefully study the provided reference notes. Explain the important facts and relationships in this section in clear language. Keep names, definitions, steps, conditions, and numbers accurate. Do not add outside facts. If something is unclear, say so."
        },
        {
          role: "user",
          content: `Subject: ${title}\nSection ${index + 1} of ${chunks.length}:\n\n${chunks[index]}`
        }
      ];
      sectionSummaries.push(await streamCompletion(sectionMessages, { temperature: 0.2, max_tokens: 320 }, () => {}));
    }

    setStatus("Preparing the explanation of what was learned…", "loading", Math.round((chunks.length / (chunks.length + 1)) * 100));
    const finalMessages = [
      {
        role: "system",
        content: "You are checking what you understood from a user's supplied reference material. Produce a concise but detailed explanation back to the user. Include the main ideas, important facts or steps, and any uncertainty or missing information. Do not claim the model's weights changed. Do not add unsupported facts."
      },
      {
        role: "user",
        content: `Subject: ${title}\n\n${sectionSummaries.length > 1
          ? `Section-by-section review of the original notes:\n${sectionSummaries.map((summary, index) => `Section ${index + 1}: ${summary}`).join("\n\n")}`
          : `Original notes:\n${content}`}\n\nExplain what you learned from this material so the user can check your understanding.`
      }
    ];
    const summary = await streamCompletion(finalMessages, {
      temperature: 0.2,
      max_tokens: 700
    }, (partial) => {
      document.getElementById("result-summary").textContent = partial || "Preparing the explanation…";
    });

    const topic = {
      id: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `topic_${Date.now()}_${Math.random()}`,
      title,
      content,
      learnedSummary: summary.trim(),
      createdAt: new Date().toISOString(),
      reviewed: false
    };
    await storeTrainingTopic(topic);
    trainingTopics.unshift(topic);
    activeTrainingId = topic.id;
    renderTrainingTopics();
    document.getElementById("result-summary").textContent = topic.learnedSummary || "The model processed the notes but did not return an explanation. Try training this subject again.";
    document.getElementById("reviewSummaryBtn").hidden = false;
    document.getElementById("trainingTitleInput").value = "";
    document.getElementById("trainingNotesInput").value = "";
    updateNotesCharacterCount();
    setStatus("Subject saved. The model will use these notes when relevant.", "ready");
    showToast("Subject learned and saved in this browser.");
  } catch (error) {
    console.error("Training failed.", error);
    setStatus("Training did not finish. Your notes are still in the form.", "error");
    document.getElementById("result-summary").textContent = `The model could not finish reviewing this subject: ${error?.message || "unknown error"}`;
    showToast("Training was not saved. Your notes remain in the form.");
  } finally {
    isGenerating = false;
    updateEngineControls(Boolean(engine));
    learnButton.disabled = !engine;
  }
}

function renderTrainingTopics() {
  const list = document.getElementById("training-list");
  list.replaceChildren();
  const count = String(trainingTopics.length);
  document.getElementById("training-count").textContent = count;
  document.getElementById("saved-topic-count").textContent = count;
  if (trainingTopics.length === 0) {
    const empty = document.createElement("p");
    empty.className = "training-empty";
    empty.textContent = "No subjects saved yet. Add a subject and notes above, then load the local model to have it explain what it understood.";
    list.appendChild(empty);
    return;
  }

  [...trainingTopics]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .forEach((topic) => {
      const card = document.createElement("article");
      card.className = "training-card";
      const heading = document.createElement("div");
      heading.className = "training-card-heading";
      const title = document.createElement("h3");
      title.textContent = topic.title || "Untitled subject";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "topic-delete";
      remove.textContent = "Remove";
      remove.setAttribute("aria-label", `Remove training subject ${topic.title}`);
      remove.addEventListener("click", () => deleteTrainingTopic(topic.id));
      heading.append(title, remove);

      const summary = document.createElement("p");
      summary.textContent = topic.learnedSummary || "This subject was saved before the explanation feature was added.";
      const details = document.createElement("details");
      const detailsSummary = document.createElement("summary");
      detailsSummary.textContent = "View saved notes";
      const notes = document.createElement("p");
      notes.textContent = topic.content || "";
      details.append(detailsSummary, notes);

      const meta = document.createElement("div");
      meta.className = "training-card-meta";
      const created = topic.createdAt ? new Date(topic.createdAt).toLocaleDateString() : "Saved subject";
      meta.textContent = `${created}${topic.reviewed ? " · explanation checked" : ""}`;
      card.append(heading, summary, details, meta);
      list.appendChild(card);
    });
}

async function deleteTrainingTopic(id) {
  const topic = trainingTopics.find((item) => item.id === id);
  if (!topic || !window.confirm(`Remove "${topic.title}" from saved training?`)) return;
  try {
    await removeTrainingTopic(id);
    trainingTopics = trainingTopics.filter((item) => item.id !== id);
    if (activeTrainingId === id) {
      activeTrainingId = null;
      document.getElementById("training-result").hidden = true;
    }
    renderTrainingTopics();
    showToast("Saved subject removed from this browser.");
  } catch (error) {
    console.error("Could not remove the training subject.", error);
    showToast(error?.message || "Could not remove the saved subject.");
  }
}

async function markCurrentSummaryReviewed() {
  const topic = trainingTopics.find((item) => item.id === activeTrainingId);
  if (!topic) return;
  const updatedTopic = { ...topic, reviewed: true };
  try {
    await storeTrainingTopic(updatedTopic);
    trainingTopics = trainingTopics.map((item) => item.id === topic.id ? updatedTopic : item);
    document.getElementById("reviewed-badge").hidden = false;
    document.getElementById("reviewSummaryBtn").textContent = "Explanation checked";
    document.getElementById("reviewSummaryBtn").disabled = true;
    renderTrainingTopics();
  } catch (error) {
    showToast(error?.message || "Could not save the review status.");
  }
}

function updateNetworkMessage() {
  if (engine) return;
  if (!navigator.onLine) {
    setStatus("Offline. The model can load only if its files are already saved in this Chrome profile.", "ready");
  }
}

async function registerOfflineShell() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext || location.protocol === "file:") return;
  try {
    await navigator.serviceWorker.register(new URL("./service-worker.js", document.baseURI));
  } catch (error) {
    console.warn("Offline app shell registration failed.", error);
  }
}
