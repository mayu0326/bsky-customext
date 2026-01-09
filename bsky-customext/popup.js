// ポップアップを開いた時に現在の設定を表示する
chrome.storage.local.get(['handle', 'apppw'], (data) => {
  if (data.handle) document.getElementById('handle').value = data.handle;
  if (data.apppw) document.getElementById('apppw').value = data.apppw;
});

// popup.js の保存処理を修正
document.getElementById('save').onclick = () => {
  const handle = document.getElementById('handle').value;
  const apppw = document.getElementById('apppw').value;

  // sessionData だけでなく、古い情報を一度すべてクリアしてから保存
  chrome.storage.local.clear(() => {
    chrome.storage.local.set({ handle, apppw }, () => {
      document.getElementById('status').innerText = '設定を更新しました。ページを再読み込みしてください。';
      document.getElementById('status').style.color = 'green';
    });
  });
};

document.getElementById('logout').onclick = () => {
  // すべてのデータを削除
  chrome.storage.local.clear(() => {
    document.getElementById('handle').value = '';
    document.getElementById('apppw').value = '';
    document.getElementById('status').innerText = '完全にログアウトしました。';
  });
};