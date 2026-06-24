// Cows & Bulls — frontend WebSocket client and UI controller.
(function () {
  "use strict";

  // ---- Game state -------------------------------------------------------
  const state = {
    ws: null,
    roomCode: null,
    role: null,        // "A" or "B"
    digitLength: 4,
    myTurn: false,
    gameOver: false,
  };

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

  // ---- WebSocket --------------------------------------------------------
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    state.ws = ws;
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
      if (!state.gameOver) {
        showBanner("Connection lost. Refresh to start over.", "error");
      }
    });
    return ws;
  }

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
        state.role = "A";
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
        state.digitLength = msg.digit_length;
        goToSetSecret();
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
        resetForReplay();
        break;

      case "opponent_disconnected":
        showBanner("Your opponent disconnected.", "warn");
        $("guess-card").classList.add("disabled");
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
    setTurn(firstTurn);
    showScreen("game");
  }

  function setTurn(turn) {
    state.myTurn = turn === state.role;
    const banner = $("turn-banner");
    const card = $("guess-card");
    if (state.myTurn) {
      banner.textContent = "Your turn — make a guess!";
      banner.className = "turn-banner my-turn";
      card.classList.remove("disabled");
      $("btn-guess").disabled = false;
      if (state.guessBoxes) state.guessBoxes.clear();
    } else {
      banner.textContent = "Opponent's turn — waiting…";
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
      : `Your opponent guessed your secret: ${winningGuess}`;
    // Copy the live history into the game-over screen.
    $("history-over").innerHTML = $("history").innerHTML;
    $("btn-play-again").disabled = false;
    $("play-again-status").classList.add("hidden");
    showScreen("over");
  }

  function resetForReplay() {
    hideBanner();
    state.gameOver = false;
    $("history").innerHTML = "";
    $("history-over").innerHTML = "";
    goToSetSecret();
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

    const row = document.createElement("div");
    row.className = "history-row";

    const who = document.createElement("span");
    const isYou = player === state.role;
    who.className = "history-who" + (isYou ? " you" : "");
    who.textContent = isYou ? "You" : "Opponent";
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
    $("btn-set-secret").disabled = true;
    $("secret-status").classList.remove("hidden");
    sendWhenReady({ type: "set_secret", secret: value });
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
    connect();
    sendWhenReady({ type: "join_room", room_code: code });
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

  $("btn-play-again").addEventListener("click", () => {
    $("btn-play-again").disabled = true;
    $("play-again-status").classList.remove("hidden");
    sendWhenReady({ type: "play_again" });
  });

  // ---- Deep-link support: ?room=CODE prefills join ----------------------
  const params = new URLSearchParams(location.search);
  const preRoom = params.get("room");
  if (preRoom) {
    $("join-code").value = preRoom.toUpperCase();
  }
})();
