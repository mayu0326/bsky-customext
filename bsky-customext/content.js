// Blueskyセッションを再利用＋必要ならrefreshする
async function getValidSession() {
  const { handle, apppw, sessionData } = await chrome.storage.local.get([
    "handle",
    "apppw",
    "sessionData",
  ]);

  // 設定がまだならログインUIへ
  if (!handle || !apppw) {
    alert("BlueskyのハンドルとApp Passwordを拡張機能の設定で入力してください。");
    return null;
  }

  // 既存セッションがあればまず使う
  if (sessionData && sessionData.accessJwt && sessionData.refreshJwt) {
    // ここでは一旦そのまま使う（本気でやるなら exp を見て期限チェック）
    return sessionData;
  }

  // セッションが無い or 不完全 → 新規ログイン
  const newSession = await createNewSession(handle, apppw);
  if (!newSession) {
    alert("Blueskyへのログインに失敗しました。ハンドル名とApp Passwordを確認してください。");
    return null;
  }
  await chrome.storage.local.set({ sessionData: newSession });
  return newSession;
}

// 新しいセッションを作成
async function createNewSession(handle, apppw) {
  try {
    const res = await fetch(
      "https://bsky.social/xrpc/com.atproto.server.createSession",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: handle, password: apppw }),
      }
    );

    if (!res.ok) {
      console.error("createSession failed", await res.text());
      return null;
    }

    const session = await res.json();
    // session には accessJwt / refreshJwt / did などが入っている想定
    return session;
  } catch (e) {
    console.error("createSession error", e);
    return null;
  }
}

// 401などで失敗したときに呼ぶ用（必要なら後で使う）
async function refreshSessionIfNeeded(sessionData) {
  try {
    const res = await fetch(
      "https://bsky.social/xrpc/com.atproto.server.refreshSession",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionData.refreshJwt}`,
        },
      }
    );

    if (!res.ok) {
      console.error("refreshSession failed", await res.text());
      return null;
    }

    const newSession = await res.json();
    await chrome.storage.local.set({ sessionData: newSession });
    return newSession;
  } catch (e) {
    console.error("refreshSession error", e);
    return null;
  }
}

// 相手の状態（フォロー中か等）を取得する
async function getProfile(targetHandle, session) {
  const res = await fetch(`https://bsky.social/xrpc/app.bsky.actor.getProfile?actor=${targetHandle}`, {
    headers: { 'Authorization': `Bearer ${session.accessJwt}` }
  });
  return res.ok ? await res.json() : null;
}

// 自分が作成したリスト一覧を取得する
async function getMyLists(session) {
  const res = await fetch(`https://bsky.social/xrpc/app.bsky.graph.getLists?actor=${session.did}`, {
    headers: { 'Authorization': `Bearer ${session.accessJwt}` }
  });
  return res.ok ? await res.json() : { lists: [] };
}

// リストにユーザーを追加する
async function addToList(session, targetDid, listUri) {
  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.accessJwt}`
    },
    body: JSON.stringify({
      repo: session.did,
      collection: 'app.bsky.graph.listitem',
      record: {
        subject: targetDid,
        list: listUri,
        createdAt: new Date().toISOString()
      }
    })
  });
  return res.ok;
}

// レコード作成 (フォロー・ブロック共通)
async function createRecord(session, targetDid, collection) {
  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.accessJwt}`
    },
    body: JSON.stringify({
      repo: session.did,
      collection: collection,
      record: { subject: targetDid, createdAt: new Date().toISOString() }
    })
  });
  return res.ok;
}

// レコード削除 (フォロー解除など)
async function deleteRecord(session, uri) {
  // at://did/collection/rkey という形式なので分解する
  const [,, collection, rkey] = uri.split('/');
  const res = await fetch('https://bsky.social/xrpc/com.atproto.repo.deleteRecord', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.accessJwt}`
    },
    body: JSON.stringify({
      repo: session.did,
      collection: collection,
      rkey: rkey
    })
  });
  return res.ok;
}

// リストにそのユーザーが含まれているかチェックする関数
async function checkMembership(session, listUri, targetDid) {
  try {
    const res = await fetch(`https://bsky.social/xrpc/app.bsky.graph.getList?list=${listUri}&limit=100`, {
      headers: { 'Authorization': `Bearer ${session.accessJwt}` }
    });
    if (!res.ok) return false;
    const data = await res.json();
    // メンバーの中にtargetDid（相手のID）がいるか確認
    return data.items.some(item => item.subject.did === targetDid);
  } catch (e) {
    return false;
  }
}

// ダークモード判定：Blueskyの背景色からテーマを決める
function getTheme() {
  const bgColor = window.getComputedStyle(document.body).backgroundColor;
  const rgb = bgColor.match(/\d+/g);
  if (rgb && (parseInt(rgb[0]) + parseInt(rgb[1]) + parseInt(rgb[2]) < 380)) {
    return 'dark';
  }
  return 'light';
}

// メニューを表示するメイン関数（フォロー／解除・ブロック・リスト追加＋所属チェック対応）
async function showMenu(e, handle) {
  e.preventDefault();
  e.stopPropagation();

  const session = await getValidSession();
  if (!session) return;

  const profile = await getProfile(handle, session);
  if (!profile) {
    alert('プロフィール情報の取得に失敗しました');
    return;
  }

  // 1. 自分のリスト一覧を取得
  const { lists } = await getMyLists(session);
  const theme = getTheme();

  const oldMenu = document.getElementById('bsky-quick-menu');
  if (oldMenu) oldMenu.remove();

  const menu = document.createElement('div');
  menu.id = 'bsky-quick-menu';
  menu.className = `bsky-theme-${theme}`;
  menu.style.position = 'absolute';
  menu.style.top = `${e.pageY}px`;
  menu.style.left = `${e.pageX}px`;
  menu.style.zIndex = 9999;

  const isFollowing = !!profile.viewer?.following;

  let menuHtml = `
    <div class="menu-item" data-action="follow" data-uri="${profile.viewer?.following || ''}">
      ${isFollowing ? '✅ フォロー解除' : '👤 フォローする'}
    </div>
    <div class="menu-item" data-action="block">🚫 ブロックする</div>
    <hr class="menu-divider">
    <div class="menu-label">リストに追加:</div>
    <div id="list-container">読み込み中...</div>
  `;

  menu.innerHTML = menuHtml;
  document.body.appendChild(menu);

  // 2. 各リストへの追加状況を非同期でチェックして表示
  const listContainer = menu.querySelector('#list-container');
  let listItemsHtml = '';

  if (!lists || lists.length === 0) {
    listItemsHtml = `<div class="menu-item-disabled">リストなし</div>`;
  } else {
    // 全てのリストに対して所属チェックを並列で実行
    const checks = lists.map(async (list) => {
      const isMember = await checkMembership(session, list.uri, profile.did);
      return { ...list, isMember };
    });

    const results = await Promise.all(checks);
    
    results.forEach(list => {
      if (list.isMember) {
        listItemsHtml += `<div class="menu-item-disabled">✅ ${list.name} (追加済み)</div>`;
      } else {
        listItemsHtml += `<div class="menu-item list-add" data-list-uri="${list.uri}">📁 ${list.name}</div>`;
      }
    });
  }
  listContainer.innerHTML = listItemsHtml;

  // 3. リスト追加用クリックイベント
  menu.querySelectorAll('.list-add').forEach(item => {
    item.onclick = async () => {
      const listUri = item.getAttribute('data-list-uri');
      item.innerText = '追加中...';
      const success = await addToList(session, profile.did, listUri);
      if (success) {
        item.innerText = '✅ 追加しました';
        setTimeout(() => menu.remove(), 500);
      } else {
        alert('追加に失敗しました');
      }
    };
  });

  // 4. フォロー・ブロックのクリックイベント
  menu.querySelectorAll('.menu-item[data-action]').forEach(item => {
    item.onclick = async () => {
      const action = item.getAttribute('data-action');
      item.innerText = '処理中...';
      if (action === 'follow') {
        if (isFollowing) {
          const uri = item.getAttribute('data-uri');
          if (uri) {
            const ok = await deleteRecord(session, uri);
            if (ok) alert('フォローを解除しました');
          } else {
            alert('フォロー解除用の情報が取得できませんでした');
          }
        } else {
          const ok = await createRecord(session, profile.did, 'app.bsky.graph.follow');
          if (ok) alert('フォローしました');
        }
      } else if (action === 'block') {
        if (confirm(`@${handle} をブロックしますか？`)) {
          const ok = await createRecord(session, profile.did, 'app.bsky.graph.block');
          if (ok) alert('ブロックしました');
        }
      }
      menu.remove();
    };
  });

  // 外クリックで閉じる
  setTimeout(() => {
    window.onclick = () => {
      menu.remove();
      window.onclick = null;
    };
  }, 10);
}

// すでにボタンを付けたハンドルを記録
const seenHandles = new Set();

function injectButtons() {
  const path = location.pathname;
  if (path.startsWith('/notifications')) return;

  const main = document.querySelector('main, [role="main"]');
  if (!main) return;

  // --- 1. タイムライン・詳細画面の処理 (投稿ごとに1つだけ付ける) ---
  // feedItem (タイムライン) または postThreadItem (詳細) を探す
  const postContainers = main.querySelectorAll('div[data-testid^="feedItem-"]:not(.bsky-quick-processed), div[data-testid^="postThreadItem-"]:not(.bsky-quick-processed)');
  
  postContainers.forEach(container => {
    container.classList.add('bsky-quick-processed');

    // 投稿者情報が含まれるエリアから、最初の「テキストがあるリンク」を探す
    // (アイコン画像だけのリンクはスキップするため innerText を確認)
    const allLinks = Array.from(container.querySelectorAll('a[href^="/profile/"]'));
    const targetLink = allLinks.find(link => link.innerText.trim().length > 0);

    if (targetLink) {
      addBtn(targetLink);
    }
  });

  // --- 2. DM（メッセージ）画面の処理 ---
  if (path.startsWith("/messages")) {
    const dmLinks = main.querySelectorAll('a[href^="/profile/"]:not(.bsky-quick-added)');
    dmLinks.forEach(link => {
      // DM画面の青いハンドル名リンクに反応させる
      if (link.innerText.trim().startsWith('@')) {
        addBtn(link);
      } else {
        // それ以外（アイコン等）は処理済みにして無視
        link.classList.add('bsky-quick-added');
      }
    });
  }
}

// ボタンを追加する補助関数
function addBtn(link) {
  // 二重付与防止
  if (link.classList.contains('bsky-quick-added') || 
      (link.nextSibling && link.nextSibling.classList && link.nextSibling.classList.contains('quick-action-btn'))) {
    return;
  }

  const href = link.getAttribute('href');
  if (!href) return;
  const handle = href.replace('/profile/', '');

  link.classList.add('bsky-quick-added');
  
  const btn = document.createElement('span');
  btn.innerText = ' 🦋';
  btn.className = 'quick-action-btn';
  btn.style.cursor = 'pointer';
  btn.style.color = '#0085ff';
  btn.style.marginLeft = '4px';
  btn.style.fontWeight = 'bold';
  
  btn.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e, handle);
  };

  link.parentNode.insertBefore(btn, link.nextSibling);
}

// 監視設定
const observer = new MutationObserver(injectButtons);
observer.observe(document.body, { childList: true, subtree: true });
injectButtons();