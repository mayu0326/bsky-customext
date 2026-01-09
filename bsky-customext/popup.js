document.getElementById('save').onclick = () => {
  const handle = document.getElementById('handle').value;
  const apppw = document.getElementById('apppw').value;
  chrome.storage.local.set({ handle, apppw }, () => {
    document.getElementById('status').innerText = '保存しました！';
  });
};