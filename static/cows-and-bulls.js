// Cows & Bulls — game controller, built on the shared Twoplay networking layer.
(function () {
  "use strict";

  const $ = Twoplay.$;
  const GAME_TYPE = "cows_and_bulls";

  // ---- Game state -------------------------------------------------------
  const state = {
    roomCode: null,
    role: null, // "A" | "B"
    token: null,
    digitLength: 4,
    turn: null,
    myTurn: false,
    gameOver: false,
    mySecret: null,
    mode: "friend", // "friend" (online) or "computer" (local single-player)
    opponentLabel: "Opponent",
    cpuSecret: null,
    secretBoxes: null,
    guessBoxes: null,
  };

  let secretRevealed = false;
  let historyFilter = "both";

  // ---- Shared networking ------------------------------------------------
  const net = Twoplay.createNet(GAME_TYPE, {
    onMessage: handleMessage,
    shouldReconnect: () => !state.gameOver,
    onReconnecting: () => Twoplay.banner("Connection lost — reconnecting…", "warn"),
    onConnectionLost: () => {
      if (!state.gameOver) Twoplay.banner("Connection lost. Refresh to start over.", "error");
    },
  });

  function saveSession() {
    if (state.roomCode && state.role && state.token) {
      net.saveSession({
        roomCode: state.roomCode,
        role: state.role,
        token: state.token,
        digitLength: state.digitLength,
        secret: state.mySecret,
      });
    }
  }

  // ---- Screens ----------------------------------------------------------
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
    // "New Game" (stay in this game) is available everywhere except home.
    $("btn-newgame").classList.toggle("hidden", name === "home");
    if (name === "home") resetHomeView();
  }

  function resetHomeView() {
    $("mode-select").classList.remove("hidden");
    $("mode-computer").classList.add("hidden");
    $("mode-friend").classList.add("hidden");
  }

  // ---- Digit box builder ------------------------------------------------
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
      fill: (value) => {
        inputs.forEach((inp, idx) => (inp.value = value[idx] || ""));
        if (inputs[inputs.length - 1]) inputs[inputs.length - 1].focus();
      },
    };
  }

  function validate(value, length) {
    if (value.length !== length) return `Enter all ${length} digits.`;
    if (!/^[0-9]+$/.test(value)) return "Digits only.";
    if (new Set(value).size !== length) return "Digits must all be unique.";
    return null;
  }

  // ---- Computer opponent (local, no server) ----------------------------
  function computeScore(secret, guess) {
    let full = 0;
    let half = 0;
    for (let i = 0; i < secret.length; i++) {
      if (guess[i] === secret[i]) full++;
      else if (secret.indexOf(guess[i]) !== -1) half++;
    }
    return { full, half };
  }

  function randomSecret(len) {
    const digits = "0123456789".split("");
    for (let i = digits.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [digits[i], digits[j]] = [digits[j], digits[i]];
    }
    return digits.slice(0, len).join("");
  }

  function startComputerGame(len) {
    net.clearSession();
    net.leave();
    state.roomCode = null;
    state.token = null;
    state.mode = "computer";
    state.role = "A";
    state.opponentLabel = "Computer";
    state.digitLength = len;
    state.cpuSecret = randomSecret(len);
    state.mySecret = null;
    state.gameOver = false;
    $("history").innerHTML = "";
    renderHistoryEmpty($("history"));
    state.guessBoxes = buildDigitBoxes($("guess-boxes"), len, submitGuess);
    $("my-secret-row").classList.add("hidden");
    document.querySelector("#screen-game .history-filter").classList.add("hidden");
    $("btn-give-up").classList.remove("hidden");
    setTurn("A");
    showScreen("game");
  }

  // ---- Message handling -------------------------------------------------
  function handleMessage(msg) {
    switch (msg.type) {
      case "room_created":
        state.roomCode = msg.room_code;
        state.role = msg.player_role || "A";
        state.token = msg.token;
        if (msg.digit_length) state.digitLength = msg.digit_length;
        saveSession();
        $("lobby-roomcode").textContent = msg.room_code;
        $("lobby-status").textContent = "Waiting for an opponent to join…";
        showScreen("lobby");
        break;

      case "waiting_for_opponent":
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
        state.roomCode = msg.room_code;
        state.role = msg.role;
        state.digitLength = msg.digit_length;
        const sess = net.loadSession();
        if (sess && sess.secret) state.mySecret = sess.secret;
        saveSession();
        Twoplay.hideBanner();
        rebuildFromState(msg);
        break;
      }

      case "rejoin_failed":
        net.clearSession();
        Twoplay.hideBanner();
        Twoplay.banner("Your previous game is no longer available.", "warn");
        showScreen("home");
        break;

      case "opponent_reconnected":
        Twoplay.hideBanner();
        if (!screens.game.classList.contains("hidden")) setTurn(state.turn);
        break;

      case "opponent_joined":
        goToSetSecret();
        break;

      case "game_start":
        startGame(msg.first_turn);
        break;

      case "guess_result":
        addHistoryRow(msg.player, msg.guess, msg.full, msg.half);
        if (msg.player === state.role && state.guessBoxes) state.guessBoxes.clear();
        setTurn(msg.next_turn);
        break;

      case "game_over": {
        addHistoryRow(msg.winner, msg.winning_guess, msg.winning_guess.length, 0);
        const oppRole = state.role === "A" ? "B" : "A";
        const revealed = msg.secrets ? msg.secrets[oppRole] : null;
        endGame(msg.winner, msg.winning_guess, revealed);
        break;
      }

      case "room_reset":
        if (msg.digit_length) state.digitLength = msg.digit_length;
        state.mySecret = null;
        saveSession();
        resetForReplay();
        break;

      case "opponent_disconnected":
        Twoplay.banner("Your opponent disconnected — they can rejoin anytime.", "warn");
        break;

      case "opponent_left":
        net.clearSession();
        resetToGameHome();
        Twoplay.banner("Your opponent left the game.", "warn");
        break;

      case "error":
        showError(msg.message);
        break;
    }
  }

  // ---- Screen transitions ----------------------------------------------
  function goToSetSecret() {
    Twoplay.hideBanner();
    $("secret-length").textContent = state.digitLength;
    $("secret-status").classList.add("hidden");
    $("secret-error").classList.add("hidden");
    $("btn-set-secret").disabled = false;
    state.secretBoxes = buildDigitBoxes($("secret-boxes"), state.digitLength, submitSecret);
    showScreen("secret");
  }

  function startGame(firstTurn) {
    state.gameOver = false;
    $("history").innerHTML = "";
    renderHistoryEmpty($("history"));
    state.guessBoxes = buildDigitBoxes($("guess-boxes"), state.digitLength, submitGuess);
    secretRevealed = false;
    renderMySecret();
    document.querySelector("#screen-game .history-filter").classList.remove("hidden");
    $("btn-give-up").classList.add("hidden");
    setTurn(firstTurn);
    showScreen("game");
  }

  function setTurn(turn) {
    state.turn = turn;
    state.myTurn = turn === state.role;
    const banner = $("turn-banner");
    const card = $("guess-card");
    if (state.myTurn) {
      banner.textContent =
        state.mode === "computer"
          ? "Crack the computer's secret!"
          : "Your turn — make a guess!";
      banner.className = "turn-banner my-turn";
      card.classList.remove("disabled");
      $("btn-guess").disabled = false;
    } else {
      banner.textContent =
        state.mode === "computer" ? "Computer is thinking…" : "Opponent's turn — waiting…";
      banner.className = "turn-banner their-turn";
      card.classList.add("disabled");
      $("btn-guess").disabled = true;
    }
  }

  function showOverScreen(headlineText, headlineClass, detailText, revealedSecret) {
    state.gameOver = true;
    const headline = $("over-headline");
    headline.textContent = headlineText;
    headline.className = headlineClass;
    $("over-detail").textContent = detailText;
    const sec = $("over-secret");
    if (revealedSecret) {
      sec.textContent = `The secret was: ${revealedSecret}`;
      sec.classList.remove("hidden");
    } else {
      sec.classList.add("hidden");
    }
    $("history-over").innerHTML = $("history").innerHTML;
    $("btn-play-again").disabled = false;
    $("play-again-status").classList.add("hidden");
    $("replay-length").value = String(state.digitLength);
    showScreen("over");
  }

  function endGame(winner, winningGuess, revealedSecret) {
    const won = winner === state.role;
    showOverScreen(
      won ? "🎉 You Win!" : "You Lose",
      won ? "win" : "lose",
      won
        ? `You cracked the secret: ${winningGuess}`
        : `${state.opponentLabel} guessed your secret: ${winningGuess}`,
      won ? null : revealedSecret || null
    );
  }

  function giveUpVsComputer() {
    if (state.mode !== "computer" || state.gameOver) return;
    showOverScreen("Secret revealed", "lose", "You gave up this round.", state.cpuSecret);
  }

  function resetForReplay() {
    Twoplay.hideBanner();
    state.gameOver = false;
    $("history").innerHTML = "";
    $("history-over").innerHTML = "";
    goToSetSecret();
  }

  // Return to this game's create/join screen (stays within Cows & Bulls).
  function resetToGameHome() {
    net.clearSession();
    net.leave();
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
    Twoplay.hideBanner();
    $("history").innerHTML = "";
    $("history-over").innerHTML = "";
    $("join-code").value = "";
    showScreen("home");
  }

  // "New Game" button: leave the current room, stay in Cows & Bulls.
  function newGame() {
    const inProgress = !screens.game.classList.contains("hidden") && !state.gameOver;
    if (inProgress && !confirm("Leave this game and start a new one?")) return;
    if (state.mode === "friend") net.send({ type: "leave_room" });
    resetToGameHome();
  }

  // Brand link: leave cleanly, then go back to the Twoplay home page.
  function goToArcadeHome(e) {
    if (e) e.preventDefault();
    const inProgress = !screens.game.classList.contains("hidden") && !state.gameOver;
    if (inProgress && !confirm("Leave this game and return to Twoplay home?")) return;
    if (state.mode === "friend") net.send({ type: "leave_room" });
    net.clearSession();
    setTimeout(() => (location.href = "/"), 60);
  }

  function rebuildFromState(s) {
    state.gameOver = s.over;
    const onSecret = !screens.secret.classList.contains("hidden");
    const onGame = !screens.game.classList.contains("hidden");

    if (!s.started && !s.over && !s.opponent_present) {
      $("lobby-roomcode").textContent = state.roomCode;
      $("lobby-status").textContent = "Waiting for an opponent to join…";
      showScreen("lobby");
      return;
    }

    if (!s.started && !s.over) {
      if (!onSecret || !state.secretBoxes) goToSetSecret();
      if (s.you_secret_set) {
        if (state.secretBoxes) state.secretBoxes.clear();
        $("btn-set-secret").disabled = true;
        $("secret-status").classList.remove("hidden");
      }
      if (!s.opponent_connected) {
        Twoplay.banner("Opponent disconnected — waiting for them to return…", "warn");
      }
      return;
    }

    if (!onGame || !state.guessBoxes) {
      state.guessBoxes = buildDigitBoxes($("guess-boxes"), state.digitLength, submitGuess);
    }
    renderHistory(s.history);
    renderMySecret();

    if (s.over) {
      const oppRole = state.role === "A" ? "B" : "A";
      const revealed = s.secrets ? s.secrets[oppRole] : null;
      endGame(s.winner, s.winning_guess, revealed);
    } else {
      setTurn(s.turn);
      showScreen("game");
      if (!s.opponent_connected) {
        Twoplay.banner("Your opponent disconnected — they can rejoin anytime.", "warn");
      }
    }
  }

  // ---- History rendering ------------------------------------------------
  function renderHistory(historyArr) {
    $("history").innerHTML = "";
    if (!historyArr || historyArr.length === 0) {
      renderHistoryEmpty($("history"));
      return;
    }
    historyArr.forEach((h) => addHistoryRow(h.player, h.guess, h.full, h.half));
  }

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

  function renderHistoryEmpty(container) {
    container.innerHTML = '<div class="history-empty">No guesses yet.</div>';
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

    const digits = document.createElement("div");
    digits.className = "history-digits";
    for (let i = 0; i < guess.length; i++) {
      const box = document.createElement("span");
      box.className = "dbox";
      box.textContent = guess[i];
      digits.appendChild(box);
    }
    row.appendChild(digits);

    const score = document.createElement("span");
    score.className = "history-score";
    score.innerHTML = `<strong>${full}</strong> full, <strong>${half}</strong> half`;
    row.appendChild(score);

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
    state.mySecret = value;
    saveSession();
    $("btn-set-secret").disabled = true;
    $("secret-status").classList.remove("hidden");
    net.send({ type: "set_secret", secret: value });
  }

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
      state.guessBoxes.clear();
      const sc = computeScore(state.cpuSecret, value);
      addHistoryRow("A", value, sc.full, sc.half);
      if (sc.full === state.digitLength) endGame("A", value);
      return;
    }
    net.send({ type: "make_guess", guess: value });
  }

  function showError(message) {
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
      Twoplay.banner(message, "error");
    }
  }

  // ---- Wire up ----------------------------------------------------------
  $("btn-create").addEventListener("click", () => {
    state.mode = "friend";
    state.opponentLabel = "Opponent";
    state.digitLength = parseInt($("digit-length").value, 10);
    net.connect();
    net.send({ type: "create_room", game_type: GAME_TYPE, digit_length: state.digitLength });
  });

  $("btn-join").addEventListener("click", () => {
    const code = $("join-code").value.trim().toUpperCase();
    if (!code) {
      Twoplay.banner("Enter a room code to join.", "error");
      return;
    }
    state.mode = "friend";
    state.opponentLabel = "Opponent";
    net.connect();
    net.send({ type: "join_room", game_type: GAME_TYPE, room_code: code });
  });

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
  document.querySelectorAll(".back-btn").forEach((b) => b.addEventListener("click", resetHomeView));
  $("btn-start-cpu").addEventListener("click", () => {
    startComputerGame(parseInt($("cpu-digit-length").value, 10));
  });

  $("join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("btn-join").click();
  });

  $("btn-copy").addEventListener("click", () => Twoplay.copyText(state.roomCode, $("btn-copy")));
  $("btn-suggest-secret").addEventListener("click", () => {
    if (state.secretBoxes) state.secretBoxes.fill(randomSecret(state.digitLength));
    $("secret-error").classList.add("hidden");
  });
  $("btn-set-secret").addEventListener("click", submitSecret);
  $("btn-guess").addEventListener("click", submitGuess);
  $("btn-newgame").addEventListener("click", newGame);
  $("brand-home").addEventListener("click", goToArcadeHome);
  $("btn-toggle-secret").addEventListener("click", () => {
    secretRevealed = !secretRevealed;
    renderMySecret();
  });
  $("btn-give-up").addEventListener("click", () => {
    if (confirm("Give up and reveal the secret?")) giveUpVsComputer();
  });

  $("btn-play-again").addEventListener("click", () => {
    const dl = parseInt($("replay-length").value, 10) || state.digitLength;
    if (state.mode === "computer") {
      $("history").innerHTML = "";
      $("history-over").innerHTML = "";
      startComputerGame(dl);
      return;
    }
    $("btn-play-again").disabled = true;
    $("play-again-status").classList.remove("hidden");
    net.send({ type: "play_again", digit_length: dl });
  });

  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".history-filter button");
    if (btn) applyHistoryFilter(btn.dataset.filter);
  });
  applyHistoryFilter("both");

  // ---- Startup ----------------------------------------------------------
  const params = new URLSearchParams(location.search);
  const preRoom = params.get("room");
  if (preRoom) {
    net.clearSession();
    $("join-code").value = preRoom.toUpperCase();
    state.mode = "friend";
    $("mode-select").classList.add("hidden");
    $("mode-friend").classList.remove("hidden");
    showScreen("home");
  } else if (net.loadSession()) {
    Twoplay.banner("Reconnecting to your game…", "warn");
    net.doReconnect();
  } else {
    showScreen("home");
  }
})();
