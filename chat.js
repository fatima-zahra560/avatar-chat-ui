// chat.js
// ======================================================
// AVATAR (Speech) + BACKEND RAG ONLY
// - No Azure OpenAI / No Azure Search in browser
// - Frontend: STT + TTS + Avatar animation
// - Backend: answers + routing + RAG + system prompt
// ======================================================

/* global SpeechSDK */

// -----------------------------
// Global state
// -----------------------------
let avatarSynthesizer = null;
let speechRecognizer = null;
let peerConnection = null;
let peerConnectionDataChannel = null;

let sessionActive = false;
let userClosedSession = false;
let isReconnecting = false;

let isSpeaking = false;
let speakingText = "";
let spokenTextQueue = [];

let speakingWatchdog = null;
const MAX_SPEAK_STALL_MS = 120000;

let lastUserWasArabic = false;
let lastInteractionTime = null;

let imgUrl = "";

// -----------------------------
// Backend configuration (ONLY)
// -----------------------------
const CHATBOT_BASE_URL =
  "https://capps-backend-q67znilz7ay44.greenmushroom-8064f9e1.eastus2.azurecontainerapps.io";
const CHATBOT_URL = `${CHATBOT_BASE_URL}/chat`;

// Latency knobs
const SPEAK_BY_SENTENCES = true;
const LOG_LATENCY = true;

// If your backend supports conversation_id, keep it stable.
// Otherwise you can remove it.
const conversationId = crypto?.randomUUID?.() || String(Date.now());

// -----------------------------
// Helpers
// -----------------------------
function isArabicText(text) {
  return /[\u0600-\u06FF]/.test(text);
}

function htmlEncode(text) {
  const entityMap = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
    "/": "&#x2F;",
  };
  return String(text).replace(/[&<>"'\/]/g, (m) => entityMap[m]);
}

function sanitizeForSpeech(raw) {
  let text = raw || "";
  text = text.replace(/\*\*/g, "");
  text = text.replace(/\*/g, "");
  text = text.replace(/#{1,6}\s*/g, "");
  text = text.replace(/(^|\n)\s*[-•]\s*/g, "$1");
  text = text.replace(/\r?\n+/g, " ");
  text = text.replace(/\s{2,}/g, " ");
  return text.trim();
}

function splitIntoSentences(text) {
  const t = (text || "").trim();
  if (!t) return [];
  return t.split(/(?<=[.!?؟])\s+/).map(s => s.trim()).filter(Boolean);
}

// -----------------------------
// Speaking watchdog
// -----------------------------
function armSpeakingWatchdog() {
  clearTimeout(speakingWatchdog);
  speakingWatchdog = setTimeout(() => {
    if (isSpeaking) {
      console.warn("[TTS] Stalled >12s, forcing reset");
      isSpeaking = false;
      speakingText = "";
      if (spokenTextQueue.length > 0) {
        const next = spokenTextQueue.shift();
        speak(next);
      }
    }
  }, MAX_SPEAK_STALL_MS);
}

// -----------------------------
// Debounce duplicates (STT)
// -----------------------------
let lastUserQuery = "";
let lastUserQueryAt = 0;

function shouldIgnoreQuery(q) {
  const now = Date.now();
  if (!q) return true;
  if (q === lastUserQuery && now - lastUserQueryAt < 1500) return true;
  lastUserQuery = q;
  lastUserQueryAt = now;
  return false;
}

// ===============================
// BILINGUAL TTS NORMALIZER (AR/FR)
// ===============================
function detectLang(text) {
  return /[\u0600-\u06FF]/.test(text) ? "ar" : "fr";
}

const TTS_MAP = [
  ["DH/semaine", "درهم في الأسبوع", "dirham par semaine"],
  ["DH/mois", "درهم في الشهر", "dirham par mois"],
  ["DH/jour", "درهم في اليوم", "dirham par jour"],
  ["DH/SMS", "درهم لكل رسالة", "dirham par SMS"],
  ["DH/min", "درهم للدقيقة", "dirham par minute"],
  ["VIP", "في آي بي", "VIP"],
  ["Aghani", "أغني", "arani"],
  ["A-Ghany", "أغني", "arani"],
  ["Playup", "Play Up", "Play Up"],
  ["Apps Club", "آبس كلوب", "aps club"],

  ["Anghamy", "أنغامي (anrami)", "anrami"],
  ["Anghami", "أنغامي (anrami)", "anrami"],

  ["Go/mois", "جيغا أوكتي في الشهر", "giga-octets par mois"],
  ["Mo/s", "ميغا أوكتي في الثانية", "méga-octets par seconde"],
  ["Mb/s", "ميغابت في الثانية", "mégabits par seconde"],
  ["Gb/s", "غيغابت في الثانية", "gigabits par seconde"],

  ["24h", "أربع وعشرون ساعة", "vingt-quatre heures"],
  ["7j", "سبعة أيام", "sept jours"],
  ["30j", "ثلاثون يوماً", "trente jours"],

  ["4G+", "فور جي بلس", "quatre G plus"],
  ["4G", "فور جي", "quatre G"],
  ["5G", "فايف جي", "cinq G"],

  ["e-SIM", "إي سيم", "e-sim"],
  ["Wi-Fi", "واي فاي", "wifi"],
  ["VoLTE", "فو إل تي إي", "V O L T E"],
  ["USSD", "يو إس إس دي", "U S S D"],
  ["ADSL", "أي دي إس إل", "A D S L"],
  ["IP", "آي بي", "I P"],
  ["PIN", "رمز سري", "P I N"],
  ["PUK", "رمز فك القفل", "P U K"],

  ["IAM", "اتصالات المغرب", "Itissalat Al-Maghrib"],
  ["MT", "ماروك تيليكوم", "Maroc Telecom"],

  ["DH", "درهم", "dirham"],
  ["Go", "جيغا أوكتي", "giga-octet"],
  ["Mo", "ميغا أوكتي", "méga-octet"],
  ["Ko", "كيلو أوكتي", "kilo-octet"],

  ["SMS", "رسالة قصيرة", "S M S"],
  ["MMS", "رسالة وسائط", "M M S"],
  ["min", "دقيقة", "minute"],
  ["sec", "ثانية", "seconde"],

  ["HT", "بدون ضرائب", "hors taxes"],
  ["TTC", "شامل الضرائب", "toutes taxes comprises"],
  ["TVA", "الضريبة على القيمة المضافة", "T V A"],

  ["VUZ", "فاز", "vaz"],
  ["FTTR", "فايبر إلى الغرفة", "Fibre to the room"],

  // Single letter H — keep last
  ["H", "ساعة", "heure"],
];

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeTokenRegex(token) {
  const t = escapeRegex(token);
  return new RegExp(`(^|[^0-9A-Za-z\u0600-\u06FF])(${t})(?=$|[^0-9A-Za-z\u0600-\u06FF])`, "g");
}

function normalizeForTtsBilingual(text) {
  if (!text) return "";
  const lang = detectLang(text);

  let out = text
    .replace(/(\d)(Go|Mo|Ko|DH|Mb\/s|Gb\/s)\b/g, "$1 $2")
    .replace(/(\d)(h|H)\b/g, "$1 H");

  const sorted = [...TTS_MAP].sort((a, b) => b[0].length - a[0].length);

  for (const [token, arSpoken, frSpoken] of sorted) {
    const repl = lang === "ar" ? arSpoken : frSpoken;
    if (!repl) continue;
    const re = makeTokenRegex(token);
    out = out.replace(re, `$1${repl}`);
  }
  return out;
}

// -----------------------------
// Backend call (RAG only)
// IMPORTANT: payload is SIMPLE.
// If your backend expects {messages: [...]}, change it here.
// -----------------------------
async function callChatbotBackend(userQuery) {
  // Most compatible payload for /chat
  const payload = {
    messages: [{ role: "user", content: userQuery }],
    // optional:
    // session_state: null,
    // stream: false
  };

  const res = await fetch(CHATBOT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Backend error ${res.status}: ${err}`);
  }

  const data = await res.json();

  // common response shapes
  const answer =
    data.answer ||
    data.choices?.[0]?.message?.content ||
    data.message?.content ||
    data.content;

  return (typeof answer === "string" && answer.trim() !== "") ? answer : JSON.stringify(data);
}


// -----------------------------
// Avatar connect (Speech only)
// -----------------------------
function connectAvatar() {
  const cogSvcRegion = document.getElementById("region").value;
  const cogSvcSubKey = document.getElementById("APIKey").value;

  if (!cogSvcSubKey) {
    alert("Please fill in the Speech API key.");
    return;
  }

  const privateEndpointEnabled = document.getElementById("enablePrivateEndpoint").checked;
  const privateEndpointInput = document.getElementById("privateEndpoint").value || "";
  const privateEndpoint = privateEndpointInput.replace(/^https?:\/\//, "").replace(/\/+$/, "");

  if (privateEndpointEnabled && !privateEndpoint) {
    alert("Please fill in the Speech private endpoint.");
    return;
  }

  // TTS / Avatar config
  let speechSynthesisConfig;
  const isCustomAvatar = document.getElementById("customizedAvatar").checked;
  const isCustomVoice = (document.getElementById("customVoiceEndpointId").value || "") !== "";
  const endpoint_route = isCustomAvatar || isCustomVoice ? "voice" : "tts";

  if (privateEndpointEnabled) {
    speechSynthesisConfig = SpeechSDK.SpeechConfig.fromEndpoint(
      new URL(`wss://${privateEndpoint}/${endpoint_route}/cognitiveservices/websocket/v1?enableTalkingAvatar=true`),
      cogSvcSubKey
    );
  } else {
    speechSynthesisConfig = SpeechSDK.SpeechConfig.fromSubscription(cogSvcSubKey, cogSvcRegion);
  }

  speechSynthesisConfig.endpointId = document.getElementById("customVoiceEndpointId").value;

  const frenchVoice = document.getElementById("ttsVoice").value || "fr-FR-DeniseNeural";
  speechSynthesisConfig.speechSynthesisLanguage = "fr-FR";
  speechSynthesisConfig.speechSynthesisVoiceName = frenchVoice;

  const talkingAvatarCharacter = document.getElementById("talkingAvatarCharacter").value || "Meg";
  const talkingAvatarStyle = document.getElementById("talkingAvatarStyle").value || "business";
  const avatarConfig = new SpeechSDK.AvatarConfig(talkingAvatarCharacter, talkingAvatarStyle);

  avatarConfig.photoAvatarBaseModel = document.getElementById("photoAvatar").checked ? "vasa-1" : "";
  avatarConfig.customized = document.getElementById("customizedAvatar").checked;
  avatarConfig.useBuiltInVoice = false;

  avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechSynthesisConfig, avatarConfig);

  // STT config
  let speechRecognitionConfig;
  if (privateEndpointEnabled) {
    speechRecognitionConfig = SpeechSDK.SpeechConfig.fromEndpoint(
      new URL(`wss://${privateEndpoint}/stt/speech/universal/v2`),
      cogSvcSubKey
    );
  } else {
    speechRecognitionConfig = SpeechSDK.SpeechConfig.fromEndpoint(
      new URL(`wss://${cogSvcRegion}.stt.speech.microsoft.com/speech/universal/v2`),
      cogSvcSubKey
    );
  }

  speechRecognitionConfig.setProperty(SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous");
  const sttLocales = (document.getElementById("sttLocales").value || "fr-FR").split(",").map(s => s.trim()).filter(Boolean);
  const autoDetectSourceLanguageConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(sttLocales);

  speechRecognizer = SpeechSDK.SpeechRecognizer.FromConfig(
    speechRecognitionConfig,
    autoDetectSourceLanguageConfig,
    SpeechSDK.AudioConfig.fromDefaultMicrophoneInput()
  );

  // UI state
  document.getElementById("startSession").disabled = true;
  document.getElementById("configuration").hidden = true;

  // Relay token for WebRTC
  const xhr = new XMLHttpRequest();
  if (privateEndpointEnabled) {
    xhr.open("GET", `https://${privateEndpoint}/tts/cognitiveservices/avatar/relay/token/v1`);
  } else {
    xhr.open("GET", `https://${cogSvcRegion}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1`);
  }

  xhr.setRequestHeader("Ocp-Apim-Subscription-Key", cogSvcSubKey);
  xhr.addEventListener("readystatechange", function () {
    if (this.readyState === 4) {
      const responseData = JSON.parse(this.responseText);
      setupWebRTC(responseData.Urls[0], responseData.Username, responseData.Password);
    }
  });

  xhr.send();
}

function disconnectAvatar() {
  if (avatarSynthesizer) avatarSynthesizer.close();
  if (speechRecognizer) {
    speechRecognizer.stopContinuousRecognitionAsync();
    speechRecognizer.close();
  }
  sessionActive = false;
}

// -----------------------------
// WebRTC setup
// -----------------------------
function setupWebRTC(iceServerUrl, iceServerUsername, iceServerCredential) {
  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: [iceServerUrl], username: iceServerUsername, credential: iceServerCredential }],
  });

  peerConnection.ontrack = function (event) {
    if (event.track.kind === "audio") {
      const audioElement = document.createElement("audio");
      audioElement.id = "audioPlayer";
      audioElement.srcObject = event.streams[0];
      audioElement.autoplay = false;
      audioElement.addEventListener("loadeddata", () => audioElement.play());

      const remoteVideoDiv = document.getElementById("remoteVideo");
      [...remoteVideoDiv.childNodes].forEach(n => {
        if (n.localName === "audio") remoteVideoDiv.removeChild(n);
      });
      remoteVideoDiv.appendChild(audioElement);
    }

    if (event.track.kind === "video") {
      const videoElement = document.createElement("video");
      videoElement.id = "videoPlayer";
      videoElement.srcObject = event.streams[0];
      videoElement.autoplay = false;
      videoElement.addEventListener("loadeddata", () => videoElement.play());
      videoElement.playsInline = true;
      videoElement.style.width = "0.5px";

      const remoteVideoDiv = document.getElementById("remoteVideo");
      remoteVideoDiv.appendChild(videoElement);

      videoElement.onplaying = () => {
        // keep only one video
        [...remoteVideoDiv.childNodes].forEach(n => {
          if (n.localName === "video") remoteVideoDiv.removeChild(n);
        });

        videoElement.style.width = document.getElementById("photoAvatar").checked ? "512px" : "960px";
        remoteVideoDiv.appendChild(videoElement);

        document.getElementById("microphone").disabled = false;
        document.getElementById("stopSession").disabled = false;
        document.getElementById("remoteVideo").style.width =
          document.getElementById("photoAvatar").checked ? "512px" : "960px";

        document.getElementById("chatHistory").hidden = false;
        document.getElementById("showTypeMessage").disabled = false;

        isReconnecting = false;
        setTimeout(() => { sessionActive = true; }, 1000);
      };
    }
  };

  peerConnection.addEventListener("datachannel", (event) => {
    peerConnectionDataChannel = event.channel;
    peerConnectionDataChannel.onmessage = (e) => {
      console.log("WebRTC event received:", e.data);
    };
  });

  peerConnection.createDataChannel("eventChannel");

  peerConnection.oniceconnectionstatechange = () => {
    console.log("WebRTC status:", peerConnection.iceConnectionState);
  };

  peerConnection.addTransceiver("video", { direction: "sendrecv" });
  peerConnection.addTransceiver("audio", { direction: "sendrecv" });

  avatarSynthesizer.startAvatarAsync(peerConnection)
    .then((r) => {
      if (r.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
        console.log("Avatar started:", r.resultId);
      } else {
        console.log("Unable to start avatar:", r.resultId);
        document.getElementById("startSession").disabled = false;
        document.getElementById("configuration").hidden = false;
      }
    })
    .catch((error) => {
      console.log("Avatar failed to start:", error);
      document.getElementById("startSession").disabled = false;
      document.getElementById("configuration").hidden = false;
    });
}

// -----------------------------
// Speak (Avatar TTS)
// -----------------------------
function speak(text, endingSilenceMs = 0) {
  const cleaned = sanitizeForSpeech(text);
  if (!cleaned) return;

  if (isSpeaking) {
    spokenTextQueue.push(cleaned);
    return;
  }
  speakNext(cleaned, endingSilenceMs);
}

function speakNext(rawText, endingSilenceMs = 0) {
  let text = sanitizeForSpeech(rawText);

  const isArabic = isArabicText(text);
  const lang = isArabic ? "ar-MA" : "fr-FR";
  const frenchVoice = document.getElementById("ttsVoice").value || "fr-FR-DeniseNeural";
  const arabicVoice = "ar-MA-MounaNeural";
  const voice = isArabic ? arabicVoice : frenchVoice;

  let ssml = `<speak version='1.0'
    xmlns='http://www.w3.org/2001/10/synthesis'
    xmlns:mstts='http://www.w3.org/2001/mstts'
    xml:lang='${lang}'>
    <voice name='${voice}'>
      <mstts:leadingsilence-exact value='0'/>
      ${htmlEncode(text)}
    </voice>
  </speak>`;

  if (endingSilenceMs > 0) {
    ssml = `<speak version='1.0'
      xmlns='http://www.w3.org/2001/10/synthesis'
      xmlns:mstts='http://www.w3.org/2001/mstts'
      xml:lang='${lang}'>
      <voice name='${voice}'>
        <mstts:leadingsilence-exact value='0'/>
        ${htmlEncode(text)}
        <break time='${endingSilenceMs}ms' />
      </voice>
    </speak>`;
  }

  const chatHistory = document.getElementById("chatHistory");
  chatHistory.innerHTML += text.replace(/\n/g, "<br/>");
  chatHistory.scrollTop = chatHistory.scrollHeight;

  isSpeaking = true;
  armSpeakingWatchdog();
  speakingText = text;
  document.getElementById("stopSpeaking").disabled = false;

  avatarSynthesizer.speakSsmlAsync(ssml)
    .then(() => {
      clearTimeout(speakingWatchdog);
      speakingText = "";
      if (spokenTextQueue.length > 0) {
        speakNext(spokenTextQueue.shift());
      } else {
        isSpeaking = false;
        document.getElementById("stopSpeaking").disabled = true;
      }
    })
    .catch((error) => {
      clearTimeout(speakingWatchdog);
      console.log("TTS error:", error);
      speakingText = "";
      if (spokenTextQueue.length > 0) {
        speakNext(spokenTextQueue.shift());
      } else {
        isSpeaking = false;
        document.getElementById("stopSpeaking").disabled = true;
      }
    });
}

function stopSpeaking() {
  spokenTextQueue = [];
  if (!avatarSynthesizer) return;

  avatarSynthesizer.stopSpeakingAsync()
    .then(() => {
      isSpeaking = false;
      document.getElementById("stopSpeaking").disabled = true;
    })
    .catch((error) => console.log("Stop speaking error:", error));
}

// -----------------------------
// Main: handleUserQuery => Backend only
// -----------------------------
async function handleUserQuery(userQuery) {
  lastUserWasArabic = isArabicText(userQuery);
  lastInteractionTime = new Date();

  const chatHistory = document.getElementById("chatHistory");
  chatHistory.innerHTML += `<br/><br/>User: ${htmlEncode(userQuery)}<br/>Assistant: `;
  chatHistory.scrollTop = chatHistory.scrollHeight;

  if (isSpeaking) stopSpeaking();

  let answer = "";
  const t0 = performance.now();

  try {
    answer = await callChatbotBackend(userQuery);
  } catch (e) {
    console.log(e);
    answer = lastUserWasArabic
      ? "وقع خطأ أثناء الاتصال بالخادم. حاول مرة أخرى."
      : "Erreur lors de l’appel au serveur. Réessayez.";
  }

  if (LOG_LATENCY) console.log("Backend ms:", Math.round(performance.now() - t0));

  const ttsText = normalizeForTtsBilingual(answer);

  if (SPEAK_BY_SENTENCES) {
    const parts = splitIntoSentences(ttsText);
    if (!parts.length) return;
    speak(parts[0]);
    for (let i = 1; i < parts.length; i++) speak(parts[i]);
  } else {
    speak(ttsText);
  }
}

// -----------------------------
// UI handlers
// -----------------------------
window.startSession = () => {
  lastInteractionTime = new Date();
  userClosedSession = false;

  const pe = document.getElementById("enablePrivateEndpoint");
  const peBox = document.getElementById("showPrivateEndpointCheckBox");
  if (pe && peBox) {
    pe.addEventListener("change", () => {
      peBox.hidden = !pe.checked;
    });
    peBox.hidden = !pe.checked;
  }

  connectAvatar();
};

window.stopSession = () => {
  lastInteractionTime = new Date();

  document.getElementById("startSession").disabled = false;
  document.getElementById("microphone").disabled = true;
  document.getElementById("stopSession").disabled = true;
  document.getElementById("configuration").hidden = false;
  document.getElementById("chatHistory").hidden = true;

  userClosedSession = true;
  disconnectAvatar();
};

window.clearChatHistory = () => {
  document.getElementById("chatHistory").innerHTML = "";
};

window.microphone = () => {
  lastInteractionTime = new Date();
  if (!speechRecognizer) return;

  const micBtn = document.getElementById("microphone");

  if (micBtn.innerHTML === "Stop Microphone") {
    micBtn.disabled = true;
    speechRecognizer.stopContinuousRecognitionAsync(
      () => {
        micBtn.innerHTML = "Start Microphone";
        micBtn.disabled = false;
      },
      (err) => {
        console.log("Failed to stop recognition:", err);
        micBtn.disabled = false;
      }
    );
    return;
  }

  const audioEl = document.getElementById("audioPlayer");
  if (audioEl) audioEl.play();

  micBtn.disabled = true;

  speechRecognizer.recognized = async (s, e) => {
    if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
      const userQuery = (e.result.text || "").trim();
      if (shouldIgnoreQuery(userQuery)) return;
      await handleUserQuery(userQuery);
    }
  };

  speechRecognizer.startContinuousRecognitionAsync(
    () => {
      micBtn.innerHTML = "Stop Microphone";
      micBtn.disabled = false;
    },
    (err) => {
      console.log("Failed to start recognition:", err);
      micBtn.disabled = false;
    }
  );
};

window.stopSpeaking = stopSpeaking;

// -------------------------
// Type message (Enter to send)
// -------------------------
let typeMessageHandlersAttached = false;

function attachTypeMessageHandlersOnce() {
  if (typeMessageHandlersAttached) return;
  typeMessageHandlersAttached = true;

  const box = document.getElementById("userMessageBox");
  const upload = document.getElementById("uploadImgIcon");

  box.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();

    const userQuery = box.innerText.trim();
    if (!userQuery) return;

    box.innerHTML = "";
    await handleUserQuery(userQuery);
  });

  upload.addEventListener("click", function () {
    imgUrl = "https://wallpaperaccess.com/full/528436.jpg";

    const userMessage = document.getElementById("userMessageBox");
    const childImg = userMessage.querySelector("#picInput");
    if (childImg) userMessage.removeChild(childImg);

    userMessage.innerHTML += `<br/><img id="picInput" src="${imgUrl}" style="width:100px;height:100px"/><br/><br/>`;
  });
}

window.updateTypeMessageBox = () => {
  const cb = document.getElementById("showTypeMessage");
  const box = document.getElementById("userMessageBox");
  const upload = document.getElementById("uploadImgIcon");

  if (!cb || !box || !upload) return;

  if (cb.checked) {
    box.hidden = false;
    upload.hidden = false;

    box.setAttribute("contenteditable", "true");
    box.style.pointerEvents = "auto";
    box.style.userSelect = "text";

    attachTypeMessageHandlersOnce();

    setTimeout(() => {
      box.focus();
      document.execCommand?.("selectAll", false, null);
      document.getSelection()?.collapseToEnd();
    }, 0);
  } else {
    box.hidden = true;
    upload.hidden = true;
    imgUrl = "";
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const cb = document.getElementById("showTypeMessage");
  if (!cb) return;
  cb.addEventListener("change", () => window.updateTypeMessageBox());
});
