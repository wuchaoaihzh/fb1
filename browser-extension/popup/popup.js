function refreshStatus() {
  chrome.runtime.sendMessage({ type: "get_status" }, (response) => {
    const status = document.getElementById("status");
    if (response?.connected) {
      status.textContent = "已连接";
      status.classList.add("online");
    } else {
      status.textContent = "未连接";
      status.classList.remove("online");
    }
  });
}

document.getElementById("collect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "collect_current_tab" }, refreshStatus);
});

document.getElementById("test").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "send_test_post" }, refreshStatus);
});

refreshStatus();
setInterval(refreshStatus, 1500);
