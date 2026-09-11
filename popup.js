const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const timerEl = document.getElementById("timer");
const formatHint = document.getElementById("formatHint");
const actionBtn = document.getElementById("actionBtn");
const openFolderBtn = document.getElementById("openFolderBtn");
const resultText = document.getElementById("resultText");
const errorText = document.getElementById("errorText");
const logText = document.getElementById("logText");
const legalLabel = document.getElementById("legalLabel");
const legalCheck = document.getElementById("legalCheck");

let timerId = null;
let currentState = idleState();
let legalAccepted = false;

localizeDocument();
init();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === MSG.STATE_CHANGED) {
    renderState(message.state);
  }
});

async function init() {
  actionBtn.addEventListener("click", onActionClick);
  openFolderBtn.addEventListener("click", onOpenFolderClick);
  legalCheck.addEventListener("change", onLegalCheckChange);
  await loadLegalAcceptance();
  const state = await chrome.runtime.sendMessage({
    type: MSG.GET_STATE,
    target: TARGET.BACKGROUND,
  });
  renderState(state || idleState());
}

async function onActionClick() {
  clearError();
  actionBtn.disabled = true;
  try {
    if (currentState.status === STATUS.RECORDING) {
      const result = await chrome.runtime.sendMessage({
        type: MSG.STOP_RECORDING,
        target: TARGET.BACKGROUND,
      });
      if (result && result.ok === false) {
        throw new Error(result.error || i18nMessage("stopFailed", "停止失败"));
      }
      renderState({ ...currentState, status: STATUS.STOPPING, error: "" });
    } else {
      if (!legalAccepted) {
        legalLabel.hidden = false;
        legalCheck.focus();
        throw new Error(
          i18nMessage("acceptNoticeFirst", "请先勾选使用须知后再开始录制")
        );
      }
      await startCapture();
    }
  } catch (error) {
    showError(error.message || String(error));
    if (legalAccepted) {
      showLogs();
    }
    actionBtn.disabled = false;
  }
}

async function onOpenFolderClick() {
  try {
    const result = await chrome.runtime.sendMessage({
      type: MSG.OPEN_DOWNLOAD_FOLDER,
      target: TARGET.BACKGROUND,
    });
    if (result && result.ok === false) {
      throw new Error(
        result.error ||
          i18nMessage("openDownloadFolderFailed", "无法打开下载目录")
      );
    }
  } catch (error) {
    showError(error.message || String(error));
  }
}

async function startCapture() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    throw new Error(i18nMessage("activeTabMissing", "找不到当前标签页"));
  }
  if (isRestrictedUrl(tab.url)) {
    throw new Error(
      i18nMessage("restrictedPage", "无法录制浏览器内部页面")
    );
  }

  const result = await chrome.runtime.sendMessage({
    type: MSG.START_RECORDING,
    target: TARGET.BACKGROUND,
    tabId: tab.id,
  });
  if (!result || result.ok === false) {
    throw new Error(
      (result && result.error) ||
        i18nMessage("startRecordingFailed", "无法开始录制")
    );
  }
  if (result.state) {
    renderState(result.state);
  }
}

function renderState(state) {
  currentState = state || idleState();
  stopTimer();

  const status = currentState.status || STATUS.IDLE;
  statusDot.className = `dot ${status === STATUS.IDLE ? "idle" : status}`;

  if (status === STATUS.RECORDING) {
    statusText.textContent = i18nMessage("statusRecording", "录制中");
    setFormatHint(
      currentState.videoCount > 1
        ? i18nMessage(
            "recordingVideoCount",
            "正在录制 $1 个视频",
            currentState.videoCount
          )
        : ""
    );
    actionBtn.textContent = i18nMessage("stopAndSave", "停止并保存");
    actionBtn.className = "btn stop";
    actionBtn.disabled = false;
    startTimer(currentState.startTime);
  } else if (status === STATUS.STOPPING) {
    statusText.textContent = i18nMessage("statusSaving", "正在保存");
    setFormatHint(
      currentState.finalizing
        ? i18nMessage(
            "finalizingSeekableVideo",
            "正在生成可拖动视频并保存，请勿关闭浏览器"
          )
        : i18nMessage(
            "stoppingAndSaving",
            "正在结束录制并保存已播放内容"
          )
    );
    actionBtn.textContent = i18nMessage("saving", "保存中…");
    actionBtn.className = "btn stop";
    actionBtn.disabled = true;
    if (currentState.startTime) {
      timerEl.textContent = formatDuration(Date.now() - currentState.startTime);
    }
  } else {
    statusText.textContent = i18nMessage("statusIdle", "未录制");
    setFormatHint("");
    actionBtn.textContent = i18nMessage("startRecording", "开始录制");
    actionBtn.className = "btn start";
    actionBtn.disabled = false;
    timerEl.textContent = "00:00";
  }

  const presentation = terminalPresentation(currentState);
  renderResult(presentation);
  if (currentState.error && !presentation.visible) {
    showError(currentState.error);
    showLogs();
  } else {
    clearError();
    if (presentation.showLogs) showLogs();
  }
}

function renderResult(presentation) {
  if (!presentation.visible) {
    resultText.hidden = true;
    resultText.className = "result";
    resultText.textContent = "";
    return;
  }
  resultText.hidden = false;
  resultText.className = `result ${presentation.tone}`;
  resultText.textContent = i18nMessage(
    "resultFormat",
    "$1：$2",
    [presentation.title, presentation.message]
  );
}

function setFormatHint(text) {
  formatHint.textContent = text;
  formatHint.hidden = !text;
}

function startTimer(startTime) {
  const tick = () => {
    timerEl.textContent = formatDuration(Date.now() - startTime);
  };
  tick();
  timerId = setInterval(tick, 250);
}

function stopTimer() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function showError(message) {
  errorText.hidden = false;
  errorText.textContent = message;
}

async function showLogs() {
  try {
    const logs = await chrome.runtime.sendMessage({
      type: MSG.GET_LOGS,
      target: TARGET.BACKGROUND,
    });
    if (!logs || !logs.length) {
      logText.hidden = true;
      return;
    }
    logText.hidden = false;
    logText.textContent = logs
      .map((item) => {
        const extra = item.extra ? ` ${JSON.stringify(item.extra)}` : "";
        return `${item.at.slice(11, 19)} ${item.scope} ${item.message}${extra}`;
      })
      .join("\n");
  } catch {
    logText.hidden = true;
  }
}

function clearError() {
  errorText.hidden = true;
  errorText.textContent = "";
  logText.hidden = true;
  logText.textContent = "";
}

async function loadLegalAcceptance() {
  const stored = await chrome.storage.local.get(LEGAL_NOTICE_KEY);
  legalAccepted = Boolean(stored[LEGAL_NOTICE_KEY]);
  legalLabel.hidden = legalAccepted;
  legalCheck.checked = legalAccepted;
}

async function onLegalCheckChange() {
  legalAccepted = legalCheck.checked;
  await chrome.storage.local.set({ [LEGAL_NOTICE_KEY]: legalAccepted });
  legalLabel.hidden = legalAccepted;
  if (legalAccepted) {
    clearError();
  }
}

function localizeDocument() {
  const language = chrome.i18n.getUILanguage();
  if (language) document.documentElement.lang = language;
  for (const element of document.querySelectorAll("[data-i18n]")) {
    const key = element.dataset.i18n;
    const translated = chrome.i18n.getMessage(key);
    if (translated) element.textContent = translated;
  }
}
