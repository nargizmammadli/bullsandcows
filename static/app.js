// Cows & Bulls — frontend WebSocket client and UI controller.
(function () {
  "use strict";

  // ---- Game state -------------------------------------------------------
  const state = {
    ws: null,
    roomCode: null,
    role: null,        // "A" or "B"
    token: null,       // secret handle used to rejoin after a drop
    digitLength: 4,
    turn: null,        // "A" | "B" | null — last known whose-turn
    myTurn: false,
    gameOver: false,
    mySecret: null,    // our own secret, kept locally to display to ourselves
    mode: "friend",    // "friend" (online) or "computer" (local single-player)
    opponentLabel: "Opponent",
    // Computer-mode only:
    cpuSecret: null,        // the secret the player must guess
    cpuCandidates: [],      // remaining hypotheses for the player's secret
    cpuGuessResults: [],    // [{guess, full, half}] the computer has received
  };

  // Whether our own secret is currently revealed (vs blurred).
  let secretRevealed = false;

  // History filter: "both" or "mine".
  let historyFilter = "both";

  // ---- Session persistence (for reconnect) ------------------------------
  const SESSION_KEY = "cb_session";
  function saveSession() {
    if (state.roomCode && state.role && state.token) {
      try {
        localStorage.setItem(
          SESSION_KEY,
          JSON.stringify({
            roomCode: state.roomCode,
            role: state.role,
            token: state.token,
            digitLength: state.digitLength,
            secret: state.mySecret,
          })
        );
      } catch {}
    }
  }
  function loadSession() {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }
  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {}
  }

  // ---- Element helpers --------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const screens = {
    home: $("screen-home"),
    lobby: $("screen-lobby"),
    secret: $("screen-secret"),
    game: $("screen-game"),
    over: $("screen-over"),
  };

  function showScreen(name) {
    Object.values(screens).forEach((s) => s.classList.add("hidden"));
    screens[name].classList.remove("hidden");
    // The "New Game" button is available everywhere except the home screen.
    $("btn-home").classList.toggle("hidden", name === "home");
    if (name === "home") resetHomeView();
  }

  // Reset the home screen back to the mode chooser.
  function resetHomeView() {
    $("mode-select").classList.remove("hidden");
    $("mode-computer").classList.add("hidden");
    $("mode-friend").classList.add("hidden");
  }

  function showBanner(text, kind) {
    const b = $("banner");
    b.textContent = text;
    b.className = "banner " + (kind || "warn");
  }
  function hideBanner() {
    $("banner").className = "banner hidden";
  }

  // ---- Digit box builder ------------------------------------------------
  // Builds `length` single-digit inputs into `container` with auto-advance,
  // backspace handling, and digit-only filtering. Returns a read() function.
  function buildDigitBoxes(container, length, onEnter) {
    container.innerHTML = "";
    const inputs = [];
    for (let i = 0; i < length; i++) {
      const inp = document.createElement("input");
      inp.type = "text";
      inp.inputMode = "numeric";
      inp.maxLength = 1;
      inp.autocomplete = "off";
      inp.addEventListener("input", () => {
        inp.value = inp.value.replace(/[^0-9]/g, "").slice(0, 1);
        if (inp.value && i < length - 1) inputs[i + 1].focus();
      });
      inp.addEventListener("keydown", (e) => {
        if (e.key === "Backspace" && !inp.value && i > 0) {
          inputs[i - 1].focus();
        } else if (e.key === "Enter" && onEnter) {
          onEnter();
        }
      });
      inputs.push(inp);
      container.appendChild(inp);
    }
    if (inputs[0]) setTimeout(() => inputs[0].focus(), 50);
    return {
      read: () => inputs.map((i) => i.value).join(""),
      clear: () => {
        inputs.forEach((i) => (i.value = ""));
        if (inputs[0]) inputs[0].focus();
      },
    };
  }

  // ---- Client-side validation -------------------------------------------
  function validate(value, length) {
    if (value.length !== length) return `Enter all ${length} digits.`;
    if (!/^[0-9]+$/.test(value)) return "Digits only.";
    if (new Set(value).size !== length) return "Digits must all be unique.";
    return null;
  }

  // ---- Computer opponent (local, no server) ----------------------------
  // Same full/half scoring as the server, used purely client-side.
  function computeScore(secret, guess) {
    let full = 0;
    let half = 0;
    for (let i = 0; i < secret.length; i++) {
      if (guess[i] === secret[i]) full++;
      else if (secret.indexOf(guess[i]) !== -1) half++;
    }
    return { full, half };
  }

  // A random secret of unique digits.
  function randomSecret(len) {
    const digits = "0123456789".split("");
    for (let i = digits.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [digits[i], digits[j]] = [digits[j], digits[i]];
    }
    return digits.slice(0, len).join("");
  }

  // Candidate hypotheses for the player's secret. Enumerate fully when the
  // space is small; otherwise sample, to keep memory bounded for big lengths.
  function buildCpuCandidates(len) {
    let total = 1;
    for (let i = 0; i < len; i++) total *= 10 - i;
    if (total <= 200000) {
      const out = [];
      const digits = "0123456789".split("");
      const used = new Array(10).fill(false);
      const cur = [];
      (function rec() {
        if (cur.length === len) {
          out.push(cur.join(""));
          return;
        }
        for (let d = 0; d < 10; d++) {
          if (!used[d]) {
            used[d] = true;
            cur.push(digits[d]);
            rec();
            cur.pop();
            used[d] = false;
          }
        }
      })();
      return out;
    }
    const set = new Set();
    while (set.size < 4000) set.add(randomSecret(len));
    return [...set];
  }

  // Is candidate c consistent with every result the computer has seen?
  function consistent(c, results) {
    return results.every((r) => {
      const sc = computeScore(c, r.guess);
      return sc.full === r.full && sc.half === r.half;
    });
  }

  // Pick the computer's next guess: narrow the pool to consistent hypotheses
  // and play one of them (a valid candidate is itself a strong guess).
  function cpuMakeGuess() {
    let pool = state.cpuCandidates.filter((c) => consistent(c, state.cpuGuessResults));
    if (pool.length === 0) {
      // Pool exhausted (sampled mode) — resample some consistent candidates.
      const seen = new Set();
      pool = [];
      for (let t = 0; t < 6000 && pool.length < 300; t++) {
        const c = randomSecret(state.digitLength);
        if (seen.has(c)) continue;
        seen.add(c);
        if (consistent(c, state.cpuGuessResults)) pool.push(c);
      }
    }
    if (pool.length) state.cpuCandidates = pool;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)]
                       : randomSecret(state.digitLength);
  }

  // Run the computer's turn after a short, human-feeling delay.
  function scheduleCpuTurn() {
    setTimeout(() => {
      if (state.mode !== "computer" || state.gameOver) return;
      if (screens.game.classList.contains("hidden")) return;
      const guess = cpuMakeGuess();
      const sc = computeScore(state.mySecret, guess);
      state.cpuGuessResults.push({ guess, full: sc.full, half: sc.half });
      addHistoryRow("B", guess, sc.full, sc.half);
      if (sc.full === state.digitLength) {
        endGame("B", guess);
        return;
      }
      setTurn("A");
    }, 700);
  }

  // Begin a fresh computer game: the computer rolls a secret for the player to
  // crack, and prepares to guess the player's secret.
  function startComputerGame(len) {
    // Drop any leftover online-session state so it can't auto-rejoin later.
    clearSession();
    state.roomCode = null;
    state.token = null;
    state.mode = "computer";
    state.role = "A";
    state.opponentLabel = "Computer";
    state.digitLength = len;
    state.cpuSecret = randomSecret(len);
    state.cpuCandidates = buildCpuCandidates(len);
    state.cpuGuessResults = [];
    state.mySecret = null;
    state.gameOver = false;
    goToSetSecret();
  }

  // ---- WebSocket + reconnection ----------------------------------------
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let intentionalClose = false; // set when the user deliberately leaves a game

  function connect() {
    intentionalClose = false;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
    ws.addEventListener("open", () => {
      reconnectAttempts = 0;
    });
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleMessage(msg);
    });
    ws.addEventListener("close", () => {
      // Only this socket's close matters; if it's already been replaced, skip.
      if (state.ws !== ws) return;
      if (intentionalClose) return; // user left the game on purpose
      if (loadSession()) {
        scheduleReconnect();
      } else if (!state.gameOver) {
        showBanner("Connection lost. Refresh to start over.", "error");
      }
    });
    return ws;
  }

  // Open a fresh socket and immediately ask to rejoin the saved room.
  function doReconnect() {
    const sess = loadSession();
    if (!sess) return;
    connect();
    sendWhenReady({
      type: "rejoin",
      room_code: sess.roomCode,
      role: sess.role,
      token: sess.token,
    });
  }

  // Backoff-based retry, driven by socket "close" events.
  function scheduleReconnect() {
    if (reconnectTimer) return;
    showBanner("Connection lost — reconnecting…", "warn");
    const delay = Math.min(800 * Math.pow(1.7, reconnectAttempts), 5000);
    reconnectAttempts++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      doReconnect();
    }, delay);
  }

  // Immediate reconnect when the user returns to the tab / regains network.
  function attemptReconnectNow() {
    const sess = loadSession();
    if (!sess) return;
    const ws = state.ws;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempts = 0;
    doReconnect();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") attemptReconnectNow();
  });
  window.addEventListener("online", attemptReconnectNow);
  window.addEventListener("focus", attemptReconnectNow);

  function sendWhenReady(message) {
    const ws = state.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    } else if (ws) {
      ws.addEventListener("open", () => ws.send(JSON.stringify(message)), {
        once: true,
      });
    }
  }

  // ---- Message handling -------------------------------------------------
  function handleMessage(msg) {
    switch (msg.type) {
      case "room_created":
        state.roomCode = msg.room_code;
        state.role = msg.player_role || "A";
        state.token = msg.token;
        saveSession();
        $("lobby-roomcode").textContent = msg.room_code;
        $("lobby-status").textContent = "Waiting for an opponent to join…";
        showScreen("lobby");
        break;

      case "waiting_for_opponent":
        // Already shown via room_created; no-op for the creator.
        break;

      case "joined_room":
        state.roomCode = msg.room_code;
        state.role = msg.player_role;
        state.token = msg.token;
        state.digitLength = msg.digit_length;
        saveSession();
        goToSetSecret();
        break;

      case "state_sync": {
        // Reconnected — rebuild the UI to match the server's truth.
        state.roomCode = msg.room_code;
        state.role = msg.role;
        state.digitLength = msg.digit_length;
        // The server never echoes our secret; restore it from local storage so
        // we can keep showing it to ourselves.
        const sess = loadSession();
        if (sess && sess.secret) state.mySecret = sess.secret;
        saveSession();
        hideBanner();
        rebuildFromState(msg);
        break;
      }

      case "rejoin_failed":
        // Room is gone (server restarted, or abandoned too long).
        clearSession();
        hideBanner();
        showBanner("Your previous game is no longer available.", "warn");
        showScreen("home");
        break;

      case "opponent_reconnected":
        hideBanner();
        if (!screens.game.classList.contains("hidden")) setTurn(state.turn);
        break;

      case "opponent_joined":
        // Creator's opponent arrived — move both to secret entry.
        goToSetSecret();
        break;

      case "game_start":
        startGame(msg.first_turn);
        break;

      case "guess_result":
        addHistoryRow(msg.player, msg.guess, msg.full, msg.half);
        // Clear the input only once OUR guess has been accepted.
        if (msg.player === state.role && state.guessBoxes) state.guessBoxes.clear();
        setTurn(msg.next_turn);
        break;

      case "game_over":
        // A winning guess is an exact match: full == length, half == 0.
        addHistoryRow(
          msg.winner,
          msg.winning_guess,
          msg.winning_guess.length,
          0
        );
        endGame(msg.winner, msg.winning_guess);
        break;

      case "room_reset":
        if (msg.digit_length) state.digitLength = msg.digit_length;
        state.mySecret = null;
        saveSession();
        resetForReplay();
        break;

      case "opponent_disconnected":
        // Show a notice, but DO NOT disable your input — you can still make
        // your move; it'll be waiting for them when they reconnect.
        showBanner("Your opponent disconnected — they can rejoin anytime.", "warn");
        break;

      case "opponent_left":
        // Opponent hit "New Game" — send us home automatically too.
        clearSession();
        resetToHome();
        showBanner("Your opponent left the game.", "warn");
        break;

      case "error":
        showError(msg.message);
        break;
    }
  }

  // ---- Screen transitions ----------------------------------------------
  function goToSetSecret() {
    hideBanner();
    $("secret-length").textContent = state.digitLength;
    $("secret-status").classList.add("hidden");
    $("secret-error").classList.add("hidden");
    $("btn-set-secret").disabled = false;
    state.secretBoxes = buildDigitBoxes(
      $("secret-boxes"),
      state.digitLength,
      submitSecret
    );
    showScreen("secret");
  }

  function startGame(firstTurn) {
    state.gameOver = false;
    $("history").innerHTML = "";
    renderHistoryEmpty($("history"));
    state.guessBoxes = buildDigitBoxes(
      $("guess-boxes"),
      state.digitLength,
      submitGuess
    );
    secretRevealed = false;
    renderMySecret();
    setTurn(firstTurn);
    showScreen("game");
  }

  function setTurn(turn) {
    state.turn = turn;
    state.myTurn = turn === state.role;
    const banner = $("turn-banner");
    const card = $("guess-card");
    if (state.myTurn) {
      banner.textContent = "Your turn — make a guess!";
      banner.className = "turn-banner my-turn";
      card.classList.remove("disabled");
      $("btn-guess").disabled = false;
      // NOTE: do not clear the guess input here — setTurn runs on reconnect
      // too, and clearing would wipe what the player is mid-typing. The input
      // is cleared explicitly after a guess of ours is accepted instead.
    } else {
      banner.textContent =
        state.mode === "computer"
          ? "Computer is thinking…"
          : "Opponent's turn — waiting…";
      banner.className = "turn-banner their-turn";
      card.classList.add("disabled");
      $("btn-guess").disabled = true;
    }
  }

  function endGame(winner, winningGuess) {
    state.gameOver = true;
    const won = winner === state.role;
    const headline = $("over-headline");
    headline.textContent = won ? "🎉 You Win!" : "You Lose";
    headline.className = won ? "win" : "lose";
    $("over-detail").textContent = won
      ? `You cracked the secret: ${winningGuess}`
      : `${state.opponentLabel} guessed your secret: ${winningGuess}`;
    // Copy the live history into the game-over screen.
    $("history-over").innerHTML = $("history").innerHTML;
    $("btn-play-again").disabled = false;
    $("play-again-status").classList.add("hidden");
    // Default the next-round length selector to the current length.
    $("replay-length").value = String(state.digitLength);
    showScreen("over");
  }

  function resetForReplay() {
    hideBanner();
    state.gameOver = false;
    $("history").innerHTML = "";
    $("history-over").innerHTML = "";
    goToSetSecret();
  }

  // Tear down all game state and show the home screen.
  function resetToHome() {
    clearSession();
    intentionalClose = true;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (state.ws) {
      try { state.ws.close(); } catch {}
    }
    state.ws = null;
    state.roomCode = null;
    state.role = null;
    state.token = null;
    state.turn = null;
    state.myTurn = false;
    state.gameOver = false;
    state.mySecret = null;
    state.secretBoxes = null;
    state.guessBoxes = null;
    secretRevealed = false;

    hideBanner();
    $("history").innerHTML = "";
    $("history-over").innerHTML = "";
    $("join-code").value = "";
    showScreen("home");
  }

  // Leave the current game via the "New Game" button. Tells the opponent so
  // they're sent home too, then returns us home to start fresh.
  function goHome() {
    const inProgress = !screens.game.classList.contains("hidden") && !state.gameOver;
    if (inProgress && !confirm("Leave this game and start a new one?")) return;
    sendWhenReady({ type: "leave_room" });
    resetToHome();
  }

  // Rebuild the UI from a server snapshot after a reconnect. Crucially this is
  // non-destructive: if we're already on the correct screen we preserve any
  // input the player is mid-typing rather than rebuilding the boxes.
  function rebuildFromState(s) {
    state.gameOver = s.over;
    const onSecret = !screens.secret.classList.contains("hidden");
    const onGame = !screens.game.classList.contains("hidden");

    // Lobby: room created but opponent never arrived.
    if (!s.started && !s.over && !s.opponent_present) {
      $("lobby-roomcode").textContent = state.roomCode;
      $("lobby-status").textContent = "Waiting for an opponent to join…";
      showScreen("lobby");
      return;
    }

    // Secret-setting phase.
    if (!s.started && !s.over) {
      // Only build the boxes if we're not already entering a secret — otherwise
      // we'd wipe what the player is typing.
      if (!onSecret || !state.secretBoxes) goToSetSecret();
      if (s.you_secret_set) {
        // Already locked in (we don't keep the secret in the boxes) — just wait.
        if (state.secretBoxes) state.secretBoxes.clear();
        $("btn-set-secret").disabled = true;
        $("secret-status").classList.remove("hidden");
      }
      if (!s.opponent_connected) {
        showBanner("Opponent disconnected — waiting for them to return…", "warn");
      }
      return;
    }

    // Game in progress (or finished). Preserve the guess input if we're already
    // on the board; only build boxes when arriving fresh (e.g. a page reload).
    if (!onGame || !state.guessBoxes) {
      state.guessBoxes = buildDigitBoxes($("guess-boxes"), state.digitLength, submitGuess);
    }
    renderHistory(s.history);
    renderMySecret();

    if (s.over) {
      endGame(s.winner, s.winning_guess);
    } else {
      setTurn(s.turn);
      showScreen("game");
      if (!s.opponent_connected) {
        // Notice only — never disable the input (you can still take your turn).
        showBanner("Your opponent disconnected — they can rejoin anytime.", "warn");
      }
    }
  }

  // Render a full history array (oldest first; addHistoryRow puts newest on top).
  function renderHistory(historyArr) {
    $("history").innerHTML = "";
    if (!historyArr || historyArr.length === 0) {
      renderHistoryEmpty($("history"));
      return;
    }
    historyArr.forEach((h) => addHistoryRow(h.player, h.guess, h.full, h.half));
  }

  // Toggle between showing only your guesses and both players' guesses.
  function applyHistoryFilter(f) {
    historyFilter = f;
    ["history", "history-over"].forEach((id) => {
      const c = $(id);
      if (!c) return;
      c.classList.toggle("filter-mine", f === "mine");
    });
    document.querySelectorAll(".history-filter button").forEach((b) => {
      b.classList.toggle("active", b.dataset.filter === f);
    });
  }

  // ---- History rendering ------------------------------------------------
  function renderHistoryEmpty(container) {
    container.innerHTML =
      '<div class="history-empty">No guesses yet.</div>';
  }

  function addHistoryRow(player, guess, full, half) {
    const container = $("history");
    const empty = container.querySelector(".history-empty");
    if (empty) empty.remove();

    const isYou = player === state.role;

    const row = document.createElement("div");
    row.className = "history-row " + (isYou ? "mine" : "theirs");

    const who = document.createElement("span");
    who.className = "history-who" + (isYou ? " you" : "");
    who.textContent = isYou ? "You" : state.opponentLabel;
    row.appendChild(who);

    // Plain digits — never colored. Coloring would leak which positions are
    // correct, which is exactly what this game must not reveal.
    const digits = document.createElement("div");
    digits.className = "history-digits";
    for (let i = 0; i < guess.length; i++) {
      const box = document.createElement("span");
      box.className = "dbox";
      box.textContent = guess[i];
      digits.appendChild(box);
    }
    row.appendChild(digits);

    // Aggregate score only: "N full, M half".
    const score = document.createElement("span");
    score.className = "history-score";
    score.innerHTML =
      `<strong>${full}</strong> full, <strong>${half}</strong> half`;
    row.appendChild(score);

    // Newest on top.
    container.insertBefore(row, container.firstChild);
  }

  // ---- Actions ----------------------------------------------------------
  function submitSecret() {
    const value = state.secretBoxes.read();
    const err = validate(value, state.digitLength);
    const errEl = $("secret-error");
    if (err) {
      errEl.textContent = err;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    // Remember our own secret locally so we can show it to ourselves later.
    state.mySecret = value;
    saveSession();
    if (state.mode === "computer") {
      // Local game — start immediately; player goes first.
      startGame("A");
      return;
    }
    $("btn-set-secret").disabled = true;
    $("secret-status").classList.remove("hidden");
    sendWhenReady({ type: "set_secret", secret: value });
  }

  // Render our own secret on the game board, blurred unless revealed.
  function renderMySecret() {
    const row = $("my-secret-row");
    const valEl = $("my-secret-value");
    if (!state.mySecret) {
      row.classList.add("hidden");
      return;
    }
    row.classList.remove("hidden");
    valEl.textContent = state.mySecret;
    valEl.classList.toggle("blurred", !secretRevealed);
    $("btn-toggle-secret").textContent = secretRevealed ? "Hide" : "Show";
  }

  function submitGuess() {
    if (!state.myTurn) return;
    const value = state.guessBoxes.read();
    const err = validate(value, state.digitLength);
    const errEl = $("guess-error");
    if (err) {
      errEl.textContent = err;
      errEl.classList.remove("hidden");
      return;
    }
    errEl.classList.add("hidden");
    if (state.mode === "computer") {
      // Score the player's guess against the computer's secret locally.
      state.guessBoxes.clear();
      const sc = computeScore(state.cpuSecret, value);
      addHistoryRow("A", value, sc.full, sc.half);
      if (sc.full === state.digitLength) {
        endGame("A", value);
        return;
      }
      setTurn("B");
      scheduleCpuTurn();
      return;
    }
    sendWhenReady({ type: "make_guess", guess: value });
  }

  function showError(message) {
    // Route validation errors to whichever screen is active.
    if (!screens.secret.classList.contains("hidden")) {
      const e = $("secret-error");
      e.textContent = message;
      e.classList.remove("hidden");
      $("btn-set-secret").disabled = false;
      $("secret-status").classList.add("hidden");
    } else if (!screens.game.classList.contains("hidden")) {
      const e = $("guess-error");
      e.textContent = message;
      e.classList.remove("hidden");
    } else {
      showBanner(message, "error");
    }
  }

  // ---- Wire up home + buttons -------------------------------------------
  $("btn-create").addEventListener("click", () => {
    state.mode = "friend";
    state.opponentLabel = "Opponent";
    state.digitLength = parseInt($("digit-length").value, 10);
    connect();
    sendWhenReady({ type: "create_room", digit_length: state.digitLength });
  });

  $("btn-join").addEventListener("click", () => {
    const code = $("join-code").value.trim().toUpperCase();
    if (!code) {
      showBanner("Enter a room code to join.", "error");
      return;
    }
    state.mode = "friend";
    state.opponentLabel = "Opponent";
    connect();
    sendWhenReady({ type: "join_room", room_code: code });
  });

  // Mode chooser
  $("btn-mode-computer").addEventListener("click", () => {
    $("mode-select").classList.add("hidden");
    $("mode-computer").classList.remove("hidden");
  });
  $("btn-mode-friend").addEventListener("click", () => {
    state.mode = "friend";
    state.opponentLabel = "Opponent";
    $("mode-select").classList.add("hidden");
    $("mode-friend").classList.remove("hidden");
  });
  document
    .querySelectorAll(".back-btn")
    .forEach((b) => b.addEventListener("click", resetHomeView));
  $("btn-start-cpu").addEventListener("click", () => {
    startComputerGame(parseInt($("cpu-digit-length").value, 10));
  });

  $("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-join").click();
  });

  $("btn-copy").addEventListener("click", () => {
    const code = state.roomCode || "";
    navigator.clipboard?.writeText(code).then(
      () => {
        const btn = $("btn-copy");
        const old = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => (btn.textContent = old), 1200);
      },
      () => {}
    );
  });

  $("btn-set-secret").addEventListener("click", submitSecret);
  $("btn-guess").addEventListener("click", submitGuess);
  $("btn-home").addEventListener("click", goHome);
  $("btn-toggle-secret").addEventListener("click", () => {
    secretRevealed = !secretRevealed;
    renderMySecret();
  });

  $("btn-play-again").addEventListener("click", () => {
    const dl = parseInt($("replay-length").value, 10) || state.digitLength;
    if (state.mode === "computer") {
      // Local replay — new computer secret, optionally a new length.
      $("history").innerHTML = "";
      $("history-over").innerHTML = "";
      startComputerGame(dl);
      return;
    }
    $("btn-play-again").disabled = true;
    $("play-again-status").classList.remove("hidden");
    sendWhenReady({ type: "play_again", digit_length: dl });
  });

  // History filter buttons (event delegation — works for both screens).
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".history-filter button");
    if (btn) applyHistoryFilter(btn.dataset.filter);
  });
  applyHistoryFilter("both");

  // ---- Startup ----------------------------------------------------------
  // A ?room=CODE link is meant for a *joining* friend — prefer the join flow
  // (and drop any stale session from a previous game on this device).
  const params = new URLSearchParams(location.search);
  const preRoom = params.get("room");
  if (preRoom) {
    clearSession();
    $("join-code").value = preRoom.toUpperCase();
    showScreen("home");
  } else if (loadSession()) {
    // Returning to an in-progress game (e.g. after a refresh) — try to rejoin.
    showBanner("Reconnecting to your game…", "warn");
    doReconnect();
  } else {
    showScreen("home");
  }
})();
