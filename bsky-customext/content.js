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

// ユーザー名の要素にボタンを追加する
function injectButtons() {
  const path = location.pathname;

  // 通知ページでは何もしない
  if (path.startsWith('/notifications')) return;

  const main = document.querySelector('main, [role="main"]');
  if (!main) return;

  // --- 投稿詳細ページ: /profile/xxx/post/yyy のとき ---
if (path.startsWith('/profile/') && path.includes('/post/')) {
  const threadItems = main.querySelectorAll('div[data-testid^="postThreadItem-"]:not(.bsky-quick-processed)');
  if (!threadItems.length) return;

  threadItems.forEach(item => {
    item.classList.add('bsky-quick-processed');

    // そのスレッドアイテム内の /profile/ リンクを全部取る
    const allProfileLinks = Array.from(item.querySelectorAll('a[href^="/profile/"]'));
    if (allProfileLinks.length === 0) return;

    // 0番目はアイコンのリンクであることが多いので、1番目を優先して使う
    let targetLink = allProfileLinks[1] || allProfileLinks[0];

    // すでにボタンが付いていたらスキップ
    if (targetLink.nextSibling && targetLink.nextSibling.classList &&
        targetLink.nextSibling.classList.contains('quick-action-btn')) {
      return;
    }

    const href = targetLink.getAttribute('href');
    if (!href) {
      targetLink.classList.add('bsky-quick-added');
      return;
    }

    const handle = href.replace('/profile/', '');

    targetLink.classList.add('bsky-quick-added');

    const btn = document.createElement('span');
    btn.innerText = ' 🦋';
    btn.className = 'quick-action-btn';
    btn.style.cursor = 'pointer';
    btn.style.color = '#0085ff';
    btn.title = 'クイックアクション';

    btn.onclick = (e) => showMenu(e, handle);

    targetLink.parentNode.insertBefore(btn, targetLink.nextSibling);
  });

  return;
}


  // --- タイムライン（ホームなど） ---
  const posts = main.querySelectorAll('div[data-testid^="feedItem-"]:not(.bsky-quick-processed)');

  posts.forEach(post => {
    post.classList.add('bsky-quick-processed');

    // 「名前＋@handle」の行を探す（align-items: flex-end を含む行）
    const nameRow = post.querySelector('div[style*="align-items: flex-end"]');
    if (!nameRow) return;

    // その行の中の /profile/ リンク（通常は表示名側）をターゲットにする
    const link = nameRow.querySelector('a[href^="/profile/"]:not(.bsky-quick-added)');
    if (!link) return;

    const href = link.getAttribute('href');
    if (!href) {
      link.classList.add('bsky-quick-added');
      return;
    }

    const handle = href.replace('/profile/', '');

    // すでにすぐ後ろにボタンがあるなら付けない
    if (link.nextSibling && link.nextSibling.classList &&
        link.nextSibling.classList.contains('quick-action-btn')) {
      return;
    }

    link.classList.add('bsky-quick-added');

    const btn = document.createElement('span');
    btn.innerText = ' 🦋';
    btn.className = 'quick-action-btn';
    btn.style.cursor = 'pointer';
    btn.style.color = '#0085ff';
    btn.title = 'クイックアクション';

    btn.onclick = (e) => showMenu(e, handle);

    link.parentNode.insertBefore(btn, link.nextSibling);
  });
}


// 画面の更新を監視（無限スクロール対応）
const observer = new MutationObserver(injectButtons);
observer.observe(document.body, { childList: true, subtree: true });

injectButtons();
